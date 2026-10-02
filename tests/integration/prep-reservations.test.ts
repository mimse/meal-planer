import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DAYS, scoreWeeklyRecipes } from "../../src/domain/planner";
import { runMigrations } from "../../src/infrastructure/migrations";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository } from "../../src/infrastructure/recipe-repository";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createPrepLinkRepository } from "../../src/infrastructure/prep-link-repository";

const databases: Database[] = [];
afterEach(() => { for (const database of databases.splice(0)) database.close(); });
function fixture() {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database);
  createConfigurationRepositories(database).recipeSources.upsert({ id: "example", name: "Example", baseUrl: "https://recipes.example/", enabled: true, adapter: "jsonld" });
  const recipes = Array.from({ length: 9 }, (_, index) => createRecipeRepository(database).import({
    sourceId: "example", sourceUrl: `https://recipes.example/${index}`, canonicalUrl: `https://recipes.example/${index}`, title: `Recipe ${index}`, author: null,
    servings: 4, prepMinutes: 10, cookMinutes: 20, totalMinutes: 30, cuisineTags: [], proteinTag: null, dietaryTags: ["vegetarian"], suitabilityTags: ["prepAhead"], extraMealServings: 4, preference: "neutral", needsReview: false, parserVersion: "test", fetchedAt: "2026-10-01T12:00:00.000Z", rawSourcePayload: {}, sourceEvidence: {},
    ingredients: [{ rawText: "500 g carrots", normalizedName: "carrots", quantity: 500, unit: "g", uncertain: false }], instructions: [],
  }));
  const plans = createPlanRepository(database);
  const links = createPrepLinkRepository(database);
  const score = scoreWeeklyRecipes(recipes.slice(0, 7), { householdServings: 4, pantryItems: [], packageEstimates: [], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set() });
  function draft(weekStart = "2026-10-05", seed = "producer") {
    return { weekStart, shoppingDate: "2026-10-03", plannedAt: "2026-10-01T12:00:00.000Z", seed, score,
      meals: DAYS.map((day, index) => ({ day, date: new Date(Date.parse(`${weekStart}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10), recipeId: recipes[index]!.id, servings: 4, rationale: ["test"], prepLinks: [] as string[] })) };
  }
  const future = plans.saveDraft(draft("2026-10-19", "future"));
  function add(targetIndex = 0, quantity = 200, kind: "prep" | "leftover" = "prep") {
    return links.add({ sourceRecipeId: recipes[6]!.id, targetMealId: future.meals[targetIndex]!.id, kind, normalizedIngredient: "carrots", quantity, unit: "g", note: `Prepare ${targetIndex}` });
  }
  return { database, recipes, plans, links, draft, future, add };
}

test("a saved Sunday occurrence reserves its link against earlier or later weeks", () => {
  const { plans, links, draft, add } = fixture();
  const link = add();
  const producer = draft();
  producer.meals[6]!.prepLinks = [link.id];
  plans.saveDraft(producer);
  expect(links.listVerifiedForSunday("2026-10-11")).toEqual([link]);
  expect(links.listVerifiedForSunday("2026-10-04")).toEqual([]);
  expect(links.listVerifiedForSunday("2026-10-18")).toEqual([]);
});

test("leftover allocations across future targets share the source ingredient yield", () => {
  const { add, links } = fixture();
  const first = add(0, 400, "leftover");
  expect(() => add(1, 400, "leftover")).toThrow("yield");
  expect(links.listVerifiedForSunday("2026-10-11")).toEqual([first]);
});

test("yield decreases invalidate the aggregate even when each leftover still fits", () => {
  const { database, recipes, links, add, plans, draft } = fixture();
  add(0, 200, "leftover");
  add(1, 200, "leftover");
  expect(links.listVerifiedForSunday("2026-10-11")).toHaveLength(2);
  database.query("UPDATE recipes SET extra_meal_servings = 2.4 WHERE id = ?").run(recipes[6]!.id);
  expect(links.listVerifiedForSunday("2026-10-11")).toEqual([]);
  expect(() => add(2, 1, "leftover")).toThrow("yield");
  const input = draft();
  input.meals[6]!.prepLinks = database.query<{ id: string }, []>("SELECT id FROM recipe_prep_links ORDER BY id").all().map(({ id }) => id);
  expect(() => plans.saveDraft(input)).toThrow("preparation");
  expect(plans.getForWeek(input.weekStart)).toBeNull();
});

test("regenerating the owning draft transfers its reservation after safe deletion", () => {
  const { plans, links, draft, add } = fixture();
  const link = add();
  const input = draft();
  input.meals[6]!.prepLinks = [link.id];
  const old = plans.saveDraft(input);
  const regenerated = plans.saveDraft({ ...input, seed: "regenerated" });
  expect(plans.get(old.id)).toBeNull();
  expect(regenerated.meals[6]!.prepLinks).toEqual([link.id]);
  expect(regenerated.meals[6]!.id).not.toBe(old.meals[6]!.id);
  expect(links.listVerifiedForSunday("2026-10-11")).toEqual([link]);
});

for (const weekStart of ["2026-09-28", "2026-10-05", "2026-10-12"]) {
  test(`accepted producer prevents another draft claiming the reservation in ${weekStart}`, () => {
    const { database, plans, draft, add } = fixture();
    const link = add();
    const input = draft();
    input.meals[6]!.prepLinks = [link.id];
    const accepted = plans.accept(plans.saveDraft(input).id, "2026-10-02T12:00:00.000Z");
    expect(plans.saveDraft(input)).toEqual(accepted);
    const before = database.query("SELECT * FROM meal_history ORDER BY id").all();
    const forged = draft(weekStart, "duplicate-claim");
    forged.meals[6]!.prepLinks = [link.id];
    expect(() => plans.saveDraft(forged)).toThrow("preparation");
    expect(plans.get(accepted.id)).toEqual(accepted);
    expect(database.query("SELECT * FROM meal_history ORDER BY id").all()).toEqual(before);
    expect(database.query("SELECT COUNT(*) AS count FROM weekly_plans").get()).toEqual({ count: 2 });
  });
}

test("replacement cannot duplicate an accepted producer on the same Sunday", () => {
  const { database, recipes, plans, draft, add } = fixture();
  const link = add();
  const input = draft();
  input.meals[6]!.prepLinks = [link.id];
  const accepted = plans.accept(plans.saveDraft(input).id, "2026-10-02T12:00:00.000Z");
  const next = draft("2026-10-05", "new-draft");
  next.meals[6]!.recipeId = recipes[7]!.id;
  const original = plans.saveDraft(next);
  expect(() => plans.replaceMeal({ original, day: "sun", meal: { recipeId: recipes[6]!.id, servings: 4, rationale: ["duplicate"], prepLinks: [link.id] }, score: original.score, rejection: "none", recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("preparation");
  expect(plans.get(original.id)).toEqual(original);
  expect(plans.get(accepted.id)).toEqual(accepted);
  expect(database.query("SELECT * FROM plan_meal_revisions").all()).toEqual([]);
});

for (const day of ["mon", "sun"] as const) {
  test(`replacement ${day} validates the producing occurrence atomically`, () => {
    const { database, recipes, plans, draft, add } = fixture();
    const link = add();
    const input = draft();
    input.meals[6]!.recipeId = recipes[7]!.id;
    const original = plans.saveDraft(input);
    const replace = () => plans.replaceMeal({ original, day, meal: { recipeId: recipes[6]!.id, servings: 4, rationale: ["producer"], prepLinks: [link.id] }, score: original.score, rejection: "not-this-week", recordedAt: "2026-10-02T12:00:00.000Z" });
    if (day === "mon") {
      expect(replace).toThrow("preparation");
      expect(plans.get(original.id)).toEqual(original);
      expect(database.query("SELECT * FROM weekly_recipe_rejections").all()).toEqual([]);
      expect(database.query("SELECT * FROM plan_meal_revisions").all()).toEqual([]);
    } else {
      expect(replace().meals[6]!.prepLinks).toEqual([link.id]);
    }
  });
}

test("bound links document the conservative detach limitation", () => {
  const { plans, links, draft, add } = fixture();
  const link = add();
  const input = draft();
  input.meals[6]!.prepLinks = [link.id];
  plans.saveDraft(input);
  expect(() => links.remove(link.id)).toThrow("explicit detach/revalidation workflow");
  expect(links.listVerifiedForSunday("2026-10-11")).toEqual([link]);
});

for (const forgery of ["nonSunday", "falseSundayDate", "wrongSource", "duplicate", "missing", "unreviewed", "targetBeforeProducer"] as const) {
  test(`draft save rejects ${forgery} prep binding and rolls back previous draft deletion`, () => {
    const { database, recipes, plans, draft, add } = fixture();
    const link = add();
    const old = plans.saveDraft(draft());
    const forged = draft("2026-10-05", "forged");
    forged.meals[6]!.prepLinks = [link.id];
    if (forgery === "nonSunday") {
      forged.meals[6]!.prepLinks = [];
      forged.meals[0]!.prepLinks = [link.id];
      forged.meals[0]!.recipeId = recipes[6]!.id;
      forged.meals[6]!.recipeId = recipes[0]!.id;
    }
    if (forgery === "falseSundayDate") forged.meals[6]!.date = "2026-10-12";
    if (forgery === "wrongSource") forged.meals[6]!.recipeId = recipes[7]!.id;
    if (forgery === "duplicate") forged.meals[6]!.prepLinks.push(link.id);
    if (forgery === "missing") forged.meals[6]!.prepLinks = [`prep:${"0".repeat(64)}`];
    if (forgery === "unreviewed") database.query("UPDATE recipes SET needs_review = 1 WHERE id = ?").run(recipes[6]!.id);
    if (forgery === "targetBeforeProducer") forged.meals[6]!.date = "2026-10-25";
    expect(() => plans.saveDraft(forged)).toThrow("preparation");
    expect(plans.getForWeek(old.weekStart)).toEqual(old);
    expect(database.query("SELECT COUNT(*) AS count FROM weekly_plans").get()).toEqual({ count: 2 });
  });
}
