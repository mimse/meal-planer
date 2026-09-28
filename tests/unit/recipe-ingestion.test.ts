import { describe, expect, test } from "bun:test";
import {
  hasPlanningCriticalEvidence,
  mapExtractedRecipeToImport,
  parseRecipeLimit,
  validateRecipeUrlForSource,
} from "../../src/application/recipe-ingestion";
import type { ExtractedRecipe } from "../../src/adapters/recipes/extraction";
import type { RecipeSource } from "../../src/infrastructure/configuration-repositories";

const source: RecipeSource = {
  id: "example",
  name: "Example",
  baseUrl: "https://recipes.example/recipes/",
  adapter: "jsonld",
  enabled: true,
};

function extracted(overrides: Partial<ExtractedRecipe> = {}): ExtractedRecipe {
  return {
    title: " Tomato   Soup ",
    sourceUrl: "https://recipes.example/recipes/tomato",
    canonicalUrl: "https://recipes.example/recipes/tomato",
    author: null,
    servings: 4,
    prepMinutes: 10,
    cookMinutes: null,
    totalMinutes: 30,
    rawIngredients: [" 2 dåser tomater ", "Salt efter smag"],
    instructions: ["Åbn dåserne.", "Kog suppen."],
    dietaryTags: ["vegetarian"],
    raw: { "@type": "Recipe", name: "Tomato Soup" },
    ...overrides,
  };
}

describe("recipe ingestion mapping", () => {
  test("maps extraction evidence without guessing planner metadata or ingredient quantities", () => {
    const mapped = mapExtractedRecipeToImport(source, extracted(), {
      requestUrl: "https://recipes.example/recipes/tomato",
      finalUrl: "https://recipes.example/recipes/tomato",
      fetchedAt: "2026-09-28T12:00:00.000Z",
      cacheStatus: "miss",
    });

    expect(mapped).toMatchObject({
      sourceId: "example",
      sourceUrl: "https://recipes.example/recipes/tomato",
      canonicalUrl: "https://recipes.example/recipes/tomato",
      title: " Tomato   Soup ",
      servings: 4,
      prepMinutes: 10,
      cookMinutes: null,
      totalMinutes: 30,
      cuisineTags: [],
      proteinTag: null,
      dietaryTags: ["vegetarian"],
      suitabilityTags: [],
      extraMealServings: 0,
      preference: "neutral",
      needsReview: false,
      parserVersion: "jsonld@1",
      fetchedAt: "2026-09-28T12:00:00.000Z",
      rawSourcePayload: extracted().raw,
      ingredients: [
        { rawText: " 2 dåser tomater ", normalizedName: null, quantity: null, unit: null, uncertain: true },
        { rawText: "Salt efter smag", normalizedName: null, quantity: null, unit: null, uncertain: true },
      ],
      instructions: ["Åbn dåserne.", "Kog suppen."],
    });
    expect(mapped.sourceEvidence).toEqual({
      adapter: "jsonld",
      cacheStatus: "miss",
      configuredSourceId: "example",
      configuredBaseUrl: "https://recipes.example/recipes/",
      requestUrl: "https://recipes.example/recipes/tomato",
      finalUrl: "https://recipes.example/recipes/tomato",
      extractedSourceUrl: "https://recipes.example/recipes/tomato",
      extractedCanonicalUrl: "https://recipes.example/recipes/tomato",
    });
  });

  test("documents planning-critical completeness as servings, any duration, ingredients, and dietary tags", () => {
    expect(hasPlanningCriticalEvidence(extracted())).toBe(true);
    expect(hasPlanningCriticalEvidence(extracted({ servings: null }))).toBe(false);
    expect(hasPlanningCriticalEvidence(extracted({ prepMinutes: null, cookMinutes: null, totalMinutes: null }))).toBe(false);
    expect(hasPlanningCriticalEvidence(extracted({ rawIngredients: [] }))).toBe(false);
    expect(hasPlanningCriticalEvidence(extracted({ dietaryTags: [] }))).toBe(false);
  });

  test("validates import and sync limits as positive safe integers capped at 100", () => {
    expect(parseRecipeLimit(undefined)).toBe(50);
    expect(parseRecipeLimit("1")).toBe(1);
    expect(parseRecipeLimit("100")).toBe(100);
    for (const value of ["0", "-1", "1.5", "101", "9007199254740992", "nope"]) {
      expect(() => parseRecipeLimit(value)).toThrow("positive integer between 1 and 100");
    }
  });

  test("enforces HTTP source host, scheme, port, path, credentials, and fragments", () => {
    expect(validateRecipeUrlForSource("https://www.recipes.example/recipes/tomato", source).href)
      .toBe("https://www.recipes.example/recipes/tomato");
    for (const value of [
      "http://recipes.example/recipes/tomato",
      "https://recipes.example/other/tomato",
      "https://evil.example/recipes/tomato",
      "https://user:secret@recipes.example/recipes/tomato",
      "https://recipes.example/recipes/tomato#step",
    ]) {
      expect(() => validateRecipeUrlForSource(value, source)).toThrow();
    }
  });

  test("rejects every malformed percent escape before source-scoped use", () => {
    for (const suffix of ["%zz", "%", "%2"]) {
      expect(() => validateRecipeUrlForSource(`https://recipes.example/recipes/${suffix}`, source))
        .toThrow("malformed percent escape");
    }
  });

  test("rejects encoded path traversal while accepting encoded nonstructural characters", () => {
    for (const suffix of ["%2e%2e%2foutside", "%2e%2e%5coutside", "%252e%252e%252foutside"]) {
      expect(() => validateRecipeUrlForSource(`https://recipes.example/recipes/${suffix}`, source))
        .toThrow("unsafe source path");
    }
    expect(validateRecipeUrlForSource(
      "https://recipes.example/recipes/caf%C3%A9%20soup",
      source,
    ).href).toBe("https://recipes.example/recipes/caf%C3%A9%20soup");
    expect(() => validateRecipeUrlForSource("https://recipes.example/%2e%2e/outside", {
      ...source,
      baseUrl: "https://recipes.example/",
    })).toThrow("unsafe source path traversal");
  });

  test("rejects malformed extracted source and canonical URLs before mapping to persistence", () => {
    const evidence = {
      requestUrl: "https://recipes.example/recipes/tomato",
      finalUrl: "https://recipes.example/recipes/tomato",
      fetchedAt: "2026-09-28T12:00:00.000Z",
      cacheStatus: "miss" as const,
    };
    for (const suffix of ["%zz", "%", "%2"]) {
      expect(() => mapExtractedRecipeToImport(source, extracted({
        sourceUrl: `https://recipes.example/recipes/${suffix}`,
      }), evidence)).toThrow("malformed percent escape");
      expect(() => mapExtractedRecipeToImport(source, extracted({
        canonicalUrl: `https://recipes.example/recipes/${suffix}`,
      }), evidence)).toThrow("malformed percent escape");
    }
  });
});
