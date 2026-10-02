import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanDraft, createPlanWithDeals, resolvePlanWeekStart } from "../../src/application/create-plan";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { openDatabase } from "../../src/infrastructure/database";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createPrepLinkRepository } from "../../src/infrastructure/prep-link-repository";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";

const temporaryDirectories: string[] = [];

function input(index: number): RecipeImport {
  return {
    sourceId: "mummum",
    sourceUrl: `https://mummum.dk/test-${index}/`,
    canonicalUrl: `https://mummum.dk/test-${index}/`,
    title: `Family recipe ${index}`,
    author: "Test",
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 15,
    totalMinutes: 25,
    cuisineTags: [index % 2 === 0 ? "danish" : "italian"],
    proteinTag: index % 2 === 0 ? "legume" : "chicken",
    dietaryTags: index === 0 ? ["vegetarian"] : ["low-salt"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook"],
    extraMealServings: 4,
    preference: index === 7 ? "favorite" : "neutral",
    needsReview: false,
    parserVersion: "test@1",
    fetchedAt: "2026-10-01T10:00:00.000Z",
    rawSourcePayload: { index },
    sourceEvidence: { adapter: "test" },
    ingredients: [{ rawText: "100 g carrots", normalizedName: "carrots", quantity: 100, unit: "g", uncertain: false }],
    instructions: ["Cook."],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("create plan", () => {
  test("weekly rejection memory also excludes a rejected recipe when regenerating that week", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-rejected-plan-"));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, "mealplan.sqlite"));
    try {
      applySetup(database, createSetupConfiguration({ members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }] }));
      const recipes = Array.from({ length: 8 }, (_, index) => createRecipeRepository(database).import(input(index)));
      const options = { week: "2026-10-05", seed: "rejections", plannedAt: "2026-10-01T12:00:00.000Z" };
      const first = createPlanDraft(database, options);
      const rejectedId = first.meals.find(({ recipeId }) => recipeId !== recipes[0]!.id)!.recipeId;
      database.query("INSERT INTO weekly_recipe_rejections (week_start, recipe_id, recorded_at) VALUES (?, ?, ?)")
        .run(first.weekStart, rejectedId, options.plannedAt);
      const regenerated = createPlanDraft(database, options);
      expect(regenerated.meals.some(({ recipeId }) => recipeId === rejectedId)).toBe(false);
      const nextWeek = createPlanDraft(database, { ...options, week: "2026-10-12" });
      expect(nextWeek.meals).toHaveLength(7);
    } finally { database.close(); }
  });

  test("offline and explicitly disabled offers still produce a valid local plan", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-offline-plan-"));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, "mealplan.sqlite"));
    try {
      applySetup(database, createSetupConfiguration({ members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }] }));
      Array.from({ length: 7 }, (_, index) => createRecipeRepository(database).import(input(index)));
      let calls = 0;
      const context = { fetchDeals: async () => { calls += 1; throw new Error("offline provider"); } };
      const options = { week: "2026-10-05", seed: "offline", plannedAt: "2026-10-01T12:00:00.000Z" };
      const offline = await createPlanWithDeals(database, options, context);
      expect(offline.meals).toHaveLength(7);
      expect(offline.score.warnings.join("\n")).toContain("without deals: offline provider");
      const disabled = await createPlanWithDeals(database, { ...options, noDeals: true }, context);
      expect(calls).toBe(1);
      expect(disabled.score.warnings.join("\n")).toContain("Deal lookup disabled");
      expect(disabled.meals.map(({ recipeId }) => recipeId)).toEqual(offline.meals.map(({ recipeId }) => recipeId));
    } finally { database.close(); }
  });

  test("loads preferred-store deal and package inputs before saving the scored draft", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-deal-plan-"));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, "mealplan.sqlite"));
    try {
      applySetup(database, createSetupConfiguration({ members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }] }));
      const recipes = Array.from({ length: 7 }, (_, index) => createRecipeRepository(database).import(input(index)));
      const plan = await createPlanWithDeals(database, {
        week: "2026-10-07", seed: "deals", plannedAt: "2026-10-01T12:00:00.000Z",
      }, { fetchDeals: async (options) => {
        expect(options.shoppingDate).toBe("2026-10-03");
        expect(options.recipes.map(({ id }) => id).sort()).toEqual(recipes.map(({ id }) => id).sort());
        expect(options.preferredStores.map(({ name }) => name).sort()).toEqual(["Netto", "REMA 1000", "SuperBrugsen"]);
        return {
          dealSignals: [{ recipeId: recipes[0]!.id, storeId: options.preferredStores[0]!.id, value: 1, validUntil: "2026-10-09", confidence: "high" }],
          packageEstimates: [{ normalizedIngredient: "carrots", unit: "g", packageQuantity: 1000, perishability: "perishable" }],
          warnings: ["Test provider warning"],
        };
      } });
      expect(plan.score.dealValue).toBe(1);
      expect(plan.score.remainderPenalty).toBeGreaterThan(0);
      expect(plan.score.warnings).toContain("Test provider warning");
      expect(createPlanRepository(database).get(plan.id)).toEqual(plan);
    } finally { database.close(); }
  });

  test("plans Sunday using a persisted explicit link to a future meal", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-linked-plan-"));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, "mealplan.sqlite"));
    try {
      applySetup(database, createSetupConfiguration({ members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }] }));
      const repository = createRecipeRepository(database);
      const recipes = Array.from({ length: 7 }, (_, index) => repository.import(input(index)));
      const future = createPlanDraft(database, { week: "2026-10-12", seed: "future", plannedAt: "2026-10-01T12:00:00.000Z" });
      for (let index = 0; index < recipes.length; index += 1) repository.import({ ...input(index), extraMealServings: 0, suitabilityTags: index === 6 ? ["prepAhead"] : ["quick", "keepWarm", "reheatFriendly"] });
      const link = createPrepLinkRepository(database).add({ sourceRecipeId: recipes[6]!.id, targetMealId: future.meals[0]!.id, kind: "prep", normalizedIngredient: "carrots", quantity: 50, unit: "g", note: "Prep carrots" });
      const plan = createPlanDraft(database, { week: "2026-10-05", seed: "prep", plannedAt: "2026-10-01T12:00:00.000Z" });
      expect(plan.meals[6]!.recipeId).toBe(recipes[6]!.id);
      expect(plan.meals[6]!.prepLinks).toEqual([link.id]);
      expect(plan.score.explanations.join("\n")).toContain("Prep carrots");
    } finally { database.close(); }
  });

  test("resolves a requested date and saves a valid draft from local configuration", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-create-plan-"));
    temporaryDirectories.push(directory);
    const database = openDatabase(join(directory, "mealplan.sqlite"));
    applySetup(database, createSetupConfiguration({
      members: [{ id: "adult", name: "Adult", kind: "adult", servings: 2 }, { id: "child", name: "Child", kind: "child", servings: 2 }],
      pantryItems: [{ name: "Carrots", quantity: "200 g" }],
    }));
    const recipeRepository = createRecipeRepository(database);
    Array.from({ length: 8 }, (_, index) => recipeRepository.import(input(index)));

    const plan = createPlanDraft(database, {
      week: "2026-10-07",
      seed: "integration-seed",
      plannedAt: "2026-10-01T12:00:00.000Z",
    });

    expect(resolvePlanWeekStart("2026-10-07", "2026-10-01")).toBe("2026-10-05");
    expect(plan.weekStart).toBe("2026-10-05");
    expect(plan.shoppingDate).toBe("2026-10-03");
    expect(plan.status).toBe("draft");
    expect(plan.meals).toHaveLength(7);
    expect(plan.meals.slice(0, 6).every(({ servings }) => servings === 4)).toBe(true);
    expect(plan.meals[6]!.servings).toBe(8);
    expect(createPlanRepository(database).getForWeek("2026-10-05")).toEqual(plan);
    const late = createPlanDraft(database, { week: "2026-10-05", seed: "integration-seed", plannedAt: "2026-10-04T12:00:00.000Z" });
    expect(late.score.warnings.join("\n")).toContain("shopping date 2026-10-03 has passed");
    database.close();
  });
});
