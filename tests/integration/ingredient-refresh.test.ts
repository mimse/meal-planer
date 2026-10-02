import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { importRecipeUrl } from "../../src/application/recipe-ingestion";
import { reviewRecipe } from "../../src/application/recipe-review";
import { scoreWeeklyRecipes } from "../../src/domain/planner";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository } from "../../src/infrastructure/recipe-repository";

const url = "https://recipes.example/soup";
const html = (rawIngredients: string[]) => `<script type="application/ld+json">${JSON.stringify({
  "@type": "Recipe", name: "Soup", url, recipeYield: "4", totalTime: "PT30M",
  suitableForDiet: "https://schema.org/VegetarianDiet", recipeIngredient: rawIngredients,
})}</script>`;
function fetcher(body: string) {
  return { fetch: async (url: URL) => ({
    resource: { url, body, mediaType: "text/html", status: 200 as const, etag: null, lastModified: null },
    cacheStatus: "refreshed" as const,
  }) };
}
function source(database: ReturnType<typeof openDatabase>) {
  createConfigurationRepositories(database).recipeSources.upsert({
    id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
  });
}

describe("ingredient production path", () => {
  test("persists reviewed ingredient overrides across restart and source refresh while refreshing raw payload", async () => {
    const directory = mkdtempSync(join(tmpdir(), "mealplan-ingredient-review-"));
    const path = join(directory, "state.sqlite");
    let database = openDatabase(path);
    try {
      source(database);
      const originalLine = " 2 dåser tomater ";
      const initial = await importRecipeUrl(database, { url }, { resourceFetcher: fetcher(html([originalLine])) });
      const reviewed = reviewRecipe(database, initial.recipe.id, {
        ingredients: [{ rawText: originalLine, normalizedName: "Tomater", quantity: 800, unit: "g", uncertain: false }],
        markReviewed: true,
      });
      database.close();
      database = openDatabase(path);
      expect(createRecipeRepository(database).get(reviewed.id)?.ingredients).toEqual(reviewed.ingredients);
      const refreshed = await importRecipeUrl(database, { url }, {
        resourceFetcher: fetcher(html(["1 kg friske tomater"])), now: () => "2026-10-02T10:00:00.000Z",
      });
      expect(refreshed.recipe.id).toBe(reviewed.id);
      expect(refreshed.recipe.ingredients).toEqual(reviewed.ingredients);
      expect(refreshed.recipe.sourceEvidence).toEqual(expect.objectContaining({ reviewOverrides: ["ingredients", "needsReview"] }));
      expect(refreshed.recipe.rawSourcePayload).toEqual(expect.objectContaining({ recipeIngredient: ["1 kg friske tomater"] }));
      expect(refreshed.recipe.fetchedAt).toBe("2026-10-02T10:00:00.000Z");
      expect(createRecipeRepository(database).get(reviewed.id)).toEqual(refreshed.recipe);
    } finally {
      database.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  test("refreshes normalized ingredients without an explicit ingredients override", async () => {
    const database = openDatabase(":memory:");
    try {
      source(database);
      const initial = await importRecipeUrl(database, { url }, { resourceFetcher: fetcher(html(["500 g tomater"])) });
      reviewRecipe(database, initial.recipe.id, { preference: "favorite" });
      const refreshed = await importRecipeUrl(database, { url }, { resourceFetcher: fetcher(html(["1 kg tomater"])) });
      expect(refreshed.recipe.ingredients).toEqual([
        { rawText: "1 kg tomater", normalizedName: "tomater", quantity: 1000, unit: "g", uncertain: false },
      ]);
      expect(refreshed.recipe.sourceEvidence).toEqual(expect.objectContaining({ reviewOverrides: ["preference", "needsReview"] }));
    } finally { database.close(); }
  });

  test("scales imported base-unit quantities for household demand without changing recipe evidence", async () => {
    const database = openDatabase(":memory:");
    try {
      source(database);
      const imported = await importRecipeUrl(database, { url }, { resourceFetcher: fetcher(html(["0,5 kg tomater"])) });
      const score = scoreWeeklyRecipes([imported.recipe], {
        householdServings: 6, pantryItems: [], packageEstimates: [
          { normalizedIngredient: "tomater", unit: "g", packageQuantity: 1000, perishability: "perishable" },
        ], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set(),
      });
      expect(score.predictedRemainders).toEqual([{
        normalizedIngredient: "tomater", unit: "g", demand: 750, pantryUsed: 0,
        packageQuantity: 1000, packageCount: 1, remainder: 250, perishability: "perishable",
      }]);
      expect(createRecipeRepository(database).get(imported.recipe.id)?.ingredients).toEqual([
        { rawText: "0,5 kg tomater", normalizedName: "tomater", quantity: 500, unit: "g", uncertain: false },
      ]);
    } finally { database.close(); }
  });
});
