import { createPlanningDealsClient } from "../adapters/deals/planning-client";
import { z } from "zod";
import {
  GenerateShoppingListResponseSchema,
  type CompatibilityResult,
  type GenerateShoppingListOptions,
  type StoreDirectoryEntry,
} from "../adapters/deals/tilbudstrolden-client";
import type { DealSignal, PackageEstimate, PlannerPantryItem, PlannerRecipe } from "../domain/planner";

export type PlanningRecipePayload = {
  name: string; servings: number; complexity: "quick" | "medium" | "slow";
  cuisineType: string; proteinType: string;
  ingredients: Array<{ name: string; quantity: string; searchTerms: string[] }>;
};
export interface PlanningDealsClient {
  checkCompatibility(): Promise<CompatibilityResult>;
  listStores(options: { all: boolean }): Promise<StoreDirectoryEntry[]>;
  updateHousehold(options: { country: string; people: []; stores: Array<StoreDirectoryEntry & { priority: number }>; defaultServings: number }): Promise<void>;
  updatePantry(options: { add: string[]; remove: string[] }): Promise<void>;
  addRecipe(options: PlanningRecipePayload): Promise<void>;
  generateShoppingList(options: GenerateShoppingListOptions): Promise<unknown>;
  close(): Promise<void>;
}
export type PlanningDealsOptions = {
  recipes: readonly PlannerRecipe[];
  preferredStores: readonly { id: string; name: string }[];
  pantry: readonly PlannerPantryItem[];
  shoppingDate: string;
  client?: PlanningDealsClient;
  clientFactory?: () => PlanningDealsClient | Promise<PlanningDealsClient>;
  /** Total provider budget, including startup and metadata synchronization. */
  timeoutMs?: number;
  closeTimeoutMs?: number;
};
export type PlanningDealInputs = {
  dealSignals: DealSignal[];
  packageEstimates: PackageEstimate[];
  warnings: string[];
};
const normalize = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");

// Defensive limits apply to injected clients as well as the real MCP boundary.
function validateBoundedData(value: unknown, depth = 0, budget = { remaining: 50_000 }): void {
  if (depth > 20 || --budget.remaining < 0) throw new Error("invalid oversized provider response");
  if (typeof value === "number" && (!Number.isFinite(value) || value < 0 || value > 10_000_000)) throw new Error("invalid out-of-range provider number");
  if (typeof value === "string" && value.length > 100_000) throw new Error("invalid oversized provider string");
  if (Array.isArray(value) && value.length > 2_000) throw new Error("invalid oversized provider collection");
  if (value && typeof value === "object") for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) throw new Error("invalid unsafe provider key");
    validateBoundedData(child, depth + 1, budget);
  }
}
const dateSchema = z.iso.date();
function offerDate(value: string | null): string | null {
  if (!value) return null;
  if (dateSchema.safeParse(value).success) return value;
  // Tjek emits valid compact timezone offsets (+0000); accept that explicit format,
  // as well as standard ISO offsets, without changing the source evidence.
  const timestamp = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!z.iso.datetime({ offset: true }).safeParse(timestamp).success) throw new Error("invalid offer date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const get = (part: string) => parts.find(entry => entry.type === part)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

const measuredUnits: Record<string, { dimension: string; scale: number }> = {
  g: { dimension: "mass", scale: 1 }, kg: { dimension: "mass", scale: 1000 },
  ml: { dimension: "volume", scale: 1 }, cl: { dimension: "volume", scale: 10 },
  dl: { dimension: "volume", scale: 100 }, l: { dimension: "volume", scale: 1000 },
  stk: { dimension: "count", scale: 1 }, pcs: { dimension: "count", scale: 1 },
};
function convertPackage(amount: number, from: string, to: string): number | null {
  if (normalize(from) === normalize(to)) return amount;
  const source = measuredUnits[normalize(from)];
  const target = measuredUnits[normalize(to)];
  return source && target && source.dimension === target.dimension ? amount * source.scale / target.scale : null;
}

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

/** Owns and closes the supplied client. Deal value is matched ingredient coverage, not savings. */
export async function fetchPlanningDealInputs(options: PlanningDealsOptions): Promise<PlanningDealInputs> {
  const text = z.string().trim().min(1).max(2_000);
  z.object({ shoppingDate: dateSchema, timeoutMs: z.number().int().positive().max(120_000).optional(),
    closeTimeoutMs: z.number().int().positive().max(10_000).optional(),
    recipes: z.array(z.object({ id: text, title: text, servings: z.number().positive().max(500).nullable(),
      ingredients: z.array(z.object({ rawText: text, normalizedName: text.nullable(), quantity: z.number().positive().max(10_000_000).nullable(), unit: text.nullable(), uncertain: z.boolean() })).min(1).max(200) })).max(500),
    preferredStores: z.array(z.object({ id: text, name: text })).max(100),
    pantry: z.array(z.object({ normalizedName: text, quantity: text })).max(2_000),
  }).parse(options);
  if (new Set(options.recipes.map(recipe => recipe.id)).size !== options.recipes.length
    || new Set(options.preferredStores.map(store => store.id)).size !== options.preferredStores.length) throw new Error("Duplicate planning recipe or store IDs");
  let client = options.client;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const run = <T>(call: () => Promise<T>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Planning deals timeout");
    return bounded(Promise.resolve().then(call), remaining, "Planning deals");
  };
  const read = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await run(call); }
    catch (error) {
      if (Date.now() >= deadline || (error instanceof Error && /invalid|validation|incompatible|closed/i.test(error.message))) throw error;
      return await run(call); // One retry, reads only, within the same total deadline.
    }
  };
  const result: PlanningDealInputs = { dealSignals: [], packageEstimates: [], warnings: [] };
  const packages = new Map<string, PackageEstimate | null>();
  const close = async (target: PlanningDealsClient) => {
    try { await bounded(Promise.resolve().then(() => target.close()), options.closeTimeoutMs ?? 2_000, "Provider close"); }
    catch (error) { result.warnings.push(`Provider close failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`); }
  };
  let factoryAbandoned = false;
  try {
    const factory = options.clientFactory ?? createPlanningDealsClient;
    if (!client) {
      const pending = Promise.resolve().then(() => factory()).then(async created => {
        if (factoryAbandoned) await close(created);
        return created;
      });
      try { client = await run(() => pending); }
      catch (error) { factoryAbandoned = true; throw error; }
    }
    if (!client) throw new Error("A planning deals client is required");
    const active = client;
    const compatibility = await read(() => active.checkCompatibility());
    if (!compatibility.compatible || !compatibility.serverCompatible
      || compatibility.server?.name !== "tilbudstrolden" || compatibility.server.version !== "0.5.3"
      || compatibility.missingRequiredTools.length > 0 || compatibility.incompatibleToolSchemas.length > 0
      || compatibility.missingRequiredToolOutputSchemas.length > 0 || compatibility.incompatibleToolOutputSchemas.length > 0) {
      throw new Error("Incompatible TilbudsTrolden identity or tool schemas (expected tilbudstrolden 0.5.3)");
    }
    const directory = z.array(z.object({ name: z.string().min(1).max(200), dealerId: z.string().min(1).max(200) })).max(2_000).parse(await read(() => active.listStores({ all: true })));
    const stores = options.preferredStores.flatMap(preferred => {
      // Stored dealsEnabled/dealerId describe earlier resolution, not chain opt-out.
      // Always refresh identities; --no-deals is handled by the caller.
      const matches = directory.filter(store => normalize(store.name) === normalize(preferred.name));
      if (matches.length !== 1) {
        result.warnings.push(`${preferred.name}: live store resolution unavailable or ambiguous; no substitute chain used`);
        return [];
      }
      return [{ ...matches[0]!, localId: preferred.id }];
    });
    if (stores.length === 0) { result.warnings.push("Planning continues without deals: no configured chains resolved; default-chain matching disabled"); return result; }
    await run(() => active.updateHousehold({ country: "DK", people: [], defaultServings: 4,
      stores: stores.map((store, index) => ({ name: store.name, dealerId: store.dealerId, priority: index + 1 })) }));
    await run(() => active.updatePantry({ add: options.pantry.map(item => item.normalizedName), remove: [] }));
    for (const recipe of options.recipes) {
      if (recipe.needsReview || recipe.preference === "disliked" || recipe.servings === null) {
        result.warnings.push(`${recipe.title}: not planning-ready; deal lookup skipped`); continue;
      }
      const name = `mealplan:${recipe.id}`;
      await run(() => active.addRecipe({ name, servings: recipe.servings!,
        complexity: recipe.totalMinutes !== null && recipe.totalMinutes <= 30 ? "quick" : recipe.totalMinutes !== null && recipe.totalMinutes > 60 ? "slow" : "medium",
        cuisineType: recipe.cuisineTags[0] ?? "other", proteinType: recipe.proteinTag ?? "other",
        ingredients: recipe.ingredients.map(ingredient => ({ name: ingredient.normalizedName ?? ingredient.rawText,
          quantity: ingredient.quantity !== null && ingredient.unit !== null ? `${ingredient.quantity} ${ingredient.unit}` : ingredient.rawText,
          searchTerms: [ingredient.normalizedName ?? ingredient.rawText] })) }));
      const raw = await read(() => active.generateShoppingList({ recipes: [name], people: recipe.servings!, excludePantry: false }));
      validateBoundedData(raw);
      const parsed = GenerateShoppingListResponseSchema.safeParse(raw);
      if (!parsed.success) throw new Error("invalid structured shopping response");
      const response = parsed.data;
      if (response.status === "no_matching_recipes") { result.warnings.push(`${recipe.title}: no matching provider recipe; no deal inputs`); continue; }
      if (response.currency !== "DKK" || response.householdSize !== recipe.servings
        || response.requestedRecipes.length !== 1 || response.requestedRecipes[0] !== name
        || response.matchedRecipes.length !== 1 || response.matchedRecipes[0] !== name) throw new Error("invalid recipe identity or currency in provider response");
      const seen = new Set<string>();
      for (const item of response.items) {
        const key = normalize(item.name);
        if (seen.has(key) || !recipe.ingredients.some(ingredient => normalize(ingredient.normalizedName ?? ingredient.rawText) === key)
          || item.sourceRecipes.length !== 1 || item.sourceRecipes[0] !== name
          || item.contributions.some(contribution => contribution.recipeName !== name)) throw new Error("invalid ingredient association or duplicate item");
        seen.add(key);
        if (item.deal && item.deal.currency !== "DKK") throw new Error("invalid offer currency");
        if (item.deal) { offerDate(item.deal.validFrom); offerDate(item.deal.validUntil); }
      }
      for (const item of response.items) {
        const warn = (reason: string) => result.warnings.push(`${recipe.title}: ${item.name}: ${reason}; excluded from automatic planning`);
        if (!item.deal) { warn("no matched deal"); continue; }
        if (item.confidence !== "high") { warn(`${item.confidence}-confidence deal`); continue; }
        const store = stores.find(store => store.dealerId === item.deal!.storeId && normalize(store.name) === normalize(item.deal!.store));
        if (!store) { warn("unpreferred store"); continue; }
        const validUntil = offerDate(item.deal.validUntil);
        const validFrom = offerDate(item.deal.validFrom);
        if (!validUntil || !validFrom) { warn("missing-date offer validity"); continue; }
        if (validUntil < options.shoppingDate) { warn("expired before shopping date"); continue; }
        if (validFrom > options.shoppingDate) { warn("future offer after shopping date"); continue; }
        result.dealSignals.push({ recipeId: recipe.id, storeId: store.localId, value: 1 / recipe.ingredients.length, validUntil, confidence: "high" });
        const ingredient = recipe.ingredients.find(ingredient => normalize(ingredient.normalizedName ?? ingredient.rawText) === normalize(item.name))!;
        const packSize = item.purchase?.packSize ?? item.deal.quantity;
        const packUnit = item.purchase?.unitNeeded ?? item.deal.unit;
        if (ingredient.uncertain || !ingredient.normalizedName || !ingredient.unit || !packSize || !packUnit) {
          result.warnings.push(`${recipe.title}: ${item.name}: package quantity is uncertain; waste estimate omitted`); continue;
        }
        const packageQuantity = convertPackage(packSize, packUnit, ingredient.unit);
        if (packageQuantity === null || packageQuantity <= 0 || packageQuantity > 10_000_000) {
          result.warnings.push(`${recipe.title}: ${item.name}: package units incompatible; waste estimate omitted`); continue;
        }
        const category = normalize(item.category);
        const perishability = ["produce", "fruit", "vegetables"].includes(category) ? "perishable"
          : ["meat", "fish", "dairy"].includes(category) ? "short-lived"
          : ["pantry", "dry", "canned", "spices", "frozen"].includes(category) ? "shelf-stable" : "short-lived";
        if (!["produce", "fruit", "vegetables", "meat", "fish", "dairy", "pantry", "dry", "canned", "spices", "frozen"].includes(category)) {
          result.warnings.push(`${item.name}: perishability unknown; conservative short-lived assumption for waste scoring`);
        }
        const estimate: PackageEstimate = { normalizedIngredient: normalize(ingredient.normalizedName), unit: normalize(ingredient.unit), packageQuantity, perishability };
        const key = `${estimate.normalizedIngredient}\0${estimate.unit}`;
        const prior = packages.get(key);
        if (prior === undefined) packages.set(key, estimate);
        else if (prior !== null && (prior.packageQuantity !== packageQuantity || prior.perishability !== perishability)) {
          packages.set(key, null);
          result.warnings.push(`${item.name}: conflicting live package estimates; waste estimate omitted`);
        }
      }
    }
    result.packageEstimates = [...packages.values()].filter((estimate): estimate is PackageEstimate => estimate !== null);
    result.warnings.push("Deal value is high-confidence ingredient coverage, not monetary savings; matched prices are not a full checkout total");
    return result;
  } catch (error) {
    result.dealSignals = [];
    result.packageEstimates = [];
    result.warnings.push(`Planning continues without deals: ${error instanceof Error ? error.message.slice(0, 500) : "provider unavailable"}`);
    return result;
  } finally {
    if (client) await close(client);
  }
}
