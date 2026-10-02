import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanDraft, resolvePlanWeekStart } from "../../src/application/create-plan";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { openDatabase } from "../../src/infrastructure/database";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
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
    expect(plan.meals.every(({ servings }) => servings === 4)).toBe(true);
    expect(createPlanRepository(database).getForWeek("2026-10-05")).toEqual(plan);
    database.close();
  });
});
