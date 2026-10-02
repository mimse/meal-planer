import { describe, expect, test } from "bun:test";
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
  });
});

describe("weekly planner", () => {
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
