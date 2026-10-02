import { describe, expect, test } from "bun:test";
import { aggregateShoppingIngredients, calculatePackageReuse } from "../../src/domain/shopping-list";
import type { Recipe, RecipeIngredient } from "../../src/infrastructure/recipe-repository";
import type { PlanMeal, WeeklyPlan } from "../../src/infrastructure/plan-repository";
import type { VerifiedPrepLink } from "../../src/domain/planner";

function ingredient(quantity = 500, unit = "g", normalizedName = "carrots"): RecipeIngredient {
  return { rawText: `${quantity} ${unit} ${normalizedName}`, normalizedName, quantity, unit, uncertain: false };
}
function recipe(id = "recipe:a", ingredients = [ingredient()], overrides: Partial<Recipe> = {}): Recipe {
  return { id, sourceId: "example", sourceUrl: `https://example.com/${id}`, canonicalUrl: `https://example.com/${id}`,
    title: id, normalizedTitle: id, author: null, servings: 4, prepMinutes: 5, cookMinutes: 10, totalMinutes: 15,
    cuisineTags: [], proteinTag: null, dietaryTags: [], suitabilityTags: [], extraMealServings: 4,
    preference: "neutral", needsReview: false, parserVersion: "test", fetchedAt: "2026-10-01T00:00:00Z",
    rawSourcePayload: {}, sourceEvidence: {}, ingredients, instructions: [], ...overrides };
}
function meal(id = "meal:sun", overrides: Partial<PlanMeal> = {}): PlanMeal {
  return { id, day: "sun", date: "2026-10-11", recipeId: "recipe:a", servings: 8,
    locked: false, rationale: [], prepLinks: [], contentHash: "hash", ...overrides };
}
function plan(meals = [meal()]): WeeklyPlan {
  return { id: "plan:test", weekStart: "2026-10-05", shoppingDate: "2026-10-03", plannedAt: "2026-10-02T12:00:00Z",
    status: "draft", seed: "test", score: {} as WeeklyPlan["score"], meals };
}
function link(overrides: Partial<VerifiedPrepLink> = {}): VerifiedPrepLink {
  return { id: "link:a", sourceRecipeId: "recipe:a", targetMealId: "meal:future", targetDate: "2026-10-12",
    kind: "prep", normalizedIngredient: "carrots", quantity: 200, unit: "g", note: "Reviewed prep", ...overrides };
}

describe("shopping aggregation", () => {
  test("validates package totals and units rather than tracing contradictory demand", () => {
    const item = aggregateShoppingIngredients({ plan: plan(), recipes: [recipe()], pantry: [] }).items[0]!;
    expect(() => calculatePackageReuse({ ...item, preparedDeduction: 200 }, 500)).toThrow(/inconsistent|deduction/i);
    expect(() => calculatePackageReuse({ ...item, contributions: [{ ...item.contributions[0]!, unit: "ml" }] }, 500)).toThrow(/unit/i);
    expect(() => calculatePackageReuse({ ...item, contributions: [{ ...item.contributions[0]!, date: "invalid" }] }, 500)).toThrow(/date/i);
  });
  test("does not open a ghost package for floating point carry or deduction dust", () => {
    const recipes = [recipe("recipe:a", [ingredient(0.2)]), recipe("recipe:b", [ingredient(0.1)])];
    const meals = [meal("early", { date: "2026-10-05", servings: 4 }),
      meal("late", { recipeId: "recipe:b", date: "2026-10-06", servings: 4 })];
    const item = aggregateShoppingIngredients({ plan: plan(meals), recipes, pantry: [] }).items[0]!;
    const packages = calculatePackageReuse(item, 0.3);
    expect(packages.packageCount).toBe(1);
    expect(packages.remainder).toBe(0);
    expect(packages.uses[0]!.quantity).toBeCloseTo(0.1, 15);
    const covered = aggregateShoppingIngredients({ plan: plan(meals), recipes, pantry: [{ normalizedName: "carrots", quantity: "0.3 g" }] }).items[0]!;
    expect(covered.purchaseQuantity).toBe(0);
    expect(calculatePackageReuse(covered, 0.3).packageCount).toBe(0);
    const prepared = aggregateShoppingIngredients({ plan: plan([meal("meal:future", { date: "2026-10-12", servings: 4 })]),
      recipes: [recipe("recipe:a", [ingredient(0.1), ingredient(0.2)])], pantry: [],
      incomingLinks: [{ link: link({ quantity: 0.3 }), producerMealId: "producer", producerDate: "2026-10-11" }] }).items[0]!;
    expect(prepared.purchaseQuantity).toBe(0);
    expect(calculatePackageReuse(prepared, 0.3).packageCount).toBe(0);
  });
  test("refuses conflicting exact recipe or link identities and rejects invalid producer dates", () => {
    expect(() => aggregateShoppingIngredients({ plan: plan(), recipes: [recipe(), recipe("recipe:a", [ingredient(600)])], pantry: [] })).toThrow(/ambiguous|duplicate/i);
    const target = meal("meal:future", { date: "2026-10-12", servings: 4 });
    const incoming = [{ link: link(), producerMealId: "producer", producerDate: "2026-10-11" },
      { link: link({ quantity: 250 }), producerMealId: "producer", producerDate: "2026-10-11" }];
    expect(() => aggregateShoppingIngredients({ plan: plan([target]), recipes: [recipe()], pantry: [], incomingLinks: incoming })).toThrow(/conflict|duplicate/i);
    expect(() => aggregateShoppingIngredients({ plan: plan([meal("source", { prepLinks: ["link:a"] })]), recipes: [recipe()], pantry: [],
      producingLinks: [link(), link({ quantity: 250 })] })).toThrow(/conflict|duplicate/i);
    for (const producerDate of ["", "2026-02-30", "yesterday", "2026-10-12"]) {
      const result = aggregateShoppingIngredients({ plan: plan([target]), recipes: [recipe()], pantry: [],
        incomingLinks: [{ link: link(), producerMealId: "producer", producerDate }] });
      expect(result.items[0]!.preparedDeduction).toBe(0);
      expect(result.warnings.length).toBeGreaterThan(0);
    }
  });
  test("keeps stable identities and sums when all input arrays including raw evidence are reversed", () => {
    const raw = [ingredient(0.1), ingredient(0.2), ingredient(0.3),
      { ...ingredient(), rawText: "pepper to taste", uncertain: true },
      { ...ingredient(), rawText: "salt to taste", uncertain: true }];
    const recipes = [recipe("recipe:a", raw)];
    const meals = [meal("z", { servings: 4 }), meal("a", { day: "mon", date: "2026-10-05", servings: 4 })];
    const pantry = [{ normalizedName: "carrots", quantity: "0.1 g" }, { normalizedName: "carrots", quantity: "0.2 g" }, { normalizedName: "carrots", quantity: "0.3 g" }];
    const before = JSON.stringify({ recipes, meals, pantry });
    const result = aggregateShoppingIngredients({ plan: plan(meals), recipes, pantry });
    expect(aggregateShoppingIngredients({ plan: plan([...meals].reverse()), recipes: [recipe("recipe:a", [...raw].reverse())], pantry: [...pantry].reverse() })).toEqual(result);
    expect(JSON.stringify({ recipes, meals, pantry })).toBe(before);
    const incompatible = aggregateShoppingIngredients({ plan: plan(), recipes: [recipe("recipe:a", [ingredient(200, "g"), ingredient(100, "ml")])],
      pantry: [{ normalizedName: "carrots", quantity: "50 ml" }, { normalizedName: "carrots", quantity: "ca. 1 kg" }] });
    expect(incompatible.items.find((item) => item.unit === "g")!.pantryDeduction).toBe(0);
    expect(incompatible.items.find((item) => item.unit === "ml")!.pantryDeduction).toBe(50);
    expect(incompatible.items.every((item) => item.warnings.some((warning) => /pantry/i.test(warning)))).toBe(true);
  });
  test("package arithmetic refuses unknown or invalid values and handles floating point boundaries", () => {
    const item = aggregateShoppingIngredients({ plan: plan([meal("only", { servings: 4 })]),
      recipes: [recipe("recipe:a", [ingredient(0.1 + 0.2)])], pantry: [] }).items[0]!;
    expect(calculatePackageReuse(item, 0.1).packageCount).toBe(3);
    expect(calculatePackageReuse(item, 0.1).remainder).toBe(0);
    for (const value of [0, -1, NaN, Infinity, Number.MIN_VALUE]) expect(() => calculatePackageReuse(item, value)).toThrow(/quantity|overflow/i);
    expect(() => calculatePackageReuse({ ...item, purchaseQuantity: null }, 100)).toThrow(/unknown|quantity/i);
    expect(() => calculatePackageReuse({ ...item, contributions: [{ ...item.contributions[0]!, quantity: Infinity }] }, 100)).toThrow(/quantity|overflow/i);
    expect(() => calculatePackageReuse({ ...item, contributions: [{ ...item.contributions[0]!, preparedDeduction: 100 }] }, 100)).toThrow(/quantity|deduction/i);
    const zero = aggregateShoppingIngredients({ plan: plan(), recipes: [recipe()], pantry: [{ normalizedName: "carrots", quantity: "1 kg" }] }).items[0]!;
    expect(calculatePackageReuse(zero, 500)).toEqual({ packageCount: 0, purchasedQuantity: 0, remainder: 0, uses: [] });
  });
  test("refuses to invent later-consumer quantities when contributions are unquantified", () => {
    const item = aggregateShoppingIngredients({ plan: plan([meal("early", { date: "2026-10-05", servings: 4 }),
      meal("late", { date: "2026-10-06", servings: 4 })]), recipes: [recipe("recipe:a", [ingredient(350)])], pantry: [] }).items[0]!;
    const contributions = item.contributions.map((entry) => ({ ...entry, quantity: null }));
    contributions.push(contributions[0]!);
    expect(() => calculatePackageReuse({ ...item, contributions }, 500)).toThrow(/unknown|unquantified/i);
  });
  test("traces package remainder chronologically across meals after incoming and pantry deductions", () => {
    const early = meal("early", { day: "mon", date: "2026-10-05", servings: 4 });
    const late = meal("late", { day: "wed", date: "2026-10-07", servings: 4 });
    const final = meal("final", { day: "fri", date: "2026-10-09", servings: 4 });
    const input = { plan: plan([final, late, early]), recipes: [recipe("recipe:a", [ingredient(200), ingredient(150)])],
      pantry: [{ normalizedName: "carrots", quantity: "100 g" }],
      incomingLinks: [{ link: link({ targetMealId: late.id, targetDate: late.date, quantity: 150 }), producerMealId: "previous", producerDate: "2026-10-04" }] };
    const item = aggregateShoppingIngredients(input).items[0]!;
    const result = calculatePackageReuse(item, 500);
    expect(result).toEqual({ packageCount: 2, purchasedQuantity: 1000, remainder: 200,
      uses: [{ fromMealId: "early", toMealId: "late", quantity: 200, unit: "g" },
        { fromMealId: "early", toMealId: "final", quantity: 50, unit: "g" }] });
    expect(calculatePackageReuse({ ...item, contributions: [...item.contributions].reverse() }, 500)).toEqual(result);
    expect(result.uses.every((use) => use.fromMealId !== use.toMealId)).toBe(true);
  });
  test("refuses invalid quantities and overflow while preserving invalid serving evidence", () => {
    for (const value of [NaN, Infinity, -1, 0, Number.MAX_VALUE]) {
      expect(() => aggregateShoppingIngredients({ plan: plan(), recipes: [recipe("recipe:a", [ingredient(value)])], pantry: [] })).toThrow(/quantity|overflow/i);
    }
    for (const servings of [0, NaN, Infinity]) {
      const result = aggregateShoppingIngredients({ plan: plan(), recipes: [recipe("recipe:a", [ingredient()], { servings })], pantry: [] });
      expect(result.items[0]!.requiredQuantity).toBeNull();
      expect(result.warnings.join(" ")).toMatch(/servings/);
    }
    expect(() => aggregateShoppingIngredients({ plan: plan([meal("a"), meal("b")]),
      recipes: [recipe("recipe:a", [ingredient(Number.MAX_SAFE_INTEGER / 3)])], pantry: [] })).toThrow(/overflow/i);
    expect(() => aggregateShoppingIngredients({ plan: plan([meal("a", { prepLinks: ["link:a"] })]),
      recipes: [recipe()], pantry: [], producingLinks: [link({ quantity: Infinity })] })).toThrow(/quantity|overflow/i);
    expect(() => aggregateShoppingIngredients({ plan: plan([meal("meal:future", { date: "2026-10-12" })]),
      recipes: [recipe()], pantry: [], incomingLinks: [{ link: link({ quantity: NaN }), producerMealId: "p", producerDate: "2026-10-11" }] })).toThrow(/quantity|overflow/i);
  });
  test("deducts incoming prep only from its dated target contributions and caps excess before pantry", () => {
    const target = meal("meal:future", { day: "mon", date: "2026-10-12", servings: 4 });
    const other = meal("meal:other", { day: "tue", date: "2026-10-13", servings: 4 });
    const recipes = [recipe("recipe:a", [ingredient(100), ingredient(150)])];
    const incoming = [link({ quantity: 125 }), link({ id: "link:b", kind: "leftover", quantity: 300 }),
      link({ id: "wrong-date", targetDate: "2026-10-13" }), link({ id: "wrong-unit", unit: "ml" })]
      .map((link) => ({ link, producerMealId: "meal:producer", producerDate: "2026-10-11" }));
    incoming.push({ link: link({ id: "late" }), producerMealId: "meal:late", producerDate: "2026-10-14" });
    const input = { plan: plan([other, target]), recipes, pantry: [{ normalizedName: "carrots", quantity: "100 g" }], incomingLinks: incoming };
    const result = aggregateShoppingIngredients(input);
    expect(result.items[0]).toMatchObject({ requiredQuantity: 500, preparedDeduction: 250, pantryDeduction: 100, purchaseQuantity: 150 });
    expect(result.items[0]!.contributions.filter((entry) => entry.mealId === target.id).reduce((total, entry) => total + entry.preparedDeduction, 0)).toBe(250);
    expect(result.items[0]!.contributions.filter((entry) => entry.mealId === other.id).every((entry) => entry.preparedDeduction === 0)).toBe(true);
    expect(result.warnings.join(" ")).toMatch(/exceed|excess|capped/i);
    expect(aggregateShoppingIngredients({ ...input, incomingLinks: [...incoming].reverse(), plan: plan([target, other]) })).toEqual(result);
  });
  test("adds measured prep exactly once to the bound Sunday producer but never adds leftovers twice", () => {
    const prep = link({ quantity: 0.2, unit: "kg" });
    const leftovers = link({ id: "link:leftover", kind: "leftover", quantity: 300 });
    const meals = [meal("meal:mon", { day: "mon", date: "2026-10-05", servings: 4 }),
      meal("meal:sun", { prepLinks: [prep.id, leftovers.id] })];
    const result = aggregateShoppingIngredients({ plan: plan(meals), recipes: [recipe()], pantry: [], producingLinks: [prep, prep, leftovers] });
    expect(result.items[0]).toMatchObject({ requiredQuantity: 1700, purchaseQuantity: 1700 });
    const contributions = result.items[0]!.contributions;
    expect(contributions.filter((entry) => entry.kind === "prep")).toHaveLength(1);
    expect(contributions.find((entry) => entry.kind === "prep")).toMatchObject({ mealId: "meal:sun", quantity: 200,
      unit: "g", recipeId: "recipe:a", sourceUrl: "https://example.com/recipe:a" });
    expect(aggregateShoppingIngredients({ plan: plan(meals), recipes: [recipe()], pantry: [], producingLinks: [link({ id: "unbound" })] }).items[0]!.requiredQuantity).toBe(1500);
  });
  test("keeps every uncertain raw line separate and preserves unknown servings without guessing", () => {
    const unknown = { rawText: "salt to taste", normalizedName: "salt", quantity: null, unit: null, uncertain: true };
    const recipes = [recipe("recipe:a", [unknown, unknown, ingredient()]), recipe("recipe:b", [ingredient()], { servings: null })];
    const meals = [meal(), meal("meal:mon", { recipeId: "recipe:b", day: "mon", date: "2026-10-05" })];
    const result = aggregateShoppingIngredients({ plan: plan(meals), recipes, pantry: [] });
    expect(result.items).toHaveLength(4);
    const uncertain = result.items.filter((item) => item.requiredQuantity === null);
    expect(uncertain).toHaveLength(3);
    expect(new Set(uncertain.map((item) => item.key)).size).toBe(3);
    expect(uncertain.every((item) => item.purchaseQuantity === null && item.contributions.length === 1 && item.warnings.length > 0)).toBe(true);
    expect(result.items.flatMap((item) => item.contributions).map((entry) => entry.rawText).sort())
      .toEqual(["500 g carrots", "500 g carrots", "salt to taste", "salt to taste"]);
    expect(result.warnings.join(" ")).toMatch(/servings.*unknown|unknown.*servings/i);
    expect(aggregateShoppingIngredients({ plan: plan([...meals].reverse()), recipes: [...recipes].reverse(), pantry: [] })).toEqual(result);
    expect(() => aggregateShoppingIngredients({ plan: plan(), recipes: [recipe("recipe:A")], pantry: [] })).toThrow(/Missing recipe/);
  });
  test("canonicalizes fractional reviewed measurements without reparsing ambiguous numeric strings and deducts pantry once", () => {
    const recipes = [recipe("recipe:a", [ingredient(0.125, "kg", "  Ｃarrots  "), ingredient(0.001, "l", "milk")]),
      recipe("recipe:b", [ingredient(125, "g", "carrots"), ingredient(0.5, "cup", "milk")])];
    const meals = [meal("meal:mon", { day: "mon", date: "2026-10-05", servings: 2 }),
      meal("meal:tue", { day: "tue", date: "2026-10-06", recipeId: "recipe:b", servings: 4 })];
    const pantry = [{ normalizedName: "CARROTS", quantity: "1/8 kg" }, { normalizedName: "milk", quantity: "a little" }];
    const result = aggregateShoppingIngredients({ plan: plan(meals), recipes, pantry });
    expect(result.items.find((item) => item.normalizedIngredient === "carrots")).toMatchObject({
      unit: "g", requiredQuantity: 187.5, pantryDeduction: 125, purchaseQuantity: 62.5 });
    expect(result.items.filter((item) => item.normalizedIngredient === "milk").map((item) => [item.unit, item.requiredQuantity]).sort())
      .toEqual([["cup", 0.5], ["ml", 0.5]]);
    expect(result.warnings.join(" ")).toMatch(/pantry.*milk|milk.*pantry/i);
    expect(aggregateShoppingIngredients({ plan: plan([...meals].reverse()), recipes: [...recipes].reverse(), pantry: [...pantry].reverse() })).toEqual(result);
  });
  test("scales Sunday yield by the saved production servings and retains exact provenance", () => {
    const saved = recipe();
    const { items, warnings } = aggregateShoppingIngredients({ plan: plan(), recipes: [saved], pantry: [] });
    expect(warnings).toEqual([]);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ normalizedIngredient: "carrots", unit: "g", requiredQuantity: 1000,
      pantryDeduction: 0, preparedDeduction: 0, purchaseQuantity: 1000 });
    expect(items[0]!.key).toMatch(/[a-f0-9]{64}$/);
    expect(items[0]!.contributions).toEqual([{ mealId: "meal:sun", recipeId: saved.id, recipeTitle: saved.title,
      sourceUrl: saved.sourceUrl, day: "sun", date: "2026-10-11", rawText: "500 g carrots", quantity: 1000,
      unit: "g", preparedDeduction: 0, kind: "recipe" }]);
  });
});
