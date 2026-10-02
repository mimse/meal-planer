import { expect, test } from "bun:test";
import {
  evaluateRecipeForDay,
  generateWeeklyPlan,
  type PlannerDayProfile,
  type PlannerRecipe,
} from "../../src/domain/planner";

const dayProfiles: readonly PlannerDayProfile[] = [
  { day: "mon", maxTotalMinutes: 60, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "tue", maxTotalMinutes: null, requiredServingModes: ["keep-warm", "reheat"], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "wed", maxTotalMinutes: null, requiredServingModes: ["reheat"], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "thu", maxTotalMinutes: 30, requiredServingModes: [], easyOnly: true, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "fri", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "sat", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false },
  { day: "sun", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 1, prepLinkSatisfiesMinimum: false },
];

const context = {
  householdServings: 4,
  enabledSourceIds: new Set(["example"]),
  dietaryRestrictions: [] as string[],
  dislikedIngredients: [] as string[],
};

function random(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function generatedRecipes(seed: number): PlannerRecipe[] {
  const next = random(seed);
  return Array.from({ length: 9 }, (_, index) => {
    const suitabilityTags: PlannerRecipe["suitabilityTags"] = [
      ...(next() < 0.65 ? ["quick" as const] : []),
      ...(next() < 0.65 ? ["keepWarm" as const] : []),
      ...(next() < 0.65 ? ["reheatFriendly" as const] : []),
    ];
    return {
      id: `recipe:${index.toString(16).padStart(64, "0")}`,
      sourceId: "example",
      title: `Generated ${index}`,
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: [25, 45, 75][Math.floor(next() * 3)]!,
      cuisineTags: [],
      proteinTag: null,
      dietaryTags: next() < 0.25 ? ["vegetarian"] : ["low-salt"],
      suitabilityTags,
      extraMealServings: next() < 0.55 ? 4 : 0,
      preference: "neutral",
      needsReview: false,
      ingredients: [{
        rawText: `${100 + index} g carrots`,
        normalizedName: "carrots",
        quantity: 100 + index,
        unit: "g",
        uncertain: false,
      }],
    };
  });
}

function oracleHasAssignment(recipes: readonly PlannerRecipe[]): boolean {
  const eligible = dayProfiles.map((profile) => recipes
    .map((recipe, index) => ({ recipe, index }))
    .filter(({ recipe }) => evaluateRecipeForDay(recipe, profile, context).eligible));
  const search = (dayIndex: number, used: Set<number>, vegetarian: boolean): boolean => {
    if (dayIndex === dayProfiles.length) return vegetarian;
    for (const candidate of eligible[dayIndex]!) {
      if (used.has(candidate.index)) continue;
      used.add(candidate.index);
      const isVegetarian = candidate.recipe.dietaryTags.includes("vegetarian")
        || candidate.recipe.dietaryTags.includes("vegan");
      if (search(dayIndex + 1, used, vegetarian || isVegetarian)) return true;
      used.delete(candidate.index);
    }
    return false;
  };
  return search(0, new Set(), false);
}

test("generated planner cases agree with an independent exact assignment oracle", () => {
  for (let caseSeed = 1; caseSeed <= 40; caseSeed += 1) {
    const recipes = generatedRecipes(caseSeed);
    const input = {
      weekStart: "2026-10-05",
      plannedAt: "2026-10-02T10:00:00.000Z",
      seed: `property-${caseSeed}`,
      recipes,
      dayProfiles,
      context,
    };
    const expectedFeasible = oracleHasAssignment(recipes);
    const result = generateWeeklyPlan(input);
    expect(result.status, `case ${caseSeed}`).toBe(expectedFeasible ? "generated" : "infeasible");
    expect(generateWeeklyPlan({ ...input, recipes: [...recipes].reverse() })).toEqual(result);
    if (result.status !== "generated") continue;

    expect(result.plan.meals).toHaveLength(7);
    expect(new Set(result.plan.meals.map(({ recipeId }) => recipeId)).size).toBe(7);
    expect(result.plan.meals.map(({ date }) => date)).toEqual([
      "2026-10-05", "2026-10-06", "2026-10-07", "2026-10-08",
      "2026-10-09", "2026-10-10", "2026-10-11",
    ]);
    expect(result.plan.meals.some(({ recipeId }) => {
      const selected = recipes.find(({ id }) => id === recipeId)!;
      return selected.dietaryTags.includes("vegetarian") || selected.dietaryTags.includes("vegan");
    })).toBe(true);
    for (const [index, meal] of result.plan.meals.entries()) {
      const selected = recipes.find(({ id }) => id === meal.recipeId)!;
      expect(evaluateRecipeForDay(selected, dayProfiles[index]!, context).eligible).toBe(true);
    }
  }
});
