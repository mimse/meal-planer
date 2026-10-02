import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository } from "../../src/infrastructure/recipe-repository";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createPrepLinkRepository } from "../../src/infrastructure/prep-link-repository";
import { DAYS, generateWeeklyPlan } from "../../src/domain/planner";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });

test("prep links bind measured consumption to a real future meal and reject over-allocation", async () => {
  const root = await mkdtemp(join(tmpdir(), "meal-prep-links-")); directories.push(root);
  const database = openDatabase(join(root, "state.sqlite"));
  try {
    createConfigurationRepositories(database).recipeSources.upsert({ id: "example", name: "Example", baseUrl: "https://recipes.example/", enabled: true, adapter: "jsonld" });
    const recipes = Array.from({ length: 7 }, (_, index) => createRecipeRepository(database).import({
      sourceId: "example", sourceUrl: `https://recipes.example/${index}`, canonicalUrl: `https://recipes.example/${index}`, title: `Recipe ${index}`, author: null,
      servings: 4, prepMinutes: 10, cookMinutes: 20, totalMinutes: 30, cuisineTags: [], proteinTag: null, dietaryTags: ["vegetarian"], suitabilityTags: ["prepAhead"], extraMealServings: 4, preference: "neutral", needsReview: false, parserVersion: "test", fetchedAt: "2026-10-01T12:00:00.000Z", rawSourcePayload: {}, sourceEvidence: {},
      ingredients: [{ rawText: "500 g carrots", normalizedName: "carrots", quantity: 500, unit: "g", uncertain: false }], instructions: [],
    }));
    const generated = generateWeeklyPlan({ weekStart: "2026-10-12", plannedAt: "2026-10-01T12:00:00.000Z", seed: "future", recipes,
      dayProfiles: DAYS.map((day) => ({ day, maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false })),
      context: { householdServings: 4, enabledSourceIds: new Set(["example"]), dietaryRestrictions: [], dislikedIngredients: [] },
    });
    if (generated.status !== "generated") throw new Error("Expected future plan");
    const future = createPlanRepository(database).saveDraft(generated.plan);
    const repository = createPrepLinkRepository(database);
    const input = { sourceRecipeId: recipes[6]!.id, targetMealId: future.meals[0]!.id, kind: "prep" as const, normalizedIngredient: "carrots", quantity: 200, unit: "g" as const, note: "Chop carrots" };
    const link = repository.add(input);
    expect(repository.add(input)).toEqual(link);
    expect(repository.listVerifiedForSunday("2026-10-11")).toEqual([link]);
    expect(repository.listVerifiedForSunday("2026-10-18")).toEqual([]);
    expect(() => repository.add({ ...input, quantity: 501 })).toThrow("demand");
    expect(() => repository.add({ ...input, normalizedIngredient: "spinach" })).toThrow("ingredient");
    expect(repository.listVerifiedForSunday("2026-10-11")).toHaveLength(1);
    repository.remove(link.id);
    expect(repository.listVerifiedForSunday("2026-10-11")).toEqual([]);
  } finally { database.close(); }
});
