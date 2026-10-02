import { afterEach, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { buildShoppingList } from "../../src/application/build-shopping-list";
import { createPrepLinkRepository } from "../../src/infrastructure/prep-link-repository";
import { DAYS } from "../../src/domain/planner";
import { applyPantryUpserts } from "../../src/commands/pantry";
import { renderShoppingList } from "../../src/presentation/shopping-list-command";
import { shoppingFixture } from "../helpers/shopping-fixture";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
const options = { week: "2026-10-05", generatedAt: "2026-10-02T12:00:00.000Z", noDeals: true };

test("offline groceries scale the accepted seven production meals and deduct measured pantry without writes", async () => {
  const { database, repository, draft } = shoppingFixture();
  databases.push(database);
  const accepted = repository.accept(draft.id, "2026-10-02T11:00:00.000Z");
  const before = database.query("SELECT total_changes() AS count").get();
  const list = await buildShoppingList(database, options);
  expect(list.planId).toBe(accepted.id);
  expect(list.meals).toHaveLength(7);
  const carrots = list.items.find(item => item.normalizedIngredient === "carrots")!;
  expect(carrots.requiredQuantity).toBe(800);
  expect(carrots.pantryDeduction).toBe(200);
  expect(carrots.purchaseQuantity).toBe(600);
  expect(carrots.contributions).toHaveLength(7);
  expect(carrots.contributions[6]!.quantity).toBe(200);
  expect(list.totals.matchedOfferSubtotal).toBe(0);
  expect(list.totals.unpricedItemCount).toBe(1);
  expect(list.totals.isComplete).toBe(false);
  expect(list.warnings.join("\n")).toContain("Offline (--no-deals)");
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
  expect(repository.get(accepted.id)).toEqual(accepted);
});

test("fresh shopping matches estimate only locally needed packs and identify later consumers", async () => {
  const { database, repository, draft } = shoppingFixture();
  databases.push(database);
  repository.accept(draft.id, "2026-10-02T11:00:00.000Z");
  let calls = 0;
  const list = await buildShoppingList(database, { ...options, noDeals: false }, {
    fetchDeals: async input => {
      calls += 1;
      expect(input.householdServings).toBe(4);
      expect(input.plan.meals).toHaveLength(7);
      return { matches: [{ itemKey: input.items[0]!.key, automatic: true, packageQuantity: 500,
        deal: { offerId: "offer-1", heading: "Carrots", storeId: input.preferredStores[0]!.id, store: input.preferredStores[0]!.name.toLocaleLowerCase("da-DK"),
          price: 10, currency: "DKK", quantity: 500, unit: "g", pricePerUnit: "20 DKK/kg", validFrom: "2026-10-01", validUntil: "2026-10-04", confidence: "high", retrievedAt: "2026-10-02T12:00:00.000Z" } }],
        warnings: [], providerText: "Provider diagnostic", receivedAt: "2026-10-02T12:00:00.000Z" };
    },
  });
  expect(calls).toBe(1);
  expect(list.items[0]!.estimatedCost).toBe(20);
  expect(list.items[0]!.package!.packageCount).toBe(2);
  expect(list.items[0]!.package!.remainder).toBe(400);
  expect(list.items[0]!.package!.uses.some(use => use.fromMealId === draft.meals[2]!.id && use.toMealId === draft.meals[3]!.id && use.quantity === 100)).toBe(true);
  expect(list.groups[0]!.storeName).toBe("REMA 1000");
  expect(list.totals.matchedOfferSubtotal).toBe(20);
  expect(list.provider!.text).toBe("Provider diagnostic");
  const rendered = renderShoppingList(list);
  expect(rendered).toContain("2 package(s)");
  expect(rendered).toContain("20 DKK/kg");
  expect(rendered).toContain("2026-10-04");
  expect(rendered).toContain("Reused by thu: Shopping recipe 3");
  expect(rendered).toContain("Retrieved: 2026-10-02T12:00:00.000Z");
  expect(rendered).not.toContain("Provider diagnostic");
});

test("grocery prep production and incoming leftovers use one accepted producing occurrence", async () => {
  const { database, repository, draft, recipes } = shoppingFixture();
  databases.push(database);
  const future = repository.saveDraft({ weekStart: "2026-10-12", shoppingDate: "2026-10-10", plannedAt: draft.plannedAt,
    seed: "future-shopping", score: draft.score,
    meals: DAYS.map((day, index) => ({ day, date: `2026-10-${12 + index}`, recipeId: recipes[index]!.id,
      servings: day === "sun" ? 8 : 4, rationale: ["future"], prepLinks: [] })) });
  const prep = createPrepLinkRepository(database).add({ sourceRecipeId: recipes[6]!.id, targetMealId: future.meals[0]!.id,
    kind: "prep", normalizedIngredient: "carrots", quantity: 50, unit: "g", note: "Chop ahead" });
  const leftover = createPrepLinkRepository(database).add({ sourceRecipeId: recipes[6]!.id, targetMealId: future.meals[0]!.id,
    kind: "leftover", normalizedIngredient: "carrots", quantity: 50, unit: "g", note: "Extra batch" });
  const bound = repository.saveDraft({ weekStart: draft.weekStart, shoppingDate: draft.shoppingDate, plannedAt: draft.plannedAt,
    seed: "bound-shopping", score: draft.score,
    meals: draft.meals.map(meal => ({ day: meal.day, date: meal.date, recipeId: meal.recipeId, servings: meal.servings,
      rationale: [...meal.rationale], prepLinks: meal.day === "sun" ? [prep.id, leftover.id] : [] })) });
  repository.accept(bound.id, "2026-10-02T11:00:00.000Z");
  repository.accept(future.id, "2026-10-02T11:00:00.000Z");
  const sourceList = await buildShoppingList(database, options);
  expect(sourceList.items[0]!.requiredQuantity).toBe(850);
  expect(sourceList.items[0]!.purchaseQuantity).toBe(650);
  expect(sourceList.items[0]!.contributions.filter(item => item.kind === "prep")).toHaveLength(1);
  expect(sourceList.prepTransfers).toHaveLength(2);
  expect(sourceList.prepTransfers[0]!.targetRecipeTitle).toBe("Shopping recipe 0");
  expect(sourceList.prepTransfers[0]!.targetSourceUrl).toBe("https://mummum.dk/shopping-0/");
  expect(sourceList.prepTransfers[0]!.direction).toBe("outgoing");
  expect(renderShoppingList(sourceList)).toContain("Reserved for 2026-10-12: Shopping recipe 0");
  const targetList = await buildShoppingList(database, { ...options, week: future.weekStart });
  expect(targetList.items[0]!.requiredQuantity).toBe(800);
  expect(targetList.items[0]!.preparedDeduction).toBe(100);
  expect(targetList.items[0]!.purchaseQuantity).toBe(500);
  expect(targetList.items[0]!.contributions[0]!.preparedDeduction).toBe(100);
  expect(targetList.prepTransfers).toHaveLength(2);
  expect(targetList.prepTransfers[0]!.direction).toBe("incoming");
});

test("shopping rejects a stale pantry snapshot changed during provider lookup", async () => {
  const { database, repository, draft } = shoppingFixture();
  databases.push(database);
  repository.accept(draft.id, "2026-10-02T11:00:00.000Z");
  await expect(buildShoppingList(database, { ...options, noDeals: false }, {
    fetchDeals: async () => {
      applyPantryUpserts(database, [{ name: "carrots", quantity: "500 g" }]);
      return { matches: [], warnings: [], providerText: null, receivedAt: null };
    },
  })).rejects.toThrow("Stale shopping inputs");
  const refreshed = await buildShoppingList(database, options);
  expect(refreshed.items[0]!.purchaseQuantity).toBe(300);
});
