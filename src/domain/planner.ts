import { createHash } from "node:crypto";
import { normalizeMeasuredQuantity } from "./ingredients";
import { DIETARY_TAGS } from "./recipe";

export const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

export type Day = (typeof DAYS)[number];
export type ServingMode = "immediate" | "keep-warm" | "reheat" | "assemble-later";
export type SuitabilityTag = "quick" | "keepWarm" | "reheatFriendly" | "batchCook" | "prepAhead";

export type PlannerIngredient = {
  readonly rawText: string;
  readonly normalizedName: string | null;
  readonly quantity: number | null;
  readonly unit: string | null;
  readonly uncertain: boolean;
};

export type PlannerRecipe = {
  readonly id: string;
  readonly sourceId: string;
  readonly title: string;
  readonly servings: number | null;
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
  readonly totalMinutes: number | null;
  readonly cuisineTags: readonly string[];
  readonly proteinTag: string | null;
  readonly dietaryTags: readonly string[];
  readonly suitabilityTags: readonly SuitabilityTag[];
  readonly extraMealServings: number;
  readonly preference: "favorite" | "neutral" | "disliked";
  readonly needsReview: boolean;
  readonly ingredients: readonly PlannerIngredient[];
};

export type PlannerDayProfile = {
  readonly day: Day;
  readonly maxTotalMinutes: number | null;
  readonly requiredServingModes: readonly ServingMode[];
  readonly easyOnly: boolean;
  readonly minimumExtraMeals: number;
  readonly prepLinkSatisfiesMinimum: boolean;
};

export type ConstraintContext = {
  readonly householdServings: number;
  readonly enabledSourceIds: ReadonlySet<string>;
  readonly dietaryRestrictions: readonly string[];
  readonly dislikedIngredients: readonly string[];
  readonly verifiedPrepRecipeIds?: ReadonlySet<string>;
  readonly verifiedPrepLinks?: readonly VerifiedPrepLink[];
};

export type VerifiedPrepLink = {
  readonly id: string;
  readonly sourceRecipeId: string;
  readonly targetMealId: string;
  readonly targetDate: string;
  readonly kind: "prep" | "leftover";
  readonly normalizedIngredient: string;
  readonly quantity: number;
  readonly unit: string;
  readonly note: string;
};

export type ConstraintEvaluation = {
  readonly eligible: boolean;
  readonly reasons: readonly string[];
};

export type PlanMealDraft = {
  readonly day: Day;
  readonly date: string;
  readonly recipeId: string;
  readonly servings: number;
  readonly rationale: readonly string[];
  readonly prepLinks: readonly string[];
};

export type GeneratedWeeklyPlan = {
  readonly weekStart: string;
  readonly shoppingDate: string;
  readonly plannedAt: string;
  readonly seed: string;
  readonly meals: readonly PlanMealDraft[];
  readonly score: WeeklyPlanScore;
};

export type WeeklyPlannerInput = {
  readonly weekStart: string;
  readonly plannedAt: string;
  readonly seed: string;
  readonly recipes: readonly PlannerRecipe[];
  readonly dayProfiles: readonly PlannerDayProfile[];
  readonly context: ConstraintContext;
  readonly scoreContext?: WeeklyScoreContext;
};

export type WeeklyPlannerResult =
  | { readonly status: "generated"; readonly plan: GeneratedWeeklyPlan }
  | { readonly status: "infeasible"; readonly reasons: readonly string[] };

export type PlannerPantryItem = {
  readonly normalizedName: string;
  readonly quantity: string;
};

export type Perishability = "shelf-stable" | "perishable" | "short-lived";

export type PackageEstimate = {
  readonly normalizedIngredient: string;
  readonly unit: string;
  readonly packageQuantity: number;
  readonly perishability: Perishability;
};

export type DealSignal = {
  readonly recipeId: string;
  readonly storeId: string;
  readonly value: number;
  readonly validUntil: string;
  readonly confidence: "high" | "medium" | "low";
};

export type WeeklyScoreContext = {
  readonly householdServings: number;
  readonly pantryItems: readonly PlannerPantryItem[];
  readonly packageEstimates: readonly PackageEstimate[];
  readonly dealSignals: readonly DealSignal[];
  readonly preferredStoreIds: ReadonlySet<string>;
  readonly shoppingDate: string;
  readonly recentRecipeIds: ReadonlySet<string>;
  readonly recipeServings?: ReadonlyMap<string, number>;
  readonly prepLinks?: readonly VerifiedPrepLink[];
};

export type PredictedRemainder = {
  readonly normalizedIngredient: string;
  readonly unit: string;
  readonly demand: number;
  readonly pantryUsed: number;
  readonly packageQuantity: number;
  readonly packageCount: number;
  readonly remainder: number;
  readonly perishability: Perishability;
};

export type WeeklyPlanScore = {
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
  readonly predictedRemainders: readonly PredictedRemainder[];
  readonly explanations: readonly string[];
  readonly warnings: readonly string[];
};

const servingModeTags: Readonly<Record<ServingMode, SuitabilityTag | null>> = {
  "immediate": null,
  "keep-warm": "keepWarm",
  "reheat": "reheatFriendly",
  "assemble-later": "prepAhead",
};

const dietaryRestrictionTags: Readonly<Record<string, string>> = {
  ...Object.fromEntries(DIETARY_TAGS.map((tag) => [tag, tag])),
  "diabetic": "diabetic",
  "gluten": "gluten-free",
  "gluten free": "gluten-free",
  "gluten-free": "gluten-free",
  "halal": "halal",
  "hindu": "hindu",
  "kosher": "kosher",
  "lactose": "low-lactose",
  "lactose free": "low-lactose",
  "lactose-free": "low-lactose",
  "low calorie": "low-calorie",
  "low fat": "low-fat",
  "low salt": "low-salt",
  "vegan": "vegan",
  "vegetarian": "vegetarian",
};

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");
}

function recipeProvesDietaryTag(recipe: PlannerRecipe, requiredTag: string): boolean {
  if (recipe.dietaryTags.includes(requiredTag)) return true;
  return requiredTag === "vegetarian" && recipe.dietaryTags.includes("vegan");
}

function ingredientContains(recipe: PlannerRecipe, value: string): boolean {
  const needle = normalizeText(value);
  return recipe.ingredients.some((ingredient) => {
    const evidence = `${ingredient.normalizedName ?? ""} ${ingredient.rawText}`;
    return normalizeText(evidence).includes(needle);
  });
}

function restrictionIngredientTerms(value: string): string[] {
  return normalizeText(value)
    .split(/[,;]|\band\b|&/u)
    .map((term) => term.replace(/^no\s+/u, "").trim())
    .filter((term) => term.length > 0);
}

function rounded(value: number): number {
  return Math.round((value + Number.EPSILON) * 1_000_000) / 1_000_000;
}


function perishabilityWeight(value: Perishability): number {
  if (value === "short-lived") return 5;
  if (value === "perishable") return 3;
  return 1;
}

export function scoreWeeklyRecipes(
  recipes: readonly PlannerRecipe[],
  context: WeeklyScoreContext,
): WeeklyPlanScore {
  const demand = new Map<string, {
    normalizedIngredient: string;
    unit: string;
    quantity: number;
    recipes: Map<string, string>;
  }>();
  const warnings = new Set<string>();
  for (const recipe of recipes) {
    if (recipe.servings === null) {
      warnings.add(`${recipe.title}: servings are unknown; ingredient demand is unscored`);
      continue;
    }
    const scale = (context.recipeServings?.get(recipe.id) ?? context.householdServings) / recipe.servings;
    for (const ingredient of recipe.ingredients) {
      if (
        ingredient.uncertain
        || ingredient.normalizedName === null
        || ingredient.quantity === null
        || ingredient.unit === null
      ) {
        warnings.add(`${recipe.title}: ${ingredient.rawText} has uncertain quantity evidence`);
        continue;
      }
      const normalizedIngredient = normalizeText(ingredient.normalizedName);
      const unit = normalizeText(ingredient.unit);
      const key = `${normalizedIngredient}\0${unit}`;
      const aggregate = demand.get(key) ?? {
        normalizedIngredient,
        unit,
        quantity: 0,
        recipes: new Map<string, string>(),
      };
      aggregate.quantity += ingredient.quantity * scale;
      aggregate.recipes.set(recipe.id, recipe.title);
      demand.set(key, aggregate);
    }
  }

  const pantry = new Map<string, number>();
  const selectedRecipeIds = new Set(recipes.map(({ id }) => id));
  const selectedPrepLinks = (context.prepLinks ?? []).filter(({ sourceRecipeId }) => selectedRecipeIds.has(sourceRecipeId));
  for (const link of selectedPrepLinks.filter(({ kind }) => kind === "prep")) {
    const key = `${normalizeText(link.normalizedIngredient)}\0${normalizeText(link.unit)}`;
    const aggregate = demand.get(key);
    if (aggregate !== undefined) aggregate.quantity += link.quantity;
  }
  for (const item of context.pantryItems) {
    const measured = normalizeMeasuredQuantity(item.quantity);
    if (measured === null) continue;
    pantry.set(`${normalizeText(item.normalizedName)}\0${measured.unit}`, measured.quantity);
  }
  const packages = new Map(context.packageEstimates.map((estimate) => [
    `${normalizeText(estimate.normalizedIngredient)}\0${normalizeText(estimate.unit)}`,
    estimate,
  ]));

  let remainderPenalty = 0;
  let oneOffPenalty = 0;
  let reuseCredit = 0;
  let pantryCredit = 0;
  let reuseIngredientCount = 0;
  let pantryIngredientCount = 0;
  const predictedRemainders: PredictedRemainder[] = [];
  const explanations: string[] = [];
  for (const [key, aggregate] of [...demand.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    const pantryAvailable = pantry.get(key) ?? 0;
    const pantryUsed = Math.min(aggregate.quantity, pantryAvailable);
    if (pantryUsed > 0) {
      pantryIngredientCount += 1;
      pantryCredit += 1;
      explanations.push(`${aggregate.normalizedIngredient} uses ${rounded(pantryUsed)} ${aggregate.unit} from the pantry`);
    }
    if (aggregate.recipes.size > 1) {
      reuseIngredientCount += 1;
      reuseCredit += aggregate.recipes.size - 1;
      explanations.push(
        `${aggregate.normalizedIngredient} is reused across ${[...aggregate.recipes.values()].sort().join(" and ")}`,
      );
    }
    const estimate = packages.get(key);
    if (estimate === undefined) {
      if (aggregate.recipes.size === 1 && pantryUsed === 0) oneOffPenalty += 1;
      continue;
    }
    const purchaseDemand = Math.max(0, aggregate.quantity - pantryUsed);
    const packageCount = purchaseDemand === 0 ? 0 : Math.ceil(purchaseDemand / estimate.packageQuantity);
    const remainder = rounded(packageCount * estimate.packageQuantity - purchaseDemand);
    const weight = perishabilityWeight(estimate.perishability);
    remainderPenalty += packageCount === 0 ? 0 : (remainder / estimate.packageQuantity) * weight;
    if (aggregate.recipes.size === 1 && pantryUsed === 0) oneOffPenalty += weight;
    predictedRemainders.push({
      normalizedIngredient: aggregate.normalizedIngredient,
      unit: aggregate.unit,
      demand: rounded(aggregate.quantity),
      pantryUsed: rounded(pantryUsed),
      packageQuantity: estimate.packageQuantity,
      packageCount,
      remainder,
      perishability: estimate.perishability,
    });
  }

  const dealValue = context.dealSignals
    .filter((deal) => selectedRecipeIds.has(deal.recipeId))
    .filter((deal) => context.preferredStoreIds.has(deal.storeId))
    .filter((deal) => deal.validUntil >= context.shoppingDate)
    .filter((deal) => deal.confidence !== "low")
    .reduce((total, deal) => total + deal.value, 0);
  const favoriteCount = recipes.filter(({ preference }) => preference === "favorite").length;
  const historyPenalty = recipes.filter(({ id }) => context.recentRecipeIds.has(id)).length;
  const cuisines = new Set(recipes.flatMap(({ cuisineTags }) => cuisineTags));
  const proteins = new Set(recipes.flatMap(({ proteinTag }) => proteinTag === null ? [] : [proteinTag]));
  for (const link of selectedPrepLinks) {
    reuseCredit += 1;
    explanations.push(`${link.note}: ${link.quantity} ${link.unit} ${link.normalizedIngredient} linked to ${link.targetDate} [${link.targetMealId}]`);
  }
  remainderPenalty = rounded(remainderPenalty);
  oneOffPenalty = rounded(oneOffPenalty);
  reuseCredit = rounded(reuseCredit);
  pantryCredit = rounded(pantryCredit);
  return {
    wastePenalty: rounded(remainderPenalty + oneOffPenalty - reuseCredit - pantryCredit),
    remainderPenalty,
    oneOffPenalty,
    reuseCredit,
    pantryCredit,
    dealValue: rounded(dealValue),
    favoriteCount,
    historyPenalty,
    varietyScore: cuisines.size + proteins.size,
    reuseIngredientCount,
    pantryIngredientCount,
    predictedRemainders,
    explanations,
    warnings: [...warnings].sort(),
  };
}

function provenTotalMinutes(recipe: PlannerRecipe): number | null {
  if (recipe.totalMinutes !== null) return recipe.totalMinutes;
  if (recipe.prepMinutes !== null && recipe.cookMinutes !== null) {
    return recipe.prepMinutes + recipe.cookMinutes;
  }
  return null;
}

export function evaluateRecipeForDay(
  recipe: PlannerRecipe,
  profile: PlannerDayProfile,
  context: ConstraintContext,
): ConstraintEvaluation {
  const reasons: string[] = [];
  if (recipe.needsReview) reasons.push("recipe still needs review");
  if (!context.enabledSourceIds.has(recipe.sourceId)) reasons.push("recipe source is disabled");
  if (recipe.preference === "disliked") reasons.push("recipe is disliked");
  if (recipe.servings === null) reasons.push("recipe servings are unknown");
  if (recipe.ingredients.length === 0) reasons.push("recipe has no ingredient evidence");
  if (recipe.dietaryTags.length === 0) reasons.push("recipe has no dietary classification");
  for (const restriction of context.dietaryRestrictions) {
    for (const term of restrictionIngredientTerms(restriction)) {
      const requiredTag = dietaryRestrictionTags[term];
      if (requiredTag !== undefined) {
        if (!recipeProvesDietaryTag(recipe, requiredTag)) {
          reasons.push(`does not prove dietary restriction: ${restriction}`);
        }
      } else if (ingredientContains(recipe, term)) {
        reasons.push(`contains restricted ingredient: ${restriction}`);
      }
    }
  }
  for (const dislikedIngredient of context.dislikedIngredients) {
    if (restrictionIngredientTerms(dislikedIngredient).some((term) => ingredientContains(recipe, term))) {
      reasons.push(`contains disliked ingredient: ${dislikedIngredient}`);
    }
  }
  if (profile.maxTotalMinutes !== null) {
    const totalMinutes = provenTotalMinutes(recipe);
    if (totalMinutes === null) reasons.push("total cooking time is unknown");
    else if (totalMinutes > profile.maxTotalMinutes) {
      reasons.push(`total cooking time ${totalMinutes} min exceeds ${profile.maxTotalMinutes} min`);
    }
  }

  if (profile.requiredServingModes.length > 0) {
    const hasRequiredMode = profile.requiredServingModes.some((mode) => {
      const tag = servingModeTags[mode];
      return tag === null || recipe.suitabilityTags.includes(tag);
    });
    if (!hasRequiredMode) {
      reasons.push(`requires one of: ${profile.requiredServingModes.join(", ")}`);
    }
  }

  if (profile.easyOnly && !recipe.suitabilityTags.includes("quick")) {
    reasons.push("recipe is not classified as easy");
  }

  if (profile.minimumExtraMeals > 0) {
    const requiredExtraServings = context.householdServings * profile.minimumExtraMeals;
    const hasVerifiedPrep = profile.prepLinkSatisfiesMinimum
      && context.verifiedPrepRecipeIds?.has(recipe.id) === true;
    if (recipe.extraMealServings < requiredExtraServings && !hasVerifiedPrep) {
      reasons.push(
        `needs ${requiredExtraServings} extra serving(s) or an explicit preparation link`,
      );
    }
  }

  return { eligible: reasons.length === 0, reasons };
}

function parseDateOnly(value: string, label: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} must use YYYY-MM-DD`);
  const date = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} is not a valid date`);
  }
  return date;
}

function addDays(value: Date, count: number): string {
  const date = new Date(value);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

function seededOrder(seed: string, day: Day, recipeId: string): string {
  return createHash("sha256").update(`${seed}\0${day}\0${recipeId}`).digest("hex");
}

function compareScores(left: WeeklyPlanScore, right: WeeklyPlanScore): number {
  return left.wastePenalty - right.wastePenalty
    || right.dealValue - left.dealValue
    || left.historyPenalty - right.historyPenalty
    || right.varietyScore - left.varietyScore
    || right.favoriteCount - left.favoriteCount;
}

function vegetarian(recipe: PlannerRecipe): boolean {
  return recipe.dietaryTags.includes("vegetarian") || recipe.dietaryTags.includes("vegan");
}

// Exact bipartite matching proves feasibility independently of heuristic scoring.
function feasibleWeek(candidates: ReadonlyMap<Day, readonly PlannerRecipe[]>): readonly PlannerRecipe[] | null {
  for (const fixedDay of DAYS) {
    for (const fixedRecipe of candidates.get(fixedDay)!.filter(vegetarian)) {
      const assigned = new Map<Day, PlannerRecipe>([[fixedDay, fixedRecipe]]);
      const owners = new Map<string, Day>([[fixedRecipe.id, fixedDay]]);
      const augment = (day: Day, visited: Set<string>): boolean => {
        for (const candidate of candidates.get(day)!) {
          if (candidate.id === fixedRecipe.id || visited.has(candidate.id)) continue;
          visited.add(candidate.id);
          const owner = owners.get(candidate.id);
          if (owner === undefined || augment(owner, visited)) {
            assigned.set(day, candidate);
            owners.set(candidate.id, day);
            return true;
          }
        }
        return false;
      };
      if (DAYS.filter((day) => day !== fixedDay).every((day) => augment(day, new Set()))) {
        return DAYS.map((day) => assigned.get(day)!);
      }
    }
  }
  return null;
}

function rationaleFor(profile: PlannerDayProfile, recipe: PlannerRecipe): string[] {
  const rationale = ["satisfies household and source constraints"];
  if (profile.maxTotalMinutes !== null) {
    rationale.push(`fits the ${profile.maxTotalMinutes} minute limit`);
  }
  if (profile.requiredServingModes.length > 0) {
    rationale.push(`supports ${profile.requiredServingModes.join(" or ")}`);
  }
  if (profile.easyOnly) rationale.push("classified as easy");
  if (profile.minimumExtraMeals > 0 && recipe.extraMealServings > 0) {
    rationale.push(`provides ${recipe.extraMealServings} extra serving(s)`);
  }
  if (vegetarian(recipe)) rationale.push("vegetarian");
  return rationale;
}

export function generateWeeklyPlan(input: WeeklyPlannerInput): WeeklyPlannerResult {
  const weekStart = parseDateOnly(input.weekStart, "Week start");
  if (weekStart.getUTCDay() !== 1) throw new Error("Week start must be a Monday");
  const profilesByDay = new Map(input.dayProfiles.map((profile) => [profile.day, profile]));
  if (profilesByDay.size !== DAYS.length || DAYS.some((day) => !profilesByDay.has(day))) {
    throw new Error("Day profiles must contain each weekday exactly once");
  }

  const candidatesByDay = new Map<Day, readonly PlannerRecipe[]>();
  for (const day of DAYS) {
    const profile = profilesByDay.get(day)!;
    const evaluations = input.recipes.map((candidate) => ({
      candidate,
      evaluation: evaluateRecipeForDay(candidate, profile, input.context),
    }));
    const candidates = evaluations
      .filter(({ evaluation }) => evaluation.eligible)
      .map(({ candidate }) => candidate)
      .sort((left, right) => {
        const bySeed = seededOrder(input.seed, day, left.id)
          .localeCompare(seededOrder(input.seed, day, right.id));
        return bySeed === 0 ? left.id.localeCompare(right.id) : bySeed;
      });
    if (candidates.length === 0) {
      const reasonCounts = new Map<string, number>();
      for (const { evaluation } of evaluations) {
        for (const reason of evaluation.reasons) {
          reasonCounts.set(reason, (reasonCounts.get(reason) ?? 0) + 1);
        }
      }
      const blocker = [...reasonCounts.entries()]
        .sort(([leftReason, leftCount], [rightReason, rightCount]) =>
          rightCount - leftCount || leftReason.localeCompare(rightReason))[0];
      const detail = blocker === undefined ? "" : `: ${blocker[0]} (${blocker[1]} candidates)`;
      return { status: "infeasible", reasons: [`No eligible recipe can satisfy ${day}${detail}`] };
    }
    candidatesByDay.set(day, candidates);
  }

  const hasEligibleVegetarian = DAYS.some((day) => candidatesByDay.get(day)!.some(vegetarian));
  if (!hasEligibleVegetarian) {
    return {
      status: "infeasible",
      reasons: ["No eligible vegetarian recipe can satisfy the week-wide minimum"],
    };
  }

  const witness = feasibleWeek(candidatesByDay);
  if (witness === null) {
    return { status: "infeasible", reasons: ["Fewer than seven distinct recipes can satisfy all daily and weekly constraints"] };
  }

  const shoppingDate = addDays(weekStart, -2);
  const scoreContext: WeeklyScoreContext = input.scoreContext ?? {
    householdServings: input.context.householdServings,
    pantryItems: [],
    packageEstimates: [],
    dealSignals: [],
    preferredStoreIds: new Set<string>(),
    shoppingDate,
    recentRecipeIds: new Set<string>(),
  };
  const servingsFor = (candidate: PlannerRecipe, index: number): number =>
    input.context.householdServings + (input.dayProfiles.find(({ day }) => day === DAYS[index])!.minimumExtraMeals > 0
      ? candidate.extraMealServings : 0);
  const scoreSelection = (selected: readonly PlannerRecipe[]): WeeklyPlanScore => scoreWeeklyRecipes(selected, {
    ...scoreContext,
    recipeServings: new Map(selected.map((candidate, index) => [candidate.id, servingsFor(candidate, index)])),
    prepLinks: (scoreContext.prepLinks ?? input.context.verifiedPrepLinks ?? [])
      .filter(({ sourceRecipeId }) => selected[6]?.id === sourceRecipeId),
  });
  type SearchState = {
    readonly selected: readonly PlannerRecipe[];
    readonly used: ReadonlySet<string>;
    readonly score: WeeklyPlanScore;
    readonly tieBreak: string;
    readonly setKey: string;
  };
  let states: readonly SearchState[] = [{
    selected: [],
    used: new Set(),
    score: scoreWeeklyRecipes([], scoreContext),
    tieBreak: "",
    setKey: "",
  }];
  const maximumBeamWidth = 512;
  for (const day of DAYS) {
    const expanded: SearchState[] = [];
    for (const state of states) {
      for (const candidate of candidatesByDay.get(day)!) {
        if (state.used.has(candidate.id)) continue;
        const selected = [...state.selected, candidate];
        expanded.push({
          selected,
          used: new Set([...state.used, candidate.id]),
          score: scoreSelection(selected),
          tieBreak: createHash("sha256")
            .update(`${input.seed}\0${selected.map(({ id }) => id).join("\0")}`)
            .digest("hex"),
          setKey: selected.map(({ id }) => id).sort().join("\0"),
        });
      }
    }
    expanded.sort((left, right) => compareScores(left.score, right.score)
      || left.tieBreak.localeCompare(right.tieBreak));
    const uniqueStates: SearchState[] = [];
    const seenSets = new Set<string>();
    for (const state of expanded) {
      if (seenSets.has(state.setKey)) continue;
      seenSets.add(state.setKey);
      uniqueStates.push(state);
      if (uniqueStates.length === maximumBeamWidth) break;
    }
    states = uniqueStates;
    if (states.length === 0) break;
  }
  const best = [...states, {
    selected: witness,
    used: new Set(witness.map(({ id }) => id)),
    score: scoreSelection(witness),
    tieBreak: createHash("sha256").update(`${input.seed}\0${witness.map(({ id }) => id).join("\0")}`).digest("hex"),
    setKey: witness.map(({ id }) => id).sort().join("\0"),
  }]
    .filter(({ selected }) => selected.length === 7 && selected.some(vegetarian))
    .sort((left, right) => compareScores(left.score, right.score)
      || left.tieBreak.localeCompare(right.tieBreak))[0];

  if (best === undefined) {
    return {
      status: "infeasible",
      reasons: ["Fewer than seven distinct recipes can satisfy all daily and weekly constraints"],
    };
  }

  const selected = best.selected;

  const meals = DAYS.map((day, index): PlanMealDraft => {
    const candidate = selected[index]!;
    const profile = profilesByDay.get(day)!;
    return {
      day,
      date: addDays(weekStart, index),
      recipeId: candidate.id,
      servings: servingsFor(candidate, index),
      rationale: [...rationaleFor(profile, candidate), ...(day === "sun" ? input.context.verifiedPrepLinks ?? [] : [])
        .filter(({ sourceRecipeId }) => sourceRecipeId === candidate.id)
        .map(({ note, targetDate }) => `${note} for ${targetDate}`)],
      prepLinks: (day === "sun" ? input.context.verifiedPrepLinks ?? [] : []).filter(({ sourceRecipeId }) => sourceRecipeId === candidate.id).map(({ id }) => id).sort(),
    };
  });
  return {
    status: "generated",
    plan: {
      weekStart: input.weekStart,
      shoppingDate,
      plannedAt: input.plannedAt,
      seed: input.seed,
      meals,
      score: best.score,
    },
  };
}
