import type { PlannerRecipe, VerifiedPrepLink, WeeklyPlanScore } from "./planner";

export type IngredientQuantity = {
  readonly normalizedIngredient: string;
  readonly unit: string;
  readonly quantity: number;
};
export type IngredientDelta = {
  readonly additions: readonly IngredientQuantity[];
  readonly removals: readonly IngredientQuantity[];
  readonly warnings: readonly string[];
};
export type ScoreDelta = {
  readonly wastePenalty: number;
  readonly remainderPenalty: number;
  readonly oneOffPenalty: number;
  readonly reuseCredit: number;
  readonly pantryCredit: number;
  readonly dealValue: number;
  readonly favoriteCount: number;
  readonly historyPenalty: number;
  readonly varietyScore: number;
  readonly reuseIngredientCount: number;
  readonly pantryIngredientCount: number;
};

const normalize = (value: string): string => value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");
const rounded = (value: number): number => Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;

/** Demand deltas, not package-price estimates; uncertain evidence is never invented. */
export function ingredientReplacementDelta(
  before: readonly PlannerRecipe[], beforeServings: ReadonlyMap<string, number>,
  after: readonly PlannerRecipe[], afterServings: ReadonlyMap<string, number>,
  prepLinks: readonly VerifiedPrepLink[] = [],
): IngredientDelta {
  const warnings = new Set<string>();
  function aggregate(recipes: readonly PlannerRecipe[], servings: ReadonlyMap<string, number>) {
    const demand = new Map<string, IngredientQuantity>();
    for (const recipe of recipes) {
      for (const ingredient of recipe.ingredients) {
        if (recipe.servings === null || ingredient.uncertain || ingredient.normalizedName === null || ingredient.quantity === null || ingredient.unit === null) {
          warnings.add(`${recipe.title}: ${ingredient.rawText} cannot be quantified exactly`);
          continue;
        }
        const normalizedIngredient = normalize(ingredient.normalizedName);
        const unit = normalize(ingredient.unit);
        const key = `${normalizedIngredient}\0${unit}`;
        const quantity = ingredient.quantity * servings.get(recipe.id)! / recipe.servings;
        demand.set(key, { normalizedIngredient, unit, quantity: (demand.get(key)?.quantity ?? 0) + quantity });
      }
    }
    const selectedIds = new Set(recipes.map(({ id }) => id));
    for (const link of prepLinks) {
      if (link.kind !== "prep" || !selectedIds.has(link.sourceRecipeId)) continue;
      const normalizedIngredient = normalize(link.normalizedIngredient);
      const unit = normalize(link.unit);
      const key = `${normalizedIngredient}\0${unit}`;
      demand.set(key, { normalizedIngredient, unit, quantity: (demand.get(key)?.quantity ?? 0) + link.quantity });
    }
    return demand;
  }
  const oldDemand = aggregate(before, beforeServings);
  const newDemand = aggregate(after, afterServings);
  const additions: IngredientQuantity[] = [];
  const removals: IngredientQuantity[] = [];
  for (const key of [...new Set([...oldDemand.keys(), ...newDemand.keys()])].sort()) {
    const old = oldDemand.get(key);
    const next = newDemand.get(key);
    const delta = rounded((next?.quantity ?? 0) - (old?.quantity ?? 0));
    if (delta > 0) additions.push({ ...next!, quantity: delta });
    if (delta < 0) removals.push({ ...old!, quantity: -delta });
  }
  return { additions, removals, warnings: [...warnings].sort() };
}

export function replacementScoreDelta(before: WeeklyPlanScore, after: WeeklyPlanScore): ScoreDelta {
  const keys = ["wastePenalty", "remainderPenalty", "oneOffPenalty", "reuseCredit", "pantryCredit", "dealValue", "favoriteCount", "historyPenalty", "varietyScore", "reuseIngredientCount", "pantryIngredientCount"] as const;
  return Object.fromEntries(keys.map((key) => [key, rounded(after[key] - before[key])])) as ScoreDelta;
}
