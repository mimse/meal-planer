import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { readFamilyConfiguration } from "../commands/family";
import { readPantry } from "../commands/pantry";
import { DAYS, evaluateRecipeForDay, scoreWeeklyRecipes, type ConstraintContext, type Day, type DealSignal, type PackageEstimate, type PlanMealDraft, type WeeklyPlanScore, type WeeklyScoreContext } from "../domain/planner";
import { ingredientReplacementDelta, replacementScoreDelta, type IngredientDelta, type ScoreDelta } from "../domain/replacement";
import { createConfigurationRepositories } from "../infrastructure/configuration-repositories";
import { createPlanRepository, type ReplacementRejection, type WeeklyPlan } from "../infrastructure/plan-repository";
import { createRecipeRepository } from "../infrastructure/recipe-repository";
import { createPrepLinkRepository } from "../infrastructure/prep-link-repository";

export type ReplacementContext = Pick<ConstraintContext, "verifiedPrepRecipeIds" | "verifiedPrepLinks"> & Pick<WeeklyScoreContext, "prepLinks">;
export type ReplacementOptions = {
  readonly planId: string;
  readonly day: Day;
  readonly packageEstimates?: readonly PackageEstimate[];
  readonly dealSignals?: readonly DealSignal[];
  readonly warnings?: readonly string[];
};
export type ReplacementCandidate = {
  readonly recipeId: string;
  readonly title: string;
  readonly meal: PlanMealDraft;
  readonly score: WeeklyPlanScore;
  readonly scoreDelta: ScoreDelta;
  readonly ingredientDelta: IngredientDelta;
  readonly dealDelta: { readonly additions: readonly DealSignal[]; readonly removals: readonly DealSignal[]; readonly value: number };
};
export type ReplacementPreview = {
  readonly original: WeeklyPlan;
  readonly day: Day;
  readonly options: ReplacementOptions;
  readonly fingerprint: string;
  readonly beforeScore: WeeklyPlanScore;
  readonly candidates: readonly ReplacementCandidate[];
  readonly blockedCandidates: readonly { readonly recipeId: string; readonly reasons: readonly string[] }[];
};
export type ConfirmReplacementOptions = {
  readonly recipeId: string;
  readonly rejection?: ReplacementRejection;
  readonly recordedAt: string;
};

const planIdSchema = z.string().regex(/^plan:[a-f0-9]{64}$/);
const recipeIdSchema = z.string().regex(/^recipe:[a-f0-9]{64}$/);
const daySchema = z.enum(DAYS);
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const vegetarian = (recipe: { readonly dietaryTags: readonly string[] }): boolean => recipe.dietaryTags.includes("vegetarian") || recipe.dietaryTags.includes("vegan");

function previewInCurrentTransaction(database: Database, options: ReplacementOptions, additionalContext: ReplacementContext): ReplacementPreview {
  const planId = planIdSchema.parse(options.planId);
  const day = daySchema.parse(options.day);
  const warnings = z.array(z.string().min(1).max(2_000)).max(1_000).parse(options.warnings ?? []);
  const withWarnings = (score: WeeklyPlanScore): WeeklyPlanScore => ({ ...score, warnings: [...new Set([...score.warnings, ...warnings])].sort() });
  const repository = createPlanRepository(database);
  const plan = repository.get(planId);
  if (plan === null) throw new Error("Plan does not exist");
  repository.assertCurrentSnapshotInCurrentTransaction(plan);
  const target = repository.assertReplaceableInCurrentTransaction(plan, day);
  const family = readFamilyConfiguration(database);
  const householdServings = family.members.reduce((sum, member) => sum + member.servings, 0);
  z.number().finite().positive().max(1_000_000).parse(householdServings);
  const profile = family.dayProfiles.find((profile) => profile.day === day);
  if (profile === undefined) throw new Error("Target day has no configured profile");
  const sources = createConfigurationRepositories(database).recipeSources.list();
  const recipeRepository = createRecipeRepository(database);
  const recipes = recipeRepository.list({ limit: 500 });
  const fixedRecipes = plan.meals.map((meal) => {
    const recipe = recipeRepository.get(meal.recipeId);
    if (recipe === null) throw new Error(`Assigned recipe is missing: ${meal.recipeId}`);
    return recipe;
  });
  const prepLinks = createPrepLinkRepository(database).listVerifiedForSunday(plan.meals.find(({ day }) => day === "sun")!.date);
  const verifiedPrepRecipeIds = new Set(prepLinks.map(({ sourceRecipeId }) => sourceRecipeId));
  for (const supplied of [...additionalContext.verifiedPrepLinks ?? [], ...additionalContext.prepLinks ?? []]) {
    if (!prepLinks.some((verified) => hash(verified) === hash(supplied))) throw new Error("Preparation link context is not currently verified");
  }
  if ([...additionalContext.verifiedPrepRecipeIds ?? []].some((id) => !verifiedPrepRecipeIds.has(id))) {
    throw new Error("Preparation recipe context is not currently verified");
  }
  const context: ConstraintContext = {
    householdServings,
    enabledSourceIds: new Set(sources.filter(({ enabled }) => enabled).map(({ id }) => id)),
    dietaryRestrictions: family.rules.filter(({ kind }) => kind === "dietary_restriction").map(({ value }) => value),
    dislikedIngredients: family.rules.filter(({ kind }) => kind === "disliked_ingredient").map(({ value }) => value),
    verifiedPrepRecipeIds, verifiedPrepLinks: prepLinks,
  };
  for (const [index, meal] of plan.meals.entries()) {
    if (meal.day === day) continue;
    const fixedProfile = family.dayProfiles.find((profile) => profile.day === meal.day);
    if (fixedProfile === undefined) throw new Error(`Fixed meal ${meal.day} has no configured profile`);
    const evaluation = evaluateRecipeForDay(fixedRecipes[index]!, fixedProfile, context);
    if (!evaluation.eligible || meal.servings < householdServings) {
      throw new Error(`Fixed meal ${meal.day} no longer satisfies constraints: ${[...evaluation.reasons, ...(meal.servings < householdServings ? ["insufficient household servings"] : [])].join("; ")}`);
    }
  }
  const since = new Date(`${plan.weekStart}T00:00:00.000Z`);
  since.setUTCDate(since.getUTCDate() - 56);
  const scoreContext: WeeklyScoreContext = {
    prepLinks,
    householdServings, pantryItems: readPantry(database),
    packageEstimates: options.packageEstimates ?? [], dealSignals: options.dealSignals ?? [],
    preferredStoreIds: new Set(family.preferredStores.map(({ id }) => id)), shoppingDate: plan.shoppingDate,
    recentRecipeIds: new Set(repository.listRecentRecipeIds(since.toISOString().slice(0, 10))),
  };
  const oldServings = new Map(plan.meals.map((meal) => [meal.recipeId, meal.servings]));
  const boundPrepLinks = prepLinks.filter(({ id }) => plan.meals.find(({ day }) => day === "sun")!.prepLinks.includes(id));
  const beforeScore = withWarnings(scoreWeeklyRecipes(fixedRecipes, { ...scoreContext, recipeServings: oldServings, prepLinks: boundPrepLinks }));
  const assigned = new Set(plan.meals.map(({ recipeId }) => recipeId));
  const rejected = new Set(repository.listRejectedRecipeIds(plan.weekStart));
  const targetIndex = plan.meals.findIndex(({ day: selectedDay }) => selectedDay === day);
  const candidates: ReplacementCandidate[] = [];
  const blockedCandidates: { recipeId: string; reasons: readonly string[] }[] = [];
  const validDeals = (ids: ReadonlySet<string>) => scoreContext.dealSignals.filter((deal) => ids.has(deal.recipeId) && scoreContext.preferredStoreIds.has(deal.storeId) && deal.validUntil >= plan.shoppingDate && deal.confidence !== "low");
  for (const recipe of recipes) {
    if (assigned.has(recipe.id) || rejected.has(recipe.id)) continue;
    const evaluation = evaluateRecipeForDay(recipe, profile, context);
    const reasons = [...evaluation.reasons];
    const selected = fixedRecipes.map((fixed, index) => index === targetIndex ? recipe : fixed);
    if (!selected.some(vegetarian)) reasons.push("replacement violates the week-wide vegetarian minimum");
    if (reasons.length > 0) {
      blockedCandidates.push({ recipeId: recipe.id, reasons });
      continue;
    }
    const servings = householdServings + (profile.minimumExtraMeals > 0 ? recipe.extraMealServings : 0);
    const candidateLinks = day === "sun" ? prepLinks.filter(({ sourceRecipeId }) => sourceRecipeId === recipe.id) : [];
    const meal: PlanMealDraft = { day, date: target.date, recipeId: recipe.id, servings,
      rationale: ["replacement satisfies target-day, household and source constraints", ...(vegetarian(recipe) ? ["vegetarian"] : []), ...candidateLinks.map(({ note, targetDate }) => `${note} for ${targetDate}`)],
      prepLinks: candidateLinks.map(({ id }) => id).sort(),
    };
    const newServings = new Map(plan.meals.map((fixed, index) => index === targetIndex ? [recipe.id, servings] : [fixed.recipeId, fixed.servings]));
    const scoredPrepLinks = [...boundPrepLinks, ...candidateLinks];
    const score = withWarnings(scoreWeeklyRecipes(selected, { ...scoreContext, recipeServings: newServings, prepLinks: scoredPrepLinks }));
    const scoreDelta = replacementScoreDelta(beforeScore, score);
    candidates.push({ recipeId: recipe.id, title: recipe.title, meal, score, scoreDelta,
      ingredientDelta: ingredientReplacementDelta(fixedRecipes, oldServings, selected, newServings, scoredPrepLinks),
      dealDelta: { additions: validDeals(new Set([recipe.id])), removals: validDeals(new Set([target.recipeId])), value: scoreDelta.dealValue },
    });
  }
  candidates.sort((left, right) => left.score.wastePenalty - right.score.wastePenalty
    || right.score.dealValue - left.score.dealValue
    || left.score.historyPenalty - right.score.historyPenalty
    || right.score.varietyScore - left.score.varietyScore
    || right.score.favoriteCount - left.score.favoriteCount
    || left.recipeId.localeCompare(right.recipeId));
  const persistedPrepLinks = database.query("SELECT * FROM recipe_prep_links ORDER BY id").all();
  return {
    original: plan, day,
    options: structuredClone(options),
    fingerprint: hash({ plan, family, sources, recipes, fixedRecipes, rejected: [...rejected], pantry: scoreContext.pantryItems, packages: scoreContext.packageEstimates, deals: scoreContext.dealSignals, recent: [...scoreContext.recentRecipeIds], verifiedPrepRecipeIds: [...verifiedPrepRecipeIds].sort(), prepLinks, persistedPrepLinks }),
    beforeScore, candidates, blockedCandidates,
  };
}

/** Read-only preview. Other six assignments are fixed without writing their locks or hashes. */
export function previewPlanMealReplacement(database: Database, options: ReplacementOptions, additionalContext: ReplacementContext = {}): ReplacementPreview {
  return database.transaction(() => previewInCurrentTransaction(database, options, additionalContext))();
}

/** Re-evaluates live constraints and the selected candidate under the same atomic write lock. */
export function confirmPlanMealReplacement(database: Database, preview: ReplacementPreview, options: ConfirmReplacementOptions, additionalContext: ReplacementContext = {}): WeeklyPlan {
  recipeIdSchema.parse(options.recipeId);
  z.string().datetime({ offset: true }).parse(options.recordedAt);
  const rejection = z.enum(["not-this-week", "disliked", "none"]).parse(options.rejection ?? "not-this-week");
  return database.transaction(() => {
    const repository = createPlanRepository(database);
    repository.assertCurrentSnapshotInCurrentTransaction(preview.original);
    const fresh = previewInCurrentTransaction(database, preview.options, additionalContext);
    if (fresh.fingerprint !== preview.fingerprint || fresh.day !== preview.day || fresh.original.id !== preview.original.id) {
      throw new Error("Stale replacement preview: planning inputs changed");
    }
    const selected = fresh.candidates.find(({ recipeId }) => recipeId === options.recipeId);
    const shown = preview.candidates.find(({ recipeId }) => recipeId === options.recipeId);
    if (selected === undefined || shown === undefined) throw new Error("Replacement candidate is not eligible");
    if (hash(selected) !== hash(shown)) throw new Error("Stale replacement preview: candidate changed");
    return repository.replaceMealInCurrentTransaction({ original: preview.original, day: preview.day,
      meal: { recipeId: selected.recipeId, servings: selected.meal.servings, rationale: selected.meal.rationale, prepLinks: selected.meal.prepLinks },
      score: selected.score, rejection, recordedAt: options.recordedAt,
    });
  }).immediate();
}
