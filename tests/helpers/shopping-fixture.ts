import { Database } from "bun:sqlite";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { DAYS, scoreWeeklyRecipes } from "../../src/domain/planner";
import { runMigrations } from "../../src/infrastructure/migrations";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";

export function shoppingRecipe(index: number): RecipeImport {
  return {
    sourceId: "mummum", sourceUrl: `https://mummum.dk/shopping-${index}/`, canonicalUrl: `https://mummum.dk/shopping-${index}/`,
    title: `Shopping recipe ${index}`, author: null, servings: 4, prepMinutes: 10, cookMinutes: 15, totalMinutes: 25,
    cuisineTags: ["danish"], proteinTag: "legume", dietaryTags: index === 0 || index === 8 ? ["vegetarian"] : ["low-salt"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook", "prepAhead"], extraMealServings: 4,
    preference: "neutral", needsReview: false, parserVersion: "test@1", fetchedAt: "2026-10-01T10:00:00.000Z",
    rawSourcePayload: { index }, sourceEvidence: {},
    ingredients: [{ rawText: `100 g ${index === 7 ? "beans" : "carrots"}`, normalizedName: index === 7 ? "beans" : "carrots", quantity: 100, unit: "g", uncertain: false }],
    instructions: ["Cook"],
  };
}

export function shoppingFixture(database = new Database(":memory:", { strict: true })) {
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database);
  applySetup(database, createSetupConfiguration({
    members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }],
    pantryItems: [{ name: "carrots", quantity: "0.2 kg" }],
  }));
  const recipes = Array.from({ length: 9 }, (_, index) => createRecipeRepository(database).import(shoppingRecipe(index)));
  const repository = createPlanRepository(database);
  const score = scoreWeeklyRecipes(recipes.slice(0, 7), {
    householdServings: 4, pantryItems: [], packageEstimates: [], dealSignals: [], preferredStoreIds: new Set(),
    shoppingDate: "2026-10-03", recentRecipeIds: new Set(),
  });
  const draft = repository.saveDraft({
    weekStart: "2026-10-05", shoppingDate: "2026-10-03", plannedAt: "2026-10-01T12:00:00.000Z", seed: "shopping",
    meals: DAYS.map((day, index) => ({ day, date: `2026-10-${String(5 + index).padStart(2, "0")}`,
      recipeId: recipes[index]!.id, servings: day === "sun" ? 8 : 4, rationale: [`fits ${day}`], prepLinks: [] })), score,
  });
  return { database, recipes, repository, draft };
}
