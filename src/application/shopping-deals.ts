import { z } from "zod";
import { createPlanningDealsClient } from "../adapters/deals/planning-client";
import { GenerateShoppingListResponseSchema } from "../adapters/deals/tilbudstrolden-client";
import type { PlanningDealsClient, PlanningRecipePayload } from "./planning-deals";
import type { PlannerPantryItem } from "../domain/planner";
import type { ShoppingIngredient } from "../domain/shopping-list";
import type { WeeklyPlan } from "../infrastructure/plan-repository";
import type { Recipe } from "../infrastructure/recipe-repository";

export type ShoppingDealMatch = {
  itemKey: string;
  deal: { offerId: string; heading: string; storeId: string; store: string; price: number | null; currency: string;
    quantity: number | null; unit: string | null; pricePerUnit: string | null; validFrom: string; validUntil: string;
    confidence: "high" | "medium" | "low"; retrievedAt: string };
  packageQuantity: number | null;
  automatic: boolean;
};
export type ShoppingDealsOptions = {
  plan: WeeklyPlan; recipes: readonly Recipe[]; items: readonly ShoppingIngredient[]; householdServings: number;
  preferredStores: readonly { id: string; name: string }[]; pantry: readonly PlannerPantryItem[];
  client?: PlanningDealsClient; clientFactory?: () => PlanningDealsClient | Promise<PlanningDealsClient>;
  timeoutMs?: number; closeTimeoutMs?: number;
};
export type ShoppingDealMatches = { matches: ShoppingDealMatch[]; warnings: string[]; providerText: string | null; receivedAt: string | null };
const normalize = (text: string) => text.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");

const units: Record<string, { dimension: string; scale: number }> = {
  g: { dimension: "mass", scale: 1 }, kg: { dimension: "mass", scale: 1000 },
  ml: { dimension: "volume", scale: 1 }, cl: { dimension: "volume", scale: 10 }, dl: { dimension: "volume", scale: 100 }, l: { dimension: "volume", scale: 1000 },
  stk: { dimension: "count", scale: 1 }, pcs: { dimension: "count", scale: 1 },
};
function packageQuantity(amount: number | null, from: string | null, to: string): number | null {
  if (!amount || !from) return null;
  const source = units[normalize(from)], target = units[normalize(to)];
  if (!source || !target || source.dimension !== target.dimension) return null;
  const converted = amount * source.scale / target.scale;
  if (!Number.isFinite(converted) || converted <= 0 || converted > 10_000_000) throw new Error("invalid converted package bounds");
  return converted;
}
function offerDate(value: string | null): string | null {
  if (!value) return null;
  if (z.iso.date().safeParse(value).success) return value;
  const timestamp = value.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  if (!z.iso.datetime({ offset: true }).safeParse(timestamp).success) throw new Error("invalid offer date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Europe/Copenhagen", year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date(timestamp));
  const get = (type: string) => parts.find(part => part.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function sameNames(actual: readonly string[], expected: readonly string[]): boolean {
  return actual.length === expected.length && new Set(actual).size === actual.length && actual.every(name => expected.includes(name));
}
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

async function bounded<T>(operation: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timeout`)), Math.max(1, timeoutMs));
    })]);
  } finally { clearTimeout(timer); }
}

function validateOptions(options: ShoppingDealsOptions): void {
  const text = z.string().min(1).max(2_000).refine(value => value.trim().length > 0);
  const amount = z.number().finite().nonnegative().max(10_000_000);
  z.object({
    householdServings: z.number().finite().positive().max(500),
    timeoutMs: z.number().int().positive().max(120_000).optional(), closeTimeoutMs: z.number().int().positive().max(10_000).optional(),
    plan: z.object({ shoppingDate: z.iso.date(), meals: z.array(z.object({ id: text, recipeId: text, day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]), date: z.iso.date(), servings: z.number().finite().positive().max(1_000_000) })).length(7) }),
    recipes: z.array(z.object({ id: text, title: text, totalMinutes: amount.nullable(), cuisineTags: z.array(text).max(50), proteinTag: text.nullable() })).max(500),
    preferredStores: z.array(z.object({ id: text, name: text })).max(100), pantry: z.array(z.object({ normalizedName: text, quantity: text })).max(2_000),
    items: z.array(z.object({ key: text, normalizedIngredient: text.nullable(), unit: text.nullable(), requiredQuantity: amount.nullable(),
      pantryDeduction: amount, preparedDeduction: amount, purchaseQuantity: amount.nullable(), warnings: z.array(text).max(2_000).optional(),
      contributions: z.array(z.object({ mealId: text, recipeId: text, day: text, date: z.iso.date(), rawText: text, quantity: amount.nullable(), unit: text.nullable(), preparedDeduction: amount, kind: z.enum(["recipe", "prep"]) })).min(1).max(2_000),
    })).max(2_000),
  }).parse(options);
  const unique = (values: readonly string[], label: string) => { if (new Set(values).size !== values.length) throw new Error(`Duplicate ${label}`); };
  unique(options.plan.meals.map(meal => meal.id), "meal IDs");
  unique(options.plan.meals.map(meal => meal.day), "meal days");
  unique(options.recipes.map(recipe => recipe.id), "recipe IDs");
  unique(options.preferredStores.map(store => store.id), "store IDs");
  unique(options.preferredStores.map(store => normalize(store.name)), "configured store names");
  unique(options.items.map(item => item.key), "shopping item keys");
  for (const meal of options.plan.meals) if (!options.recipes.some(recipe => recipe.id === meal.recipeId)) throw new Error(`Missing saved recipe ${meal.recipeId}`);
  for (const item of options.items) for (const contribution of item.contributions) {
    const meal = options.plan.meals.find(meal => meal.id === contribution.mealId);
    if (!meal || meal.recipeId !== contribution.recipeId || meal.date !== contribution.date || meal.day !== contribution.day) throw new Error("Invalid shopping contribution identity");
    if (contribution.preparedDeduction > (contribution.quantity ?? 0)) throw new Error("Invalid excess prepared deduction");
  }
}

/** Owns the supplied client; the production default creates a fresh private provider session. */
export async function fetchShoppingDealMatches(options: ShoppingDealsOptions): Promise<ShoppingDealMatches> {
  validateOptions(options);
  const result: ShoppingDealMatches = { matches: [], warnings: [...new Set(options.items.flatMap(item => item.warnings ?? []))], providerText: null, receivedAt: null };
  let client = options.client;
  const deadline = Date.now() + (options.timeoutMs ?? 30_000);
  const run = <T>(call: () => Promise<T>) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Shopping deals timeout");
    return bounded(Promise.resolve().then(call), remaining, "Shopping deals");
  };
  const read = async <T>(call: () => Promise<T>): Promise<T> => {
    try { return await run(call); }
    catch (error) {
      if (Date.now() >= deadline || (error instanceof Error && /invalid|validation|incompatible|closed/i.test(error.message))) throw error;
      return await run(call);
    }
  };
  const close = async (target: PlanningDealsClient) => {
    try { await bounded(Promise.resolve().then(() => target.close()), options.closeTimeoutMs ?? 2_000, "Provider close"); }
    catch (error) {
      result.matches = [];
      result.warnings.push(`Shopping continues without deals (offline): Provider close failed: ${error instanceof Error ? error.message.slice(0, 200) : "unknown error"}`);
    }
  };
  let factoryAbandoned = false;
  try {
    if (!client) {
      const pending = Promise.resolve().then(() => (options.clientFactory ?? createPlanningDealsClient)()).then(async created => {
        if (factoryAbandoned) await close(created);
        return created;
      });
      try { client = await run(() => pending); }
      catch (error) { factoryAbandoned = true; throw error; }
    }
    const active = client;
    const compatibility = await read(() => active.checkCompatibility());
    if (!compatibility.compatible || !compatibility.serverCompatible || compatibility.server?.name !== "tilbudstrolden"
      || compatibility.server.version !== "0.5.3" || compatibility.missingRequiredTools.length
      || compatibility.incompatibleToolSchemas.length || compatibility.missingRequiredToolOutputSchemas.length
      || compatibility.incompatibleToolOutputSchemas.length) throw new Error("Incompatible TilbudsTrolden identity or tool schemas (expected tilbudstrolden 0.5.3)");
    const directory = z.array(z.object({ name: z.string().min(1).max(200), dealerId: z.string().min(1).max(200) })).max(2_000).parse(await read(() => active.listStores({ all: true })));
    const stores = options.preferredStores.flatMap(preferred => {
      const matches = directory.filter(store => normalize(store.name) === normalize(preferred.name));
      if (matches.length !== 1) { result.warnings.push(`${preferred.name}: live resolution unavailable or ambiguous; no substitute chain used`); return []; }
      return [{ ...matches[0]!, localId: preferred.id }];
    });
    if (!stores.length) { result.warnings.push("Shopping continues without deals: no configured stores resolved"); return result; }
    await run(() => active.updateHousehold({ country: "DK", people: [], defaultServings: options.householdServings,
      stores: stores.map((store, index) => ({ name: store.name, dealerId: store.dealerId, priority: index + 1 })) }));
    await run(() => active.updatePantry({ add: options.pantry.map(item => item.normalizedName), remove: [] }));
    const names: string[] = [];
    const associations = new Map<string, Set<string>>();
    for (const meal of options.plan.meals) {
      const recipe = options.recipes.find(recipe => recipe.id === meal.recipeId)!;
      const name = `mealplan:${meal.id}`;
      names.push(name);
      const ingredients: PlanningRecipePayload["ingredients"] = options.items.flatMap(item => {
        const contributions = item.contributions.filter(c => c.mealId === meal.id);
        if (!contributions.length) return [];
        if (item.normalizedIngredient && item.unit && contributions.every(c => c.quantity !== null)) {
          const quantity = contributions.reduce((sum, c) => sum + c.quantity! - c.preparedDeduction, 0);
          return quantity > 0 ? [{ name: item.normalizedIngredient, quantity: `${quantity} ${item.unit}`, searchTerms: [item.normalizedIngredient] }] : [];
        }
        result.warnings.push(`${recipe.title}: uncertain quantity preserved as raw evidence; excluded from automatic estimates`);
        return contributions.map(c => ({ name: c.rawText, quantity: c.rawText, searchTerms: [c.rawText] }));
      });
      for (const ingredient of ingredients) {
        const key = normalize(ingredient.name);
        const sources = associations.get(key) ?? new Set<string>();
        sources.add(name);
        associations.set(key, sources);
      }
      await run(() => active.addRecipe({ name, servings: options.householdServings,
        complexity: recipe.totalMinutes !== null && recipe.totalMinutes <= 30 ? "quick" : recipe.totalMinutes !== null && recipe.totalMinutes > 60 ? "slow" : "medium",
        cuisineType: recipe.cuisineTags[0] ?? "other", proteinType: recipe.proteinTag ?? "other", ingredients }));
    }
    const raw = await read(() => active.generateShoppingList({ recipes: names, people: options.householdServings, excludePantry: false }));
    // Keep bounded raw diagnostics separate even when structured validation fails.
    if (raw && typeof raw === "object" && "providerText" in raw && typeof raw.providerText === "string" && raw.providerText.length <= 100_000) result.providerText = raw.providerText;
    validateBoundedData(raw);
    const parsed = GenerateShoppingListResponseSchema.safeParse(raw);
    if (!parsed.success) throw new Error("invalid structured shopping response");
    const response = parsed.data;
    result.providerText = response.providerText;
    result.receivedAt = response.receivedAt;
    if (response.status !== "ok" || response.currency !== "DKK" || response.householdSize !== options.householdServings
      || !sameNames(response.requestedRecipes, names) || !sameNames(response.matchedRecipes, names)
      || !sameNames(response.availableRecipes, names) || response.skippedPantry.length) throw new Error("invalid recipe identity, household or currency in provider response");
    const seen = new Set<string>();
    for (const item of response.items) {
      const key = normalize(item.name);
      const sources = associations.get(key);
      if (seen.has(key) || !sources || !sameNames(item.sourceRecipes, [...sources])
        || !sameNames(item.contributions.map(c => c.recipeName), [...sources])
        || item.contributions.some(c => c.recipeServings !== options.householdServings)) throw new Error("invalid ingredient association or duplicate item");
      seen.add(key);
      for (const deal of [item.deal, ...item.alternatives.map(alternative => alternative.offer)]) {
        if (!deal) continue;
        if (deal.currency !== "DKK" || !deal.id.trim() || !deal.heading.trim() || !deal.storeId.trim() || !deal.store.trim()) throw new Error("invalid offer currency or identity");
        const from = offerDate(deal.validFrom), until = offerDate(deal.validUntil);
        if (from && until && from > until) throw new Error("invalid reversed offer dates");
      }
    }
    for (const item of response.items) {
      const candidates = options.items.filter(local => local.normalizedIngredient && normalize(local.normalizedIngredient) === normalize(item.name));
      const warn = (reason: string) => result.warnings.push(`${item.name}: ${reason}; local shopping quantities remain authoritative`);
      if (candidates.length > 1) { warn("ambiguous same-name local ingredients; no unit guessed"); continue; }
      const local = candidates[0];
      if (!local?.unit || !units[normalize(local.unit)] || local.requiredQuantity === null || local.purchaseQuantity === null || local.purchaseQuantity <= 0
        || local.contributions.some(c => c.quantity === null)) { warn("uncertain or non-purchased local ingredient; no automatic pricing"); continue; }
      if (!item.deal || item.confidence === "none") { warn("no-deal; regular-price item remains on local list"); continue; }
      const deal = item.deal;
      const store = stores.find(store => store.dealerId === deal.storeId && normalize(store.name) === normalize(deal.store));
      if (!store) { warn("unpreferred store"); continue; }
      const validFrom = offerDate(deal.validFrom), validUntil = offerDate(deal.validUntil);
      if (!validFrom || !validUntil) { warn("undated offer"); continue; }
      if (validUntil < options.plan.shoppingDate) { warn("expired before shopping date"); continue; }
      if (validFrom > options.plan.shoppingDate) { warn("future offer after shopping date"); continue; }
      const pack = packageQuantity(deal.quantity, deal.unit, local.unit);
      if (deal.price === null) warn("price unknown; automatic estimate omitted");
      if (item.confidence !== "high") warn("low-confidence offer excluded from automatic estimates");
      if (pack === null) warn(!deal.quantity || !deal.unit ? "unknown-pack evidence; automatic estimate omitted" : "incompatible-pack units; automatic estimate omitted");
      result.matches.push({ itemKey: local.key, packageQuantity: pack, automatic: item.confidence === "high" && pack !== null && deal.price !== null,
        deal: { offerId: deal.id, heading: deal.heading, storeId: store.localId, store: store.name, price: deal.price,
          currency: deal.currency, quantity: deal.quantity, unit: deal.unit, pricePerUnit: deal.pricePerUnit,
          validFrom, validUntil, confidence: item.confidence === "high" ? "high" : "low", retrievedAt: response.receivedAt } });
    }
    for (const local of options.items) {
      if (local.purchaseQuantity !== null && local.purchaseQuantity > 0 && !result.matches.some(match => match.itemKey === local.key)) {
        result.warnings.push(`${local.normalizedIngredient ?? local.contributions[0]!.rawText}: unmatched; remains on complete regular-price local list`);
      }
    }
    return result;
  } catch (error) {
    result.matches = [];
    result.warnings.push(`Shopping continues without deals (offline): ${error instanceof Error ? error.message.slice(0, 500) : "provider unavailable"}`);
    return result;
  } finally { if (client) await close(client); }
}
