import type { Database } from "bun:sqlite";
import { z } from "zod";
import { DIETARY_TAGS } from "../domain/recipe";
import {
  createRecipeRepository,
  RECIPE_PREFERENCES,
  SUITABILITY_TAGS,
  normalizeRecipeTag,
  type Recipe,
  type RecipeImport,
} from "../infrastructure/recipe-repository";
import { hasPlanningCriticalEvidence } from "./recipe-ingestion";
import {
  markReviewOverrides,
  type ReviewOverrideField,
} from "./recipe-review-overrides";

const reviewPatchSchema = z.object({
  dietaryTags: z.array(z.enum(DIETARY_TAGS)).max(50).optional(),
  suitabilityTags: z.array(z.enum(SUITABILITY_TAGS)).max(SUITABILITY_TAGS.length).optional(),
  cuisineTags: z.array(z.string().trim().min(1).max(64)).max(50).optional(),
  proteinTag: z.string().trim().min(1).max(64).nullable().optional(),
  preference: z.enum(RECIPE_PREFERENCES).optional(),
  servings: z.number().finite().positive().max(1_000_000).nullable().optional(),
  prepMinutes: z.number().int().finite().nonnegative().max(525_600).nullable().optional(),
  cookMinutes: z.number().int().finite().nonnegative().max(525_600).nullable().optional(),
  totalMinutes: z.number().int().finite().nonnegative().max(525_600).nullable().optional(),
  extraMealServings: z.number().finite().nonnegative().max(1_000_000).optional(),
  markReviewed: z.boolean().optional(),
}).strict().superRefine((patch, context) => {
  for (const [key, values] of [
    ["dietaryTags", patch.dietaryTags],
    ["suitabilityTags", patch.suitabilityTags],
  ] as const) {
    if (values !== undefined && new Set(values).size !== values.length) {
      context.addIssue({ code: "custom", path: [key], message: `${key} contain duplicate values` });
    }
  }
  if (patch.cuisineTags !== undefined) {
    try {
      const normalized = patch.cuisineTags.map(normalizeRecipeTag);
      if (new Set(normalized).size !== normalized.length) {
        context.addIssue({ code: "custom", path: ["cuisineTags"], message: "Cuisine tags contain duplicate normalized values" });
      }
    } catch {
      context.addIssue({ code: "custom", path: ["cuisineTags"], message: "Cuisine tag form is invalid" });
    }
  }
  if (patch.proteinTag !== undefined && patch.proteinTag !== null) {
    try {
      normalizeRecipeTag(patch.proteinTag);
    } catch {
      context.addIssue({ code: "custom", path: ["proteinTag"], message: "Protein tag form is invalid" });
    }
  }
});

export type RecipeReviewPatch = z.infer<typeof reviewPatchSchema>;

export function parseRecipeReviewPatch(input: unknown): RecipeReviewPatch {
  return reviewPatchSchema.parse(input);
}

function mutableRecipeImport(recipe: Recipe): RecipeImport {
  const { id: _id, normalizedTitle: _normalizedTitle, ...input } = recipe;
  return input;
}

export function reviewRecipe(database: Database, recipeId: string, input: RecipeReviewPatch): Recipe {
  const patch = parseRecipeReviewPatch(input);
  const repository = createRecipeRepository(database);
  return database.transaction(() => {
    const current = repository.get(recipeId);
    if (current === null) throw new Error(`Recipe does not exist: ${recipeId}`);
    const candidate: RecipeImport = {
      ...mutableRecipeImport(current),
      ...(patch.dietaryTags === undefined ? {} : { dietaryTags: patch.dietaryTags }),
      ...(patch.suitabilityTags === undefined ? {} : { suitabilityTags: patch.suitabilityTags }),
      ...(patch.cuisineTags === undefined ? {} : { cuisineTags: patch.cuisineTags }),
      ...(patch.proteinTag === undefined ? {} : { proteinTag: patch.proteinTag }),
      ...(patch.preference === undefined ? {} : { preference: patch.preference }),
      ...(patch.servings === undefined ? {} : { servings: patch.servings }),
      ...(patch.prepMinutes === undefined ? {} : { prepMinutes: patch.prepMinutes }),
      ...(patch.cookMinutes === undefined ? {} : { cookMinutes: patch.cookMinutes }),
      ...(patch.totalMinutes === undefined ? {} : { totalMinutes: patch.totalMinutes }),
      ...(patch.extraMealServings === undefined ? {} : { extraMealServings: patch.extraMealServings }),
    };
    const complete = hasPlanningCriticalEvidence(candidate);
    if (patch.markReviewed === true && !complete) {
      throw new Error(
        "Cannot mark recipe reviewed: servings, a duration, ingredients, and dietary classification are required",
      );
    }
    candidate.needsReview = patch.markReviewed === true ? false : current.needsReview || !complete;
    const editableFields = [
      "servings", "prepMinutes", "cookMinutes", "totalMinutes", "cuisineTags", "proteinTag",
      "dietaryTags", "suitabilityTags", "extraMealServings", "preference",
    ] as const satisfies readonly Exclude<ReviewOverrideField, "needsReview">[];
    const changedFields: ReviewOverrideField[] = editableFields.filter((field) => patch[field] !== undefined);
    changedFields.push("needsReview");
    candidate.sourceEvidence = markReviewOverrides(current.sourceEvidence, changedFields);
    const updated = repository.import(candidate);
    if (updated.id !== current.id) throw new Error("Recipe review changed immutable recipe identity");
    return updated;
  }).immediate();
}
