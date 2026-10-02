import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DAYS, scoreWeeklyRecipes, type GeneratedWeeklyPlan } from "../../src/domain/planner";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { openDatabase } from "../../src/infrastructure/database";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meal-planer-plans-"));
  temporaryDirectories.push(directory);
  return join(directory, "mealplan.sqlite");
}

function recipeInput(index: number): RecipeImport {
  return {
    sourceId: "example",
    sourceUrl: `https://recipes.example/${index}`,
    canonicalUrl: `https://recipes.example/${index}`,
    title: `Recipe ${index}`,
    author: "Test",
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 20,
    totalMinutes: 30,
    cuisineTags: [index % 2 === 0 ? "danish" : "italian"],
    proteinTag: index % 2 === 0 ? "legume" : "chicken",
    dietaryTags: index === 0 ? ["vegetarian"] : ["low-salt"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook"],
    extraMealServings: 4,
    preference: "neutral",
    needsReview: false,
    parserVersion: "test@1",
    fetchedAt: "2026-10-01T12:00:00.000Z",
    rawSourcePayload: { index },
    sourceEvidence: { adapter: "test" },
    ingredients: [{
      rawText: "100 g carrots",
      normalizedName: "carrots",
      quantity: 100,
      unit: "g",
      uncertain: false,
    }],
    instructions: ["Cook."],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plan repository", () => {
  test("saves and reads a stable seven-meal draft", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example",
      name: "Example",
      baseUrl: "https://recipes.example/",
      adapter: "jsonld",
      enabled: true,
    });
    const recipes = Array.from({ length: 7 }, (_, index) =>
      createRecipeRepository(database).import(recipeInput(index)));
    const weekStart = new Date("2026-10-05T00:00:00.000Z");
    const score = scoreWeeklyRecipes(recipes, {
      householdServings: 4,
      pantryItems: [],
      packageEstimates: [],
      dealSignals: [],
      preferredStoreIds: new Set(),
      shoppingDate: "2026-10-03",
      recentRecipeIds: new Set(),
    });
    const draft: GeneratedWeeklyPlan = {
      weekStart: "2026-10-05",
      shoppingDate: "2026-10-03",
      plannedAt: "2026-10-01T12:00:00.000Z",
      seed: "stable-seed",
      meals: DAYS.map((day, index) => {
        const date = new Date(weekStart);
        date.setUTCDate(date.getUTCDate() + index);
        return {
          day,
          date: date.toISOString().slice(0, 10),
          recipeId: recipes[index]!.id,
          servings: 4,
          rationale: [`fits ${day}`],
          prepLinks: [],
        };
      }),
      score,
    };

    const repository = createPlanRepository(database);
    const saved = repository.saveDraft(draft);

    expect(saved.id).toMatch(/^plan:[a-f0-9]{64}$/);
    expect(saved.status).toBe("draft");
    expect(saved.meals).toHaveLength(7);
    expect(saved.meals.map(({ day }) => day)).toEqual([...DAYS]);
    expect(saved.meals.every(({ id }) => /^meal:[a-f0-9]{64}$/.test(id))).toBe(true);
    expect(saved.meals.every(({ contentHash }) => /^[a-f0-9]{64}$/.test(contentHash))).toBe(true);
    expect(repository.get(saved.id)).toEqual(saved);
    expect(repository.getForWeek("2026-10-05")).toEqual(saved);
    expect(repository.saveDraft(draft)).toEqual(saved);

    const accepted = repository.accept(saved.id, "2026-10-02T12:00:00.000Z");
    expect(accepted.status).toBe("accepted");
    expect(accepted.meals).toEqual(saved.meals);
    expect(repository.getForWeek("2026-10-05")).toEqual(accepted);
    expect(repository.listRecentRecipeIds("2026-09-01")).toEqual(
      accepted.meals.map(({ recipeId }) => recipeId).reverse(),
    );
    expect(repository.accept(saved.id, "2026-10-02T13:00:00.000Z")).toEqual(accepted);
    expect(repository.saveDraft(draft)).toEqual(accepted);
    expect(repository.listRecentRecipeIds("2026-09-01")).toEqual(
      accepted.meals.map(({ recipeId }) => recipeId).reverse(),
    );
    database.close();
  });
});
