import type { RecipeImport } from "../infrastructure/recipe-repository";

export const REVIEW_OVERRIDE_FIELDS = [
  "servings",
  "prepMinutes",
  "cookMinutes",
  "totalMinutes",
  "cuisineTags",
  "proteinTag",
  "dietaryTags",
  "suitabilityTags",
  "preference",
  "needsReview",
] as const;

export type ReviewOverrideField = typeof REVIEW_OVERRIDE_FIELDS[number];

function evidenceRecord(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Recipe source evidence is corrupt: review override metadata requires an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Recipe source evidence is corrupt: review override metadata requires a plain object");
  }
  return value as Record<string, unknown>;
}

export function parseReviewOverrides(sourceEvidence: unknown): readonly ReviewOverrideField[] {
  const evidence = evidenceRecord(sourceEvidence);
  if (!Object.prototype.hasOwnProperty.call(evidence, "reviewOverrides")) return [];
  const marker = evidence.reviewOverrides;
  if (!Array.isArray(marker) || marker.length > REVIEW_OVERRIDE_FIELDS.length) {
    throw new Error("Recipe source evidence is corrupt: reviewOverrides must be a bounded field list");
  }
  const allowed = new Set<string>(REVIEW_OVERRIDE_FIELDS);
  if (new Set(marker).size !== marker.length || marker.some((field) => typeof field !== "string" || !allowed.has(field))) {
    throw new Error("Recipe source evidence is corrupt: reviewOverrides contains an invalid field");
  }
  return marker as ReviewOverrideField[];
}

export function markReviewOverrides(
  sourceEvidence: unknown,
  addedFields: readonly ReviewOverrideField[],
): Record<string, unknown> {
  const evidence = evidenceRecord(sourceEvidence);
  const selected = new Set<ReviewOverrideField>(parseReviewOverrides(evidence));
  for (const field of addedFields) selected.add(field);
  if (selected.size === 0) return { ...evidence };
  return {
    ...evidence,
    reviewOverrides: REVIEW_OVERRIDE_FIELDS.filter((field) => selected.has(field)),
  };
}

export function preserveReviewOverrideMetadata(
  incomingSourceEvidence: unknown,
  existingSourceEvidence: unknown,
): Record<string, unknown> {
  const incoming = evidenceRecord(incomingSourceEvidence);
  if (Object.prototype.hasOwnProperty.call(incoming, "reviewOverrides")) {
    throw new Error("Extracted recipe source evidence uses reserved reviewOverrides metadata");
  }
  const overrides = parseReviewOverrides(existingSourceEvidence);
  return overrides.length === 0 ? { ...incoming } : { ...incoming, reviewOverrides: overrides };
}

export function applyReviewOverrides(
  incoming: RecipeImport,
  existing: RecipeImport,
  overrides: readonly ReviewOverrideField[],
): RecipeImport {
  const merged: RecipeImport = { ...incoming };
  for (const field of overrides) {
    if (field === "needsReview") continue;
    Object.assign(merged, { [field]: existing[field] });
  }
  return merged;
}
