import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { DAYS, scoreWeeklyRecipes } from "../../src/domain/planner";
import { runMigrations } from "../../src/infrastructure/migrations";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { previewPlanMealReplacement, confirmPlanMealReplacement } from "../../src/application/replace-plan-meal";
import { createPrepLinkRepository } from "../../src/infrastructure/prep-link-repository";

const databases: Database[] = [];
function input(index: number): RecipeImport {
  return {
    sourceId: "mummum", sourceUrl: `https://mummum.dk/replacement-${index}/`, canonicalUrl: `https://mummum.dk/replacement-${index}/`,
    title: `Replacement ${index}`, author: null, servings: 4, prepMinutes: 10, cookMinutes: 15, totalMinutes: 25,
    cuisineTags: ["danish"], proteinTag: "legume", dietaryTags: index === 0 || index === 8 ? ["vegetarian"] : ["low-salt"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook"], extraMealServings: 4,
    preference: "neutral", needsReview: false, parserVersion: "test@1", fetchedAt: "2026-10-01T10:00:00.000Z",
    rawSourcePayload: { index }, sourceEvidence: {},
    ingredients: [{ rawText: `100 g ${index === 7 ? "beans" : "carrots"}`, normalizedName: index === 7 ? "beans" : "carrots", quantity: 100, unit: "g", uncertain: false }],
    instructions: ["Cook"],
  };
}
function fixture() {
  const database = new Database(":memory:", { strict: true });
  databases.push(database);
  database.exec("PRAGMA foreign_keys = ON");
  runMigrations(database);
  applySetup(database, createSetupConfiguration({ members: [{ id: "adult", name: "Adult", kind: "adult", servings: 4 }] }));
  const recipes = Array.from({ length: 9 }, (_, index) => createRecipeRepository(database).import(input(index)));
  const repository = createPlanRepository(database);
  const score = scoreWeeklyRecipes(recipes.slice(0, 7), { householdServings: 4, pantryItems: [], packageEstimates: [], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set() });
  const plan = repository.saveDraft({
    weekStart: "2026-10-05", shoppingDate: "2026-10-03", plannedAt: "2026-10-01T12:00:00.000Z", seed: "replace",
    meals: DAYS.map((day, index) => ({ day, date: `2026-10-${String(5 + index).padStart(2, "0")}`, recipeId: recipes[index]!.id, servings: 4, rationale: [`fits ${day}`], prepLinks: [] })), score,
  });
  return { database, recipes, repository, plan };
}
afterEach(() => { for (const database of databases.splice(0)) database.close(); });

test("lock and unlock hash only the selected record and refuse stale hashes", () => {
  const { repository, plan } = fixture();
  const locked = repository.lock(plan.id, "tue", plan.meals[1]!.contentHash);
  expect(locked.meals[1]!.locked).toBe(true);
  expect(locked.meals[1]!.contentHash).not.toBe(plan.meals[1]!.contentHash);
  expect(locked.meals.filter(({ day }) => day !== "tue")).toEqual(plan.meals.filter(({ day }) => day !== "tue"));
  expect(() => repository.unlock(plan.id, "tue", plan.meals[1]!.contentHash)).toThrow("Stale");
  expect(repository.unlock(plan.id, "tue", locked.meals[1]!.contentHash)).toEqual(plan);
});

test("preview scores the fixed seven, reports exact ingredient deltas and writes nothing", () => {
  const { database, recipes, repository, plan } = fixture();
  const writesBefore = database.query("SELECT total_changes() AS count").get();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  expect(preview.candidates.map(({ recipeId }) => recipeId).sort()).toEqual([recipes[7]!.id, recipes[8]!.id].sort());
  const candidate = preview.candidates.find(({ recipeId }) => recipeId === recipes[7]!.id)!;
  expect(candidate.ingredientDelta.additions).toEqual([{ normalizedIngredient: "beans", unit: "g", quantity: 100 }]);
  expect(candidate.ingredientDelta.removals).toEqual([{ normalizedIngredient: "carrots", unit: "g", quantity: 100 }]);
  expect(candidate.scoreDelta.wastePenalty).toBe(2);
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(writesBefore);
  const saved = confirmPlanMealReplacement(database, preview, { recipeId: candidate.recipeId, rejection: "not-this-week", recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(saved.score).toEqual(candidate.score);
  expect(saved.meals.filter(({ day }) => day !== "tue")).toEqual(plan.meals.filter(({ day }) => day !== "tue"));
  expect(repository.listRejectedRecipeIds(plan.weekStart)).toEqual([recipes[1]!.id]);
});

test("persistent rejection marks the reviewed preference override atomically", () => {
  const { database, recipes, plan } = fixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, rejection: "disliked", recordedAt: "2026-10-02T12:00:00.000Z" });
  const rejected = createRecipeRepository(database).get(recipes[1]!.id)!;
  expect(rejected.preference).toBe("disliked");
  expect(rejected.sourceEvidence).toEqual({ reviewOverrides: ["preference"] });
  expect(database.query("SELECT * FROM weekly_recipe_rejections").all()).toEqual([]);
});

test("replacement refuses an already-invalid fixed meal rather than silently relaxing the week", () => {
  const { database, plan, recipes } = fixture();
  database.query("UPDATE recipes SET preference = 'disliked' WHERE id = ?").run(recipes[2]!.id);
  const before = database.query("SELECT total_changes() AS count").get();
  expect(() => previewPlanMealReplacement(database, { planId: plan.id, day: "tue" })).toThrow("Fixed meal wed");
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
});

test("atomic replacement preserves six raw rows and stable target identity", () => {
  const { database, recipes, repository, plan } = fixture();
  const before = database.query("SELECT * FROM plan_meals WHERE plan_id = ? AND day != 'tue' ORDER BY day").all(plan.id);
  const saved = repository.replaceMeal({ original: plan, day: "tue", meal: { recipeId: recipes[7]!.id, servings: 4, rationale: ["replacement"], prepLinks: [] }, score: plan.score, rejection: "not-this-week", recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(database.query("SELECT * FROM plan_meals WHERE plan_id = ? AND day != 'tue' ORDER BY day").all(plan.id)).toEqual(before);
  expect(saved.meals[1]!.id).toBe(plan.meals[1]!.id);
  expect(saved.meals[1]!.contentHash).not.toBe(plan.meals[1]!.contentHash);
  expect(repository.listRejectedRecipeIds(plan.weekStart)).toEqual([recipes[1]!.id]);
});

test("sole vegetarian can only be replaced by an eligible vegetarian", () => {
  const { database, plan, recipes } = fixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "mon" });
  expect(preview.candidates.map(({ recipeId }) => recipeId)).toEqual([recipes[8]!.id]);
  expect(preview.blockedCandidates.find(({ recipeId }) => recipeId === recipes[7]!.id)?.reasons).toContain("replacement violates the week-wide vegetarian minimum");
  const before = database.query("SELECT total_changes() AS count").get();
  expect(() => confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("not eligible");
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
});

test("blocked target returns explanations and no writes", () => {
  const { database, plan } = fixture();
  database.query("UPDATE day_profiles SET max_total_minutes = 1 WHERE day = 'tue'").run();
  const before = database.query("SELECT total_changes() AS count").get();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  expect(preview.candidates).toEqual([]);
  expect(preview.blockedCandidates).toHaveLength(2);
  expect(preview.blockedCandidates.every(({ reasons }) => reasons.some((reason) => reason.includes("exceeds 1 min")))).toBe(true);
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
});

test("repeat replacements exclude rejected-for-week, assigned and disliked recipes", () => {
  const { database, plan, recipes } = fixture();
  const first = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  confirmPlanMealReplacement(database, first, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" });
  const next = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  expect(next.candidates.map(({ recipeId }) => recipeId)).toEqual([recipes[8]!.id]);
  database.query("UPDATE recipes SET preference = 'disliked' WHERE id = ?").run(recipes[8]!.id);
  expect(previewPlanMealReplacement(database, { planId: plan.id, day: "tue" }).candidates).toEqual([]);
});

test("locked target refuses preview but unaffected explicit locks stay byte-identical", () => {
  const { database, plan, recipes, repository } = fixture();
  const locked = repository.lock(plan.id, "wed", plan.meals[2]!.contentHash);
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  const saved = confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(saved.meals[2]).toEqual(locked.meals[2]);
  repository.lock(saved.id, "tue", saved.meals[1]!.contentHash);
  const before = database.query("SELECT total_changes() AS count").get();
  expect(() => previewPlanMealReplacement(database, { planId: saved.id, day: "tue" })).toThrow("locked");
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
});

for (const change of ["lock", "status", "score", "candidate", "pantry", "profile"] as const) {
  test(`stale preview refuses concurrent ${change} changes without further writes`, () => {
    const { database, plan, recipes, repository } = fixture();
    const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
    if (change === "lock") repository.lock(plan.id, "wed", plan.meals[2]!.contentHash);
    if (change === "status") repository.accept(plan.id, "2026-10-02T11:00:00.000Z");
    if (change === "score") database.query("UPDATE weekly_plans SET score_summary = json_set(score_summary, '$.dealValue', 10) WHERE id = ?").run(plan.id);
    if (change === "candidate") database.query("UPDATE recipes SET needs_review = 1 WHERE id = ?").run(recipes[7]!.id);
    if (change === "pantry") database.query("INSERT INTO pantry_items VALUES ('beans','Beans','100 g')").run();
    if (change === "profile") database.query("UPDATE day_profiles SET max_total_minutes = 20 WHERE day = 'tue'").run();
    const before = database.query("SELECT total_changes() AS count").get();
    expect(() => confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("Stale");
    expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
    expect(database.query("SELECT * FROM plan_meal_revisions").all()).toEqual([]);
  });
}

test("accepted replacement updates only target history with the stable meal id", () => {
  const { database, plan, recipes, repository } = fixture();
  const accepted = repository.accept(plan.id, "2026-10-02T11:00:00.000Z");
  const before = database.query("SELECT * FROM meal_history WHERE plan_meal_id != ? ORDER BY id").all(plan.meals[1]!.id);
  const preview = previewPlanMealReplacement(database, { planId: accepted.id, day: "tue" });
  const saved = confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(saved.status).toBe("accepted");
  expect(database.query("SELECT * FROM meal_history WHERE plan_meal_id != ? ORDER BY id").all(plan.meals[1]!.id)).toEqual(before);
  expect(database.query("SELECT recipe_id, cooked_on, recorded_at FROM meal_history WHERE plan_meal_id = ?").get(plan.meals[1]!.id)).toEqual({ recipe_id: recipes[7]!.id, cooked_on: "2026-10-06", recorded_at: "2026-10-02T12:00:00.000Z" });
  expect(database.query("SELECT COUNT(*) AS count FROM meal_history").get()).toEqual({ count: 7 });
  expect(repository.listRecentRecipeIds("2026-10-01")).not.toContain(recipes[1]!.id);
});

for (const rejection of ["not-this-week", "disliked"] as const) {
  test(`audit failure rolls back meal, score, history and ${rejection} side effects`, () => {
    const { database, plan, recipes, repository } = fixture();
    const accepted = repository.accept(plan.id, "2026-10-02T11:00:00.000Z");
    const history = database.query("SELECT * FROM meal_history ORDER BY id").all();
    const recipe = createRecipeRepository(database).get(recipes[1]!.id);
    const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
    database.exec("CREATE TRIGGER fail_revision BEFORE INSERT ON plan_meal_revisions BEGIN SELECT RAISE(ABORT, 'deliberate audit failure'); END;");
    expect(() => confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, rejection, recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("deliberate audit failure");
    expect(repository.get(plan.id)).toEqual(accepted);
    expect(database.query("SELECT * FROM meal_history ORDER BY id").all()).toEqual(history);
    expect(database.query("SELECT * FROM weekly_recipe_rejections").all()).toEqual([]);
    expect(database.query("SELECT * FROM plan_meal_revisions").all()).toEqual([]);
    expect(createRecipeRepository(database).get(recipes[1]!.id)).toEqual(recipe);
  });
}

for (const endpoint of ["producer", "consumer"] as const) {
  test(`persisted prep ${endpoint} cannot be replaced without link revalidation`, () => {
    const { database, plan, recipes } = fixture();
    const target = endpoint === "producer" ? plan.meals[2]! : plan.meals[1]!;
    const producer = endpoint === "producer" ? recipes[1]! : recipes[0]!;
    database.query("INSERT INTO recipe_prep_links VALUES (?,?,?,?,?,?,?,?)").run("link:test", producer.id, target.id, "prep", "carrots", 50, "g", "Test");
    const before = database.query("SELECT total_changes() AS count").get();
    expect(() => previewPlanMealReplacement(database, { planId: plan.id, day: "tue" })).toThrow("preparation link endpoint");
    expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
  });
}

test("Sunday replacement scales target batch yield while scoring six exact saved servings", () => {
  const { database, plan, recipes } = fixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "sun", packageEstimates: [{ normalizedIngredient: "beans", unit: "g", packageQuantity: 250, perishability: "perishable" }] });
  const candidate = preview.candidates.find(({ recipeId }) => recipeId === recipes[7]!.id)!;
  expect(candidate.meal.servings).toBe(8);
  expect(candidate.ingredientDelta.additions).toEqual([{ normalizedIngredient: "beans", unit: "g", quantity: 200 }]);
  expect(candidate.ingredientDelta.removals).toEqual([{ normalizedIngredient: "carrots", unit: "g", quantity: 100 }]);
  expect(candidate.score.predictedRemainders.find(({ normalizedIngredient }) => normalizedIngredient === "beans")).toMatchObject({ demand: 200, remainder: 50 });
  const saved = confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(saved.meals[6]!.servings).toBe(8);
});

test("offer deltas honor shopping validity, confidence and configured stores", () => {
  const { database, plan, recipes } = fixture();
  const deals = [
    { recipeId: recipes[1]!.id, storeId: "netto", value: 2, validUntil: "2026-10-03", confidence: "high" as const },
    { recipeId: recipes[7]!.id, storeId: "netto", value: 5, validUntil: "2026-10-03", confidence: "high" as const },
    { recipeId: recipes[7]!.id, storeId: "netto", value: 100, validUntil: "2026-10-02", confidence: "high" as const },
    { recipeId: recipes[7]!.id, storeId: "netto", value: 100, validUntil: "2026-10-03", confidence: "low" as const },
    { recipeId: recipes[7]!.id, storeId: "unconfigured", value: 100, validUntil: "2026-10-03", confidence: "high" as const },
  ];
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue", dealSignals: deals });
  const candidate = preview.candidates.find(({ recipeId }) => recipeId === recipes[7]!.id)!;
  expect(candidate.dealDelta).toEqual({ additions: [deals[1]!], removals: [deals[0]!], value: 3 });
  expect(candidate.score.dealValue).toBe(5);
});

function linkedCandidateFixture() {
  const fixtureData = fixture();
  const { database, plan, recipes, repository } = fixtureData;
  createRecipeRepository(database).import({ ...input(8), extraMealServings: 0, suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "prepAhead"] });
  const future = repository.saveDraft({ weekStart: "2026-10-12", shoppingDate: "2026-10-10", plannedAt: "2026-10-01T12:00:00.000Z", seed: "future",
    meals: plan.meals.map((meal, index) => ({ day: meal.day, date: `2026-10-${12 + index}`, recipeId: meal.recipeId, servings: meal.servings, rationale: [...meal.rationale], prepLinks: [] })), score: plan.score });
  const link = createPrepLinkRepository(database).add({ sourceRecipeId: recipes[8]!.id, targetMealId: future.meals[0]!.id, kind: "prep", normalizedIngredient: "carrots", quantity: 50, unit: "g", note: "Prep carrots" });
  return { ...fixtureData, future, link };
}

test("new verified prep source is eligible and persists its validated link IDs and demand", () => {
  const { database, plan, recipes, link } = linkedCandidateFixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "sun" });
  const candidate = preview.candidates.find(({ recipeId }) => recipeId === recipes[8]!.id);
  expect(candidate).toBeDefined();
  expect(candidate!.meal.prepLinks).toEqual([link.id]);
  expect(candidate!.meal.rationale).toContain("Prep carrots for 2026-10-12");
  expect(candidate!.ingredientDelta.additions).toEqual([{ normalizedIngredient: "carrots", quantity: 50, unit: "g" }]);
  const saved = confirmPlanMealReplacement(database, preview, { recipeId: recipes[8]!.id, recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(saved.meals[6]!.prepLinks).toEqual([link.id]);
});

test("weekday replacement does not consume or score a Sunday prep reservation", () => {
  const { database, plan, recipes } = linkedCandidateFixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  const candidate = preview.candidates.find(({ recipeId }) => recipeId === recipes[8]!.id)!;
  expect(candidate.meal.prepLinks).toEqual([]);
  expect(candidate.ingredientDelta.additions).toEqual([]);
  expect(candidate.score.explanations.join("\n")).not.toContain("Prep carrots");
  const saved = confirmPlanMealReplacement(database, preview, { recipeId: candidate.recipeId, recordedAt: "2026-10-02T12:00:00.000Z" });
  expect(saved.meals[1]!.prepLinks).toEqual([]);
});

test("verified prep alternative still includes any partial extra batch yield", () => {
  const { database, plan, recipes } = linkedCandidateFixture();
  createRecipeRepository(database).import({ ...input(8), extraMealServings: 2, suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "prepAhead"] });
  const candidate = previewPlanMealReplacement(database, { planId: plan.id, day: "sun" }).candidates.find(({ recipeId }) => recipeId === recipes[8]!.id)!;
  expect(candidate.meal.servings).toBe(6);
  expect(candidate.ingredientDelta.additions).toEqual([{ normalizedIngredient: "carrots", quantity: 100, unit: "g" }]);
});

for (const [label, override, day] of [
  ["servings evidence", { servings: null }, "tue"],
  ["time evidence", { totalMinutes: null, prepMinutes: null, cookMinutes: null }, "thu"],
  ["serving modes", { suitabilityTags: ["quick"] }, "tue"],
  ["easy classification", { suitabilityTags: ["keepWarm", "reheatFriendly"] }, "thu"],
  ["Sunday batch requirement", { extraMealServings: 0 }, "sun"],
  ["review", { needsReview: true }, "tue"],
] as const) {
  test(`target-day replacement enforces ${label}`, () => {
    const { database, plan, recipes } = fixture();
    createRecipeRepository(database).import({ ...input(7), ...override });
    const preview = previewPlanMealReplacement(database, { planId: plan.id, day });
    expect(preview.candidates.map(({ recipeId }) => recipeId)).not.toContain(recipes[7]!.id);
    expect(preview.blockedCandidates.find(({ recipeId }) => recipeId === recipes[7]!.id)?.reasons.length).toBeGreaterThan(0);
  });
}

test("household ingredient and dietary restrictions are hard replacement constraints", () => {
  const { database, plan, recipes } = fixture();
  database.query("INSERT INTO household_rules VALUES ('rule:household:disliked_ingredient:beans', NULL, 'disliked_ingredient', 'beans', 'beans', '2026-10-02T12:00:00.000Z')").run();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  expect(preview.candidates.map(({ recipeId }) => recipeId)).not.toContain(recipes[7]!.id);
  expect(preview.blockedCandidates.find(({ recipeId }) => recipeId === recipes[7]!.id)?.reasons).toContain("contains disliked ingredient: beans");
});

test("uncertain ingredients remain explicit warnings rather than invented exact deltas", () => {
  const { database, plan, recipes } = fixture();
  createRecipeRepository(database).import({ ...input(7), ingredients: [{ rawText: "some beans", normalizedName: "beans", quantity: null, unit: null, uncertain: true }] });
  const candidate = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" }).candidates.find(({ recipeId }) => recipeId === recipes[7]!.id)!;
  expect(candidate.ingredientDelta.additions).toEqual([]);
  expect(candidate.ingredientDelta.warnings).toEqual(["Replacement 7: some beans cannot be quantified exactly"]);
});

test("confirmation revalidates a future prep target capacity under the write transaction", () => {
  const { database, plan, recipes, future } = linkedCandidateFixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "sun" });
  const targetRecipe = createRecipeRepository(database).get(future.meals[0]!.recipeId)!;
  createRecipeRepository(database).import({ ...input(0), ingredients: [{ ...targetRecipe.ingredients[0]!, quantity: 10 }] });
  const before = database.query("SELECT total_changes() AS count").get();
  expect(() => confirmPlanMealReplacement(database, preview, { recipeId: recipes[8]!.id, recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("Stale");
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
});

test("confirmation refuses a plan that is no longer current for the same week", () => {
  const { database, plan, recipes, repository } = fixture();
  repository.accept(plan.id, "2026-10-02T10:00:00.000Z");
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  repository.saveDraft({ weekStart: plan.weekStart, shoppingDate: plan.shoppingDate, plannedAt: plan.plannedAt, seed: "new-draft",
    meals: plan.meals.map(({ day, date, recipeId, servings, rationale, prepLinks }) => ({ day, date, recipeId, servings, rationale, prepLinks })), score: plan.score });
  const before = database.query("SELECT total_changes() AS count").get();
  expect(() => confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("no longer current");
  expect(database.query("SELECT total_changes() AS count").get()).toEqual(before);
});

test("candidate ranking favors avoiding recent repetition before favorites when waste and deals tie", () => {
  const { database, plan, recipes, repository } = fixture();
  createRecipeRepository(database).import({ ...input(7), preference: "favorite", ingredients: input(8).ingredients });
  const previous = repository.saveDraft({ weekStart: "2026-09-28", shoppingDate: "2026-09-26", plannedAt: plan.plannedAt, seed: "previous",
    meals: plan.meals.map((meal, index) => ({ day: meal.day, date: ["2026-09-28", "2026-09-29", "2026-09-30", "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04"][index]!, recipeId: index === 1 ? recipes[7]!.id : meal.recipeId, servings: meal.servings, rationale: [...meal.rationale], prepLinks: [] })), score: plan.score });
  repository.accept(previous.id, "2026-10-01T12:00:00.000Z");
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  expect(preview.candidates[0]!.recipeId).toBe(recipes[8]!.id);
});

test("a silently ignored target update rolls back rather than recording false replacement success", () => {
  const { database, plan, recipes, repository } = fixture();
  const preview = previewPlanMealReplacement(database, { planId: plan.id, day: "tue" });
  database.exec("CREATE TRIGGER ignore_replacement BEFORE UPDATE OF recipe_id ON plan_meals BEGIN SELECT RAISE(IGNORE); END;");
  expect(() => confirmPlanMealReplacement(database, preview, { recipeId: recipes[7]!.id, recordedAt: "2026-10-02T12:00:00.000Z" })).toThrow("Target meal update failed");
  expect(repository.get(plan.id)).toEqual(plan);
  expect(database.query("SELECT * FROM weekly_recipe_rejections").all()).toEqual([]);
  expect(database.query("SELECT * FROM plan_meal_revisions").all()).toEqual([]);
});






