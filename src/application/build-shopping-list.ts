import type { Database } from "bun:sqlite";
import { z } from "zod";
import { readPantry } from "../commands/pantry";
import { readFamilyConfiguration } from "../commands/family";
import { aggregateShoppingIngredients, calculatePackageReuse, type ShoppingIngredient } from "../domain/shopping-list";
import { createPlanRepository } from "../infrastructure/plan-repository";
import { createRecipeRepository } from "../infrastructure/recipe-repository";
import { createPrepLinkRepository } from "../infrastructure/prep-link-repository";
import type { VerifiedPrepLink } from "../domain/planner";
import { localDateInDenmark, resolvePlanWeekStart } from "./create-plan";
import { fetchShoppingDealMatches, type ShoppingDealMatch, type ShoppingDealMatches, type ShoppingDealsOptions } from "./shopping-deals";

const normalizeStoreName = (value: string) => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");

export type BuildShoppingListOptions = {
  readonly week?: string;
  readonly generatedAt?: string;
  readonly noDeals?: boolean;
};
export type ShoppingListItem = ShoppingIngredient & {
  readonly pricing: "matched-offer" | "needs-confirmation" | "unpriced" | "covered";
  readonly estimatedCost: number | null;
  readonly match: ShoppingDealMatch | null;
  readonly package: ReturnType<typeof calculatePackageReuse> | null;
};
export type ShoppingPrepTransfer = {
  readonly linkId: string; readonly kind: "prep" | "leftover"; readonly normalizedIngredient: string;
  readonly quantity: number; readonly unit: string; readonly note: string;
  readonly producerMealId: string; readonly producerDate: string;
  readonly targetMealId: string; readonly targetDate: string;
  readonly targetRecipeTitle: string; readonly targetSourceUrl: string;
  readonly direction: "incoming" | "outgoing";
};
export type ShoppingList = {
  readonly planId: string;
  readonly weekStart: string;
  readonly shoppingDate: string;
  readonly generatedAt: string;
  readonly meals: readonly { id: string; day: string; date: string; recipeId: string; title: string; sourceUrl: string; servings: number }[];
  readonly items: readonly ShoppingListItem[];
  readonly groups: readonly { storeId: string | null; storeName: string; items: readonly ShoppingListItem[] }[];
  readonly totals: { matchedOfferSubtotal: number; currency: "DKK"; pricedItemCount: number; unpricedItemCount: number; isComplete: boolean };
  readonly warnings: readonly string[];
  readonly provider: { text: string; receivedAt: string | null; note: string } | null;
  readonly prepTransfers: readonly ShoppingPrepTransfer[];
};

/** Rebuild from the accepted assignments; list generation never modifies pantry or plans. */
export async function buildShoppingList(database: Database, options: BuildShoppingListOptions,
  context: { fetchDeals?: (options: ShoppingDealsOptions) => Promise<ShoppingDealMatches> } = {}): Promise<ShoppingList> {
  const generatedAt = z.iso.datetime({ offset: true }).parse(options.generatedAt ?? new Date().toISOString());
  const weekStart = resolvePlanWeekStart(options.week, localDateInDenmark(new Date(generatedAt)));
  const capture = database.transaction(() => {
    const row = database.query<{ id: string }, [string]>("SELECT id FROM weekly_plans WHERE week_start = ? AND status = 'accepted' ORDER BY planned_at DESC, id LIMIT 1").get(weekStart);
    if (row === null) throw new Error(`No accepted plan for ${weekStart}; accept a plan before generating groceries`);
    const plan = createPlanRepository(database).get(row.id)!;
    const repository = createRecipeRepository(database);
    const recipes = [...new Set(plan.meals.map(meal => meal.recipeId))].map(id => {
      const recipe = repository.get(id);
      if (recipe === null) throw new Error(`Saved recipe no longer exists: ${id}`);
      return recipe;
    });
    const prepRepository = createPrepLinkRepository(database);
    const verifiedBySunday = new Map<string, VerifiedPrepLink[]>();
    const verified = (date: string) => {
      if (!verifiedBySunday.has(date)) verifiedBySunday.set(date, prepRepository.listVerifiedForSunday(date));
      return verifiedBySunday.get(date)!;
    };
    const producingLinks: VerifiedPrepLink[] = [];
    const incomingLinks: { link: VerifiedPrepLink; producerMealId: string; producerDate: string }[] = [];
    const prepWarnings: string[] = [];
    const prepTransfers: ShoppingPrepTransfer[] = [];
    const transfer = (link: VerifiedPrepLink, producerMealId: string, producerDate: string, direction: ShoppingPrepTransfer["direction"]) => {
      const target = database.query<{ recipeId: string }, [string]>("SELECT recipe_id AS recipeId FROM plan_meals WHERE id = ?").get(link.targetMealId);
      const recipe = target === null ? null : repository.get(target.recipeId);
      if (recipe === null) throw new Error(`Prep target recipe no longer exists: ${link.targetMealId}`);
      prepTransfers.push({ linkId: link.id, kind: link.kind, normalizedIngredient: link.normalizedIngredient, quantity: link.quantity,
        unit: link.unit, note: link.note, producerMealId, producerDate, targetMealId: link.targetMealId, targetDate: link.targetDate,
        targetRecipeTitle: recipe.title, targetSourceUrl: recipe.sourceUrl, direction });
    };
    for (const meal of plan.meals) for (const id of meal.prepLinks) {
      const link = verified(meal.date).find(link => link.id === id && link.sourceRecipeId === meal.recipeId);
      if (meal.day !== "sun" || link === undefined) throw new Error(`Saved prep reservation ${id} is no longer valid; revalidate the linked plan before shopping`);
      producingLinks.push(link);
      transfer(link, meal.id, meal.date, "outgoing");
    }
    const mealIds = plan.meals.map(meal => meal.id);
    const incoming = database.query<{ id: string }, string[]>(`SELECT id FROM recipe_prep_links WHERE target_meal_id IN (${mealIds.map(() => "?").join(", ")}) ORDER BY id`).all(...mealIds);
    for (const { id } of incoming) {
      const producers = database.query<{ id: string; date: string; day: string; recipeId: string; status: string }, [string]>(`
        SELECT m.id, m.date, m.day, m.recipe_id AS recipeId, p.status
        FROM plan_meals m JOIN weekly_plans p ON p.id = m.plan_id, json_each(m.prep_links) j
        WHERE j.value = ? ORDER BY m.id`).all(id);
      const producer = producers.length === 1 ? producers[0]! : null;
      const link = producer?.day === "sun" && producer.status === "accepted"
        ? verified(producer.date).find(link => link.id === id && link.sourceRecipeId === producer.recipeId) : undefined;
      if (producer === null || link === undefined) {
        prepWarnings.push(`${id}: no unique verified accepted Sunday producer; target demand is not reduced`);
        continue;
      }
      incomingLinks.push({ link, producerMealId: producer.id, producerDate: producer.date });
      transfer(link, producer.id, producer.date, "incoming");
      prepWarnings.push(`${link.normalizedIngredient}: ${link.quantity} ${link.unit} deducted from planned ${link.kind} on ${producer.date}; verify it was actually prepared and safely stored`);
    }
    prepTransfers.sort((left, right) => left.linkId.localeCompare(right.linkId));
    return { plan, recipes, pantry: readPantry(database), family: readFamilyConfiguration(database), producingLinks, incomingLinks, prepWarnings, prepTransfers };
  });
  const snapshot = capture();
  const aggregated = aggregateShoppingIngredients(snapshot);
  const warnings = [...aggregated.warnings, ...snapshot.prepWarnings];
  let deals: ShoppingDealMatches = { matches: [], warnings: [], providerText: null, receivedAt: null };
  if (options.noDeals) warnings.push("Offline (--no-deals): complete ingredient list; prices unavailable");
  else {
    try {
      deals = await (context.fetchDeals ?? fetchShoppingDealMatches)({ plan: snapshot.plan, recipes: snapshot.recipes,
        items: aggregated.items, pantry: snapshot.pantry, householdServings: snapshot.family.members.reduce((sum, member) => sum + member.servings, 0),
        preferredStores: snapshot.family.preferredStores });
    } catch (error) {
      warnings.push(`Shopping continues offline: ${error instanceof Error ? error.message.slice(0, 500) : "provider unavailable"}; complete ingredient list retained`);
    }
  }
  if (JSON.stringify(capture()) !== JSON.stringify(snapshot)) throw new Error("Stale shopping inputs: accepted plan, recipe, pantry, household or prep evidence changed; rerun shopping-list");
  warnings.push(...deals.warnings);
  const items: ShoppingListItem[] = aggregated.items.map(item => {
    const candidates = deals.matches.filter(match => match.itemKey === item.key);
    const match = candidates.length === 1 && snapshot.family.preferredStores.some(store => store.id === candidates[0]!.deal.storeId && normalizeStoreName(store.name) === normalizeStoreName(candidates[0]!.deal.store))
      ? candidates[0]! : null;
    if (item.purchaseQuantity === 0) return { ...item, pricing: "covered", estimatedCost: null, match: null, package: null };
    if (match === null) return { ...item, pricing: "unpriced", estimatedCost: null, match: null, package: null };
    const automatic = match.automatic && match.deal.confidence === "high";
    const packages = automatic && match.packageQuantity !== null && item.purchaseQuantity !== null ? calculatePackageReuse(item, match.packageQuantity) : null;
    const rawCost = packages !== null && match.deal.price !== null && match.deal.currency === "DKK" ? packages.packageCount * match.deal.price : null;
    const cost = rawCost !== null && Number.isFinite(rawCost) && rawCost >= 0 && rawCost <= Number.MAX_SAFE_INTEGER / 100 ? Math.round(rawCost * 100) / 100 : null;
    if (!automatic) warnings.push(`${item.normalizedIngredient}: ${match.deal.confidence}-confidence match requires confirmation; excluded from automatic prices`);
    if (packages !== null && packages.remainder > 0) warnings.push(`${item.normalizedIngredient}: ${packages.remainder} ${item.unit} estimated package remainder; storage life is unverified`);
    return { ...item, pricing: automatic ? "matched-offer" : "needs-confirmation", estimatedCost: cost, match, package: packages };
  });
  const groups = [
    ...snapshot.family.preferredStores.map(store => ({ storeId: store.id, storeName: store.name,
      items: items.filter(item => item.match?.deal.storeId === store.id) })),
    { storeId: null, storeName: "Regular-price / unmatched", items: items.filter(item => item.pricing === "unpriced") },
    { storeId: null, storeName: "Pantry / planned preparation", items: items.filter(item => item.pricing === "covered") },
  ].filter(group => group.items.length > 0);
  const recipeById = new Map(snapshot.recipes.map(recipe => [recipe.id, recipe]));
  warnings.push("Matched-offer subtotal is not a checkout total; regular prices, stock and storage life are unverified");
  if (localDateInDenmark(new Date(generatedAt)) > snapshot.plan.shoppingDate) warnings.push(`The shopping date ${snapshot.plan.shoppingDate} has passed; check stock and offer validity before shopping`);
  return {
    planId: snapshot.plan.id, weekStart, shoppingDate: snapshot.plan.shoppingDate, generatedAt,
    meals: snapshot.plan.meals.map(meal => ({ id: meal.id, day: meal.day, date: meal.date, recipeId: meal.recipeId,
      title: recipeById.get(meal.recipeId)!.title, sourceUrl: recipeById.get(meal.recipeId)!.sourceUrl, servings: meal.servings })),
    items, groups,
    prepTransfers: snapshot.prepTransfers,
    totals: { matchedOfferSubtotal: Math.round(items.reduce((sum, item) => sum + (item.estimatedCost ?? 0), 0) * 100) / 100, currency: "DKK",
      pricedItemCount: items.filter(item => item.estimatedCost !== null).length,
      unpricedItemCount: items.filter(item => item.estimatedCost === null && item.pricing !== "covered").length,
      isComplete: items.every(item => item.pricing === "covered" || item.estimatedCost !== null) },
    warnings: [...new Set(warnings)].sort(),
    provider: deals.providerText === null ? null : { text: deals.providerText, receivedAt: deals.receivedAt,
      note: "Unfiltered TilbudsTrolden diagnostic text, not shopping recommendations; use the validated grouped items" },
  };
}
