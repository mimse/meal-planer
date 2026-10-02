import { describe, expect, test } from "bun:test";
import { reviewRecipe } from "../../src/application/recipe-review";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";

function incompleteRecipe(): RecipeImport {
  return {
    sourceId: "example",
    sourceUrl: "https://recipes.example/soup",
    canonicalUrl: "https://recipes.example/soup",
    title: "Soup",
    author: "Author",
    servings: null,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: null,
    cuisineTags: [],
    proteinTag: null,
    dietaryTags: [],
    suitabilityTags: [],
    extraMealServings: 0,
    preference: "neutral",
    needsReview: true,
    parserVersion: "jsonld@1",
    fetchedAt: "2026-09-28T12:00:00.000Z",
    rawSourcePayload: { evidence: "immutable" },
    sourceEvidence: { url: "https://recipes.example/soup" },
    ingredients: [{ rawText: "1 tomato", normalizedName: "1 tomato", quantity: null, unit: null, uncertain: true }],
    instructions: ["Cook."],
  };
}

describe("reviewRecipe", () => {
  test("rejects mark-reviewed while planning-critical evidence is incomplete without mutation", () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
    });
    const repository = createRecipeRepository(database);
    const original = repository.import(incompleteRecipe());

    expect(() => reviewRecipe(database, original.id, { markReviewed: true }))
      .toThrow("Cannot mark recipe reviewed: servings, a duration, ingredients, and dietary classification are required");
    expect(repository.get(original.id)).toEqual(original);
    database.close();
  });

  test("atomically updates only safe review fields and preserves provenance and ordered evidence", () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
    });
    const repository = createRecipeRepository(database);
    const original = repository.import(incompleteRecipe());

    const reviewed = reviewRecipe(database, original.id, {
      dietaryTags: ["vegetarian"],
      suitabilityTags: ["quick", "reheatFriendly"],
      cuisineTags: ["Danish"],
      proteinTag: "legume",
      preference: "favorite",
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: 30,
      extraMealServings: 8,
      markReviewed: true,
    });

    expect(reviewed).toMatchObject({
      id: original.id,
      dietaryTags: ["vegetarian"],
      suitabilityTags: ["quick", "reheatFriendly"],
      cuisineTags: ["danish"],
      proteinTag: "legume",
      preference: "favorite",
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: 30,
      extraMealServings: 8,
      needsReview: false,
    });
    for (const key of [
      "sourceId", "sourceUrl", "canonicalUrl", "title", "author", "parserVersion", "fetchedAt",
      "rawSourcePayload", "ingredients", "instructions",
    ] as const) {
      expect(reviewed[key]).toEqual(original[key]);
    }
    expect(reviewed.sourceEvidence).toEqual({
      url: "https://recipes.example/soup",
      reviewOverrides: [
        "servings", "prepMinutes", "cookMinutes", "totalMinutes", "cuisineTags", "proteinTag",
        "dietaryTags", "suitabilityTags", "extraMealServings", "preference", "needsReview",
      ],
    });
    expect(repository.get(original.id)).toEqual(reviewed);
    database.close();
  });

  test("rejects an invalid complete update atomically and reports exact not-found", () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
    });
    const repository = createRecipeRepository(database);
    const original = repository.import(incompleteRecipe());

    expect(() => reviewRecipe(database, original.id, {
      dietaryTags: ["imaginary" as "vegetarian"],
      servings: 4,
      totalMinutes: 30,
      markReviewed: true,
    })).toThrow();
    expect(repository.get(original.id)).toEqual(original);
    expect(() => reviewRecipe(database, `recipe:${"0".repeat(64)}`, { preference: "disliked" }))
      .toThrow(`Recipe does not exist: recipe:${"0".repeat(64)}`);
    database.close();
  });

  test("distinguishes explicit clears from omission and marks planning-critical clears for review", () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
    });
    const repository = createRecipeRepository(database);
    const original = repository.import({
      ...incompleteRecipe(),
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: 30,
      cuisineTags: ["danish"],
      proteinTag: "legume",
      dietaryTags: ["vegetarian"],
      suitabilityTags: ["quick"],
      preference: "favorite",
      needsReview: false,
    });

    const cleared = reviewRecipe(database, original.id, {
      dietaryTags: [],
      suitabilityTags: [],
      cuisineTags: [],
      proteinTag: null,
      servings: null,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: null,
    });

    expect(cleared).toMatchObject({
      dietaryTags: [],
      suitabilityTags: [],
      cuisineTags: [],
      proteinTag: null,
      servings: null,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: null,
      preference: "favorite",
      needsReview: true,
    });
    database.close();
  });

  test("rejects mark-reviewed combined with an incomplete clear atomically", () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
    });
    const repository = createRecipeRepository(database);
    const original = repository.import({
      ...incompleteRecipe(),
      servings: 4,
      totalMinutes: 30,
      dietaryTags: ["vegetarian"],
      needsReview: false,
    });

    expect(() => reviewRecipe(database, original.id, {
      servings: null,
      markReviewed: true,
    })).toThrow("Cannot mark recipe reviewed");
    expect(repository.get(original.id)).toEqual(original);
    database.close();
  });
});
