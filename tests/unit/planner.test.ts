import { describe, expect, test } from "bun:test";
import { DIETARY_TAGS } from "../../src/domain/recipe";
import {
  evaluateRecipeForDay,
  generateWeeklyPlan,
  scoreWeeklyRecipes,
  type PlannerDayProfile,
  type PlannerRecipe,
} from "../../src/domain/planner";

function recipe(overrides: Partial<PlannerRecipe> = {}): PlannerRecipe {
  return {
    id: `recipe:${"1".repeat(64)}`,
    sourceId: "example",
    title: "Test recipe",
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 20,
    totalMinutes: 30,
    cuisineTags: ["danish"],
    proteinTag: "legume",
    dietaryTags: ["vegetarian"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly"],
    extraMealServings: 4,
    preference: "neutral",
    needsReview: false,
    ingredients: [{
      rawText: "500 g carrots",
      normalizedName: "carrots",
      quantity: 500,
      unit: "g",
      uncertain: false,
    }],
    ...overrides,
  };
}

const context = {
  householdServings: 4,
  enabledSourceIds: new Set(["example"]),
  dietaryRestrictions: [] as string[],
  dislikedIngredients: [] as string[],
};

const dayProfiles: readonly PlannerDayProfile[] = [
  { day: "mon", maxTotalMinutes: 60, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "tue", maxTotalMinutes: null, requiredServingModes: ["keep-warm", "reheat"], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "wed", maxTotalMinutes: null, requiredServingModes: ["reheat"], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "thu", maxTotalMinutes: 30, requiredServingModes: [], easyOnly: true, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "fri", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "sat", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "sun", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 1, prepLinkSatisfiesMinimum: true },
];

describe("planner hard constraints", () => {
  test("recognizes every canonical dietary tag as a required classification", () => {
    for (const tag of DIETARY_TAGS) {
      const missing = recipe({ dietaryTags: tag === "vegetarian" ? ["low-salt"] : ["vegetarian"] });
      expect(evaluateRecipeForDay(missing, dayProfiles[0]!, { ...context, dietaryRestrictions: [tag] }).eligible).toBe(false);
    }
  });

  test("splits combined dietary classifications before checking every required tag", () => {
    const unsafe = recipe({ dietaryTags: ["low-salt"], ingredients: [{ rawText: "pork and wheat", normalizedName: "pork", quantity: 100, unit: "g", uncertain: false }] });
    for (const dietaryRestrictions of [["Vegetarian", "gluten-free"], ["Vegetarian, gluten-free"], ["Vegetarian; gluten-free"]]) {
      expect(evaluateRecipeForDay(unsafe, dayProfiles[0]!, { ...context, dietaryRestrictions }).eligible).toBe(false);
    }
    const safe = recipe({ dietaryTags: ["vegetarian", "gluten-free"] });
    expect(evaluateRecipeForDay(safe, dayProfiles[0]!, { ...context, dietaryRestrictions: ["Vegetarian, gluten-free; no peanuts"] }).eligible).toBe(true);
    expect(evaluateRecipeForDay(recipe({ dietaryTags: ["vegetarian"] }), dayProfiles[0]!, { ...context, dietaryRestrictions: ["Vegetarian, gluten-free"] }).eligible).toBe(false);
  });

  test("rejects recipes that cannot prove configured day constraints", () => {
    const monday = {
      day: "mon" as const,
      maxTotalMinutes: 60,
      requiredServingModes: [] as const,
      easyOnly: false,
      minimumExtraMeals: 0,
      prepLinkSatisfiesMinimum: false,
    };
    const tuesday = {
      ...monday,
      day: "tue" as const,
      maxTotalMinutes: null,
      requiredServingModes: ["keep-warm", "reheat"] as const,
    };
    const thursday = { ...monday, day: "thu" as const, maxTotalMinutes: 30, easyOnly: true };
    const sunday = {
      ...monday,
      day: "sun" as const,
      maxTotalMinutes: null,
      minimumExtraMeals: 1,
      prepLinkSatisfiesMinimum: true,
    };

    expect(evaluateRecipeForDay(recipe({ totalMinutes: null, prepMinutes: 20, cookMinutes: null }), monday, context))
      .toEqual({ eligible: false, reasons: ["total cooking time is unknown"] });
    expect(evaluateRecipeForDay(recipe({ totalMinutes: 61 }), monday, context))
      .toEqual({ eligible: false, reasons: ["total cooking time 61 min exceeds 60 min"] });
    expect(evaluateRecipeForDay(recipe({ suitabilityTags: [] }), tuesday, context))
      .toEqual({ eligible: false, reasons: ["requires one of: keep-warm, reheat"] });
    expect(evaluateRecipeForDay(recipe({ suitabilityTags: ["keepWarm"] }), tuesday, context).eligible).toBe(true);
    expect(evaluateRecipeForDay(recipe({ suitabilityTags: [] }), thursday, context))
      .toEqual({ eligible: false, reasons: ["recipe is not classified as easy"] });
    expect(evaluateRecipeForDay(recipe({ extraMealServings: 3 }), sunday, context))
      .toEqual({ eligible: false, reasons: ["needs 4 extra serving(s) or an explicit preparation link"] });
  });

  test("enforces review, source, preference, dietary, and ingredient rules", () => {
    const friday = {
      day: "fri" as const,
      maxTotalMinutes: null,
      requiredServingModes: [] as const,
      easyOnly: false,
      minimumExtraMeals: 0,
      prepLinkSatisfiesMinimum: false,
    };

    expect(evaluateRecipeForDay(recipe({ needsReview: true }), friday, context).reasons)
      .toContain("recipe still needs review");
    expect(evaluateRecipeForDay(recipe({ sourceId: "disabled" }), friday, context).reasons)
      .toContain("recipe source is disabled");
    expect(evaluateRecipeForDay(recipe({ preference: "disliked" }), friday, context).reasons)
      .toContain("recipe is disliked");
    expect(evaluateRecipeForDay(recipe({ servings: null }), friday, context).reasons)
      .toContain("recipe servings are unknown");
    expect(evaluateRecipeForDay(recipe({ ingredients: [] }), friday, context).reasons)
      .toContain("recipe has no ingredient evidence");
    expect(evaluateRecipeForDay(recipe({ dietaryTags: [] }), friday, context).reasons)
      .toContain("recipe has no dietary classification");
    expect(evaluateRecipeForDay(
      recipe({ dietaryTags: ["vegetarian"] }),
      friday,
      { ...context, dietaryRestrictions: ["Gluten free"] },
    ).reasons).toContain("does not prove dietary restriction: Gluten free");
    expect(evaluateRecipeForDay(
      recipe({ dietaryTags: ["vegan"] }),
      friday,
      { ...context, dietaryRestrictions: ["Vegetarian"] },
    ).eligible).toBe(true);
    expect(evaluateRecipeForDay(
      recipe({ ingredients: [{
        rawText: "100 g black olives",
        normalizedName: "black olives",
        quantity: 100,
        unit: "g",
        uncertain: false,
      }] }),
      friday,
      { ...context, dislikedIngredients: ["Olives"] },
    ).reasons).toContain("contains disliked ingredient: Olives");
    expect(evaluateRecipeForDay(
      recipe({ ingredients: [{
        rawText: "50 g peanuts",
        normalizedName: "peanuts",
        quantity: 50,
        unit: "g",
        uncertain: false,
      }] }),
      friday,
      { ...context, dietaryRestrictions: ["Peanuts"] },
    ).reasons).toContain("contains restricted ingredient: Peanuts");
    expect(evaluateRecipeForDay(recipe({ ingredients: [{ rawText: "50 g peanuts", normalizedName: "nuts", quantity: 50, unit: "g", uncertain: false }] }), friday,
      { ...context, dietaryRestrictions: ["No peanuts, tree nuts; sesame"] }).eligible).toBe(false);
    expect(evaluateRecipeForDay(recipe({ ingredients: [{ rawText: "100 g capers", normalizedName: "capers", quantity: 100, unit: "g", uncertain: false }] }), friday,
      { ...context, dislikedIngredients: ["Olives, capers; anchovies"] }).eligible).toBe(false);
  });
});

describe("weekly planner", () => {
  test("does not attach or credit Sunday prep reservations to a weekday occurrence", () => {
    const recipes = Array.from({ length: 7 }, (_, index) => recipe({ id: `recipe:${index.toString(16).repeat(64)}`, totalMinutes: index === 0 ? 55 : 25 }));
    const prepLinks = [{ id: `prep:${"a".repeat(64)}`, sourceRecipeId: recipes[0]!.id, targetMealId: `meal:${"b".repeat(64)}`, targetDate: "2026-10-12", kind: "prep" as const, normalizedIngredient: "carrots", quantity: 200, unit: "g", note: "Sunday-only prep" }];
    const result = generateWeeklyPlan({
      weekStart: "2026-10-05", plannedAt: "2026-10-01T12:00:00.000Z", seed: "weekday-prep", recipes,
      dayProfiles: dayProfiles.map((profile) => ({ ...profile, maxTotalMinutes: profile.day === "mon" ? 60 : 30 })),
      context: { ...context, verifiedPrepRecipeIds: new Set([recipes[0]!.id]), verifiedPrepLinks: prepLinks },
      scoreContext: { householdServings: 4, pantryItems: [], packageEstimates: [{ normalizedIngredient: "carrots", unit: "g", packageQuantity: 1000, perishability: "perishable" }], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set(), prepLinks },
    });
    if (result.status !== "generated") throw new Error("Expected a feasible week");
    expect(result.plan.meals[0]!.recipeId).toBe(recipes[0]!.id);
    expect(result.plan.meals[0]!.prepLinks).toEqual([]);
    expect(result.plan.score.predictedRemainders[0]!.demand).toBe(4000);
    expect(result.plan.score.explanations.join("\n")).not.toContain("Sunday-only prep");
  });

  test("converts measured pantry kg and fractions to canonical ingredient units", () => {
    const score = scoreWeeklyRecipes([recipe()], {
      householdServings: 4, pantryItems: [{ normalizedName: "carrots", quantity: "1/2 kg" }],
      packageEstimates: [{ normalizedIngredient: "carrots", unit: "g", packageQuantity: 1000, perishability: "perishable" }],
      dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set(),
    });
    expect(score.predictedRemainders[0]!.pantryUsed).toBe(500);
    expect(score.predictedRemainders[0]!.packageCount).toBe(0);
    expect(score.pantryIngredientCount).toBe(1);
  });

  test("avoids recent repetition before rewarding favorites when waste and deals tie", () => {
    const recipes = Array.from({ length: 8 }, (_, index) => recipe({ id: `recipe:${index.toString(16).repeat(64)}`, preference: index === 7 ? "favorite" : "neutral" }));
    const result = generateWeeklyPlan({ weekStart: "2026-10-05", plannedAt: "2026-10-01T12:00:00.000Z", seed: "history", recipes, dayProfiles, context,
      scoreContext: { householdServings: 4, pantryItems: [], packageEstimates: [], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set([recipes[7]!.id]) },
    });
    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("Expected generated week");
    expect(result.plan.meals.map(({ recipeId }) => recipeId)).not.toContain(recipes[7]!.id);
  });

  test("persists explicit prep evidence and scores production for verified later consumption", () => {
    const recipes = Array.from({ length: 7 }, (_, index) => recipe({ id: `recipe:${index.toString(16).repeat(64)}`, extraMealServings: 0,
      suitabilityTags: index === 6 ? ["prepAhead"] : ["quick", "keepWarm", "reheatFriendly"],
    }));
    const prepLinks = [{ id: `prep:${"a".repeat(64)}`, sourceRecipeId: recipes[6]!.id, targetMealId: `meal:${"b".repeat(64)}`, targetDate: "2026-10-12", kind: "prep" as const, normalizedIngredient: "carrots", quantity: 200, unit: "g", note: "Chop carrots for Monday" }];
    const result = generateWeeklyPlan({ weekStart: "2026-10-05", plannedAt: "2026-10-01T12:00:00.000Z", seed: "prep", recipes, dayProfiles,
      context: { ...context, verifiedPrepRecipeIds: new Set([recipes[6]!.id]), verifiedPrepLinks: prepLinks },
      scoreContext: { householdServings: 4, pantryItems: [], packageEstimates: [{ normalizedIngredient: "carrots", unit: "g", packageQuantity: 1000, perishability: "perishable" }], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set(), prepLinks },
    });
    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("Expected prep week");
    expect(result.plan.meals[6]!.prepLinks).toEqual([prepLinks[0]!.id]);
    expect(result.plan.meals[6]!.rationale).not.toContain("provides 0 extra serving(s)");
    expect(result.plan.score.predictedRemainders[0]!.demand).toBe(3700);
    expect(result.plan.score.explanations.join("\n")).toContain("Chop carrots for Monday");
  });

  test("requires verified future prep links and includes batch servings in demand", () => {
    const sunday = dayProfiles[6]!;
    const prepRecipe = recipe({ extraMealServings: 0, suitabilityTags: ["prepAhead"] });
    expect(evaluateRecipeForDay(prepRecipe, sunday, context).eligible).toBe(false);
    expect(evaluateRecipeForDay(prepRecipe, sunday, { ...context, verifiedPrepRecipeIds: new Set([prepRecipe.id]) }).eligible).toBe(true);
    expect(evaluateRecipeForDay(prepRecipe, { ...sunday, prepLinkSatisfiesMinimum: false }, { ...context, verifiedPrepRecipeIds: new Set([prepRecipe.id]) }).eligible).toBe(false);
    const recipes = Array.from({ length: 7 }, (_, index) => recipe({ id: `recipe:${index.toString(16).repeat(64)}` }));
    const result = generateWeeklyPlan({ weekStart: "2026-10-05", plannedAt: "2026-10-01T12:00:00.000Z", seed: "yield", recipes, dayProfiles, context });
    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("Expected generated week");
    expect(result.plan.meals[6]!.servings).toBe(8);
    const score = scoreWeeklyRecipes(recipes, {
      householdServings: 4, pantryItems: [], packageEstimates: [{ normalizedIngredient: "carrots", unit: "g", packageQuantity: 1000, perishability: "perishable" }], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set(), recipeServings: new Map(result.plan.meals.map((meal) => [meal.recipeId, meal.servings])),
    });
    expect(score.predictedRemainders[0]!.demand).toBe(4000);
  });

  test("keeps a feasible vegetarian week even when the scoring beam drops the only vegetarian", () => {
    const recipes = Array.from({ length: 15 }, (_, index) => recipe({
      id: `recipe:${index.toString(16).padStart(64, "0")}`,
      title: `Candidate ${index}`,
      dietaryTags: index === 14 ? ["vegetarian"] : ["low-salt"],
      ingredients: [{ rawText: "100 g vegetables", normalizedName: index === 14 ? "specialty" : "carrots", quantity: 100, unit: "g", uncertain: false }],
    }));
    const result = generateWeeklyPlan({ weekStart: "2026-10-05", plannedAt: "2026-10-01T12:00:00.000Z", seed: "feasibility", recipes, dayProfiles, context });
    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("Expected feasible week");
    expect(result.plan.meals).toHaveLength(7);
    expect(result.plan.meals.some(({ recipeId }) => recipeId === recipes[14]!.id)).toBe(true);
    expect(generateWeeklyPlan({ weekStart: "2026-10-05", plannedAt: "2026-10-01T12:00:00.000Z", seed: "feasibility", recipes: [...recipes].reverse(), dayProfiles, context })).toEqual(result);
  });

  test("aggregates ingredients, pantry use, package remainders, and reuse explanations", () => {
    const recipes = [0, 1].map((index) => recipe({
      id: `recipe:${index.toString(16).repeat(64)}`,
      title: `Spinach ${index}`,
      ingredients: [{
        rawText: "300 g spinach",
        normalizedName: "spinach",
        quantity: 300,
        unit: "g",
        uncertain: false,
      }],
    }));

    const score = scoreWeeklyRecipes(recipes, {
      householdServings: 4,
      pantryItems: [{ normalizedName: "spinach", quantity: "100 g" }],
      packageEstimates: [{
        normalizedIngredient: "spinach",
        unit: "g",
        packageQuantity: 500,
        perishability: "short-lived",
      }],
      dealSignals: [],
      preferredStoreIds: new Set(["netto"]),
      shoppingDate: "2026-10-03",
      recentRecipeIds: new Set(),
    });

    expect(score.predictedRemainders).toEqual([{
      normalizedIngredient: "spinach",
      unit: "g",
      demand: 600,
      pantryUsed: 100,
      packageQuantity: 500,
      packageCount: 1,
      remainder: 0,
      perishability: "short-lived",
    }]);
    expect(score.reuseIngredientCount).toBe(1);
    expect(score.pantryIngredientCount).toBe(1);
    expect(score.explanations).toContain("spinach is reused across Spinach 0 and Spinach 1");
  });

  test("creates a deterministic seven-day plan with a vegetarian meal", () => {
    const recipes = Array.from({ length: 8 }, (_, index) => recipe({
      id: `recipe:${index.toString(16).repeat(64)}`,
      title: `Recipe ${index}`,
      dietaryTags: index === 7 ? ["vegetarian"] : ["low-salt"],
    }));
    const input = {
      weekStart: "2026-10-05",
      plannedAt: "2026-10-01T12:00:00.000Z",
      seed: "family-seed",
      recipes,
      dayProfiles,
      context,
    };

    const first = generateWeeklyPlan(input);
    const second = generateWeeklyPlan(input);

    expect(first).toEqual(second);
    expect(first.status).toBe("generated");
    if (first.status !== "generated") throw new Error("expected a generated plan");
    expect(first.plan.weekStart).toBe("2026-10-05");
    expect(first.plan.shoppingDate).toBe("2026-10-03");
    expect(first.plan.meals.map(({ date }) => date)).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
      "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
    expect(new Set(first.plan.meals.map(({ recipeId }) => recipeId))).toHaveLength(7);
    expect(first.plan.meals.some(({ recipeId }) => recipeId === recipes[7]!.id)).toBe(true);
  });

  test("prefers a lower-waste week before a higher deal value", () => {
    const shared = Array.from({ length: 6 }, (_, index) => recipe({
      id: `recipe:${index.toString(16).repeat(64)}`,
      title: `Shared ${index}`,
      ingredients: [{ rawText: "100 g spinach", normalizedName: "spinach", quantity: 100, unit: "g", uncertain: false }],
    }));
    const lowerWaste = recipe({
      id: `recipe:${"a".repeat(64)}`,
      title: "Uses spinach remainder",
      ingredients: [{ rawText: "100 g spinach", normalizedName: "spinach", quantity: 100, unit: "g", uncertain: false }],
    });
    const highDealWaste = recipe({
      id: `recipe:${"b".repeat(64)}`,
      title: "Deal truffle",
      ingredients: [{ rawText: "100 g truffle", normalizedName: "truffle", quantity: 100, unit: "g", uncertain: false }],
    });

    const result = generateWeeklyPlan({
      weekStart: "2026-10-05",
      plannedAt: "2026-10-01T12:00:00.000Z",
      seed: "waste-first",
      recipes: [...shared, lowerWaste, highDealWaste],
      dayProfiles,
      context,
      scoreContext: {
        householdServings: 4,
        pantryItems: [],
        packageEstimates: [
          { normalizedIngredient: "spinach", unit: "g", packageQuantity: 500, perishability: "short-lived" },
          { normalizedIngredient: "truffle", unit: "g", packageQuantity: 500, perishability: "short-lived" },
        ],
        dealSignals: [{
          recipeId: highDealWaste.id,
          storeId: "netto",
          value: 100,
          validUntil: "2026-10-03",
          confidence: "high",
        }],
        preferredStoreIds: new Set(["netto"]),
        shoppingDate: "2026-10-03",
        recentRecipeIds: new Set(),
      },
    });

    expect(result.status).toBe("generated");
    if (result.status !== "generated") throw new Error("expected a generated plan");
    const selected = result.plan.meals.map(({ recipeId }) => recipeId);
    expect(selected).toContain(lowerWaste.id);
    expect(selected).not.toContain(highDealWaste.id);
    expect(result.plan.score.dealValue).toBe(0);
    expect(result.plan.score.explanations).toContain(
      "spinach is reused across Shared 0 and Shared 1 and Shared 2 and Shared 3 and Shared 4 and Shared 5 and Uses spinach remainder",
    );
  });

  test("explains when no valid vegetarian week exists", () => {
    const result = generateWeeklyPlan({
      weekStart: "2026-10-05",
      plannedAt: "2026-10-01T12:00:00.000Z",
      seed: "family-seed",
      recipes: Array.from({ length: 7 }, (_, index) => recipe({
        id: `recipe:${index.toString(16).repeat(64)}`,
        dietaryTags: ["low-salt"],
      })),
      dayProfiles,
      context,
    });

    expect(result).toEqual({
      status: "infeasible",
      reasons: ["No eligible vegetarian recipe can satisfy the week-wide minimum"],
    });
  });

  test("explains the blocking daily constraint when a day has no candidates", () => {
    const result = generateWeeklyPlan({
      weekStart: "2026-10-05",
      plannedAt: "2026-10-01T12:00:00.000Z",
      seed: "blocked-thursday",
      recipes: Array.from({ length: 7 }, (_, index) => recipe({
        id: `recipe:${index.toString(16).repeat(64)}`,
        dietaryTags: index === 0 ? ["vegetarian"] : ["low-salt"],
        suitabilityTags: ["keepWarm", "reheatFriendly", "batchCook"],
      })),
      dayProfiles,
      context,
    });

    expect(result).toEqual({
      status: "infeasible",
      reasons: ["No eligible recipe can satisfy thu: recipe is not classified as easy (7 candidates)"],
    });
  });
});
