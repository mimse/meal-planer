import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { DIETARY_TAGS } from "../domain/recipe";

export { DIETARY_TAGS } from "../domain/recipe";

const MAX_URL_LENGTH = 2_048;
const MAX_TITLE_LENGTH = 500;
const MAX_TAGS = 50;
const MAX_INGREDIENTS = 500;
const MAX_INSTRUCTIONS = 500;
const MAX_RAW_PAYLOAD_BYTES = 1_000_000;
const MAX_EVIDENCE_BYTES = 250_000;
const MAX_SOURCE_IDENTITY_CANDIDATES = 10_000;

export const SUITABILITY_TAGS = [
  "quick",
  "keepWarm",
  "reheatFriendly",
  "batchCook",
  "prepAhead",
] as const;

export const RECIPE_PREFERENCES = ["favorite", "neutral", "disliked"] as const;

const identifierSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const recipeIdSchema = z.string().regex(/^recipe:[a-f0-9]{64}$/);
const boundedText = (maximum: number, emptyMessage: string) => z.string().max(maximum).refine(
  (value) => value.trim().length > 0,
  emptyMessage,
);
const httpUrlSchema = z.string().max(MAX_URL_LENGTH).url().superRefine((value, context) => {
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    context.addIssue({ code: "custom", message: "Recipe URL must use HTTP or HTTPS" });
  }
  if (url.username !== "" || url.password !== "") {
    context.addIssue({ code: "custom", message: "Recipe URL must not contain credentials" });
  }
});
const tagInputSchema = boundedText(64, "Recipe tag cannot be empty");
const normalizedTagSchema = z.string().min(1).max(64).regex(
  /^[\p{L}\p{N}]+(?:-[\p{L}\p{N}]+)*$/u,
  "Recipe tag must use its normalized form",
);
const nullableMinutesSchema = z.number().int().finite().nonnegative().max(525_600).nullable();
const nullableQuantitySchema = z.number().finite().positive().max(1_000_000_000).nullable();

const ingredientInputSchema = z.object({
  rawText: boundedText(2_000, "Raw ingredient text cannot be empty"),
  normalizedName: boundedText(300, "Normalized ingredient name cannot be empty").nullable(),
  quantity: nullableQuantitySchema,
  unit: boundedText(100, "Ingredient unit cannot be empty").nullable(),
  uncertain: z.boolean(),
}).strict();

const recipeImportSchema = z.object({
  sourceId: identifierSchema,
  sourceUrl: httpUrlSchema,
  canonicalUrl: httpUrlSchema,
  title: boundedText(MAX_TITLE_LENGTH, "Recipe title cannot be empty"),
  author: boundedText(300, "Recipe author cannot be empty").nullable(),
  servings: z.number().finite().positive().max(1_000_000).nullable(),
  prepMinutes: nullableMinutesSchema,
  cookMinutes: nullableMinutesSchema,
  totalMinutes: nullableMinutesSchema,
  cuisineTags: z.array(tagInputSchema).max(MAX_TAGS),
  proteinTag: tagInputSchema.nullable(),
  dietaryTags: z.array(z.enum(DIETARY_TAGS)).max(MAX_TAGS),
  suitabilityTags: z.array(z.enum(SUITABILITY_TAGS)).max(SUITABILITY_TAGS.length),
  extraMealServings: z.number().finite().nonnegative().max(1_000_000),
  preference: z.enum(RECIPE_PREFERENCES),
  needsReview: z.boolean(),
  parserVersion: boundedText(100, "Parser version cannot be empty"),
  fetchedAt: z.string().max(50).datetime({ offset: true }),
  rawSourcePayload: z.unknown(),
  sourceEvidence: z.unknown(),
  ingredients: z.array(ingredientInputSchema).max(MAX_INGREDIENTS),
  instructions: z.array(boundedText(5_000, "Recipe instruction cannot be empty")).max(MAX_INSTRUCTIONS),
}).strict();

export type RecipeImport = z.infer<typeof recipeImportSchema>;
export type RecipeIngredient = z.infer<typeof ingredientInputSchema>;
export type Recipe = RecipeImport & {
  readonly id: string;
  readonly normalizedTitle: string;
};

export type RecipeSourceRefreshMerge = (incoming: RecipeImport, existing: Recipe) => RecipeImport;

const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const recipeRowSchema = z.object({
  id: z.string().regex(/^recipe:[a-f0-9]{64}$/),
  identityKey: z.string().min(1).max(2_200),
  sourceId: z.string().min(1).max(100),
  sourceUrl: z.string().min(1).max(MAX_URL_LENGTH),
  canonicalUrl: z.string().min(1).max(MAX_URL_LENGTH),
  normalizedCanonicalUrl: z.string().min(1).max(MAX_URL_LENGTH),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  normalizedTitle: z.string().min(1).max(MAX_TITLE_LENGTH),
  author: z.string().min(1).max(300).nullable(),
  servings: z.number().finite().nullable(),
  prepMinutes: z.number().finite().nullable(),
  cookMinutes: z.number().finite().nullable(),
  totalMinutes: z.number().finite().nullable(),
  cuisineTagsJson: z.string().max(10_000),
  proteinTag: z.string().min(1).max(64).nullable(),
  dietaryTagsJson: z.string().max(10_000),
  suitabilityTagsJson: z.string().max(10_000),
  extraMealServings: z.number().finite(),
  preference: z.string().max(20),
  needsReview: sqliteBooleanSchema,
  parserVersion: z.string().min(1).max(100),
  fetchedAt: z.string().min(1).max(50),
  rawSourcePayloadJson: z.string().max(MAX_RAW_PAYLOAD_BYTES),
  sourceEvidenceJson: z.string().max(MAX_EVIDENCE_BYTES),
}).strict();

const ingredientRowSchema = z.object({
  ordinal: z.number().int().nonnegative().max(MAX_INGREDIENTS),
  rawText: z.string().min(1).max(2_000),
  normalizedName: z.string().min(1).max(300).nullable(),
  quantity: z.number().finite().nullable(),
  unit: z.string().min(1).max(100).nullable(),
  uncertain: sqliteBooleanSchema,
}).strict();

const instructionRowSchema = z.object({
  ordinal: z.number().int().nonnegative().max(MAX_INSTRUCTIONS),
  text: z.string().min(1).max(5_000),
}).strict();

const listOptionsSchema = z.object({
  query: z.string().max(MAX_TITLE_LENGTH).optional(),
  sourceId: identifierSchema.optional(),
  cuisineTag: tagInputSchema.optional(),
  dietaryTag: z.enum(DIETARY_TAGS).optional(),
  suitabilityTag: z.enum(SUITABILITY_TAGS).optional(),
  preference: z.enum(RECIPE_PREFERENCES).optional(),
  needsReview: z.boolean().optional(),
  limit: z.number().int().positive().max(500).default(100),
}).strict();

export type RecipeListOptions = z.input<typeof listOptionsSchema>;

export function parseRecipeId(value: unknown): string {
  return recipeIdSchema.parse(value);
}

export function parseRecipeListOptions(value: unknown): z.output<typeof listOptionsSchema> {
  const parsed = listOptionsSchema.parse(value);
  if (parsed.query !== undefined) normalizeRecipeTitle(parsed.query);
  if (parsed.cuisineTag !== undefined) normalizeRecipeTag(parsed.cuisineTag);
  return parsed;
}

function normalizeText(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");
}

export function normalizeRecipeTitle(value: string): string {
  return z.string().min(1).max(MAX_TITLE_LENGTH).parse(normalizeText(value));
}

export function normalizeRecipeTag(value: string): string {
  const normalized = normalizeText(value).replace(/\s+/gu, "-");
  return normalizedTagSchema.parse(normalized);
}

function normalizePercentEncoding(value: string): string {
  return value.replace(/%([0-9a-f]{2})/gi, (_escape, hexadecimal: string) => {
    const byte = Number.parseInt(hexadecimal, 16);
    const isUnreserved = (
      (byte >= 0x41 && byte <= 0x5a)
      || (byte >= 0x61 && byte <= 0x7a)
      || (byte >= 0x30 && byte <= 0x39)
      || byte === 0x2d
      || byte === 0x2e
      || byte === 0x5f
      || byte === 0x7e
    );
    return isUnreserved ? String.fromCharCode(byte) : `%${hexadecimal.toUpperCase()}`;
  });
}

export function normalizeRecipeCanonicalUrl(value: string): string {
  if (/%(?![0-9a-f]{2})/i.test(value)) {
    throw new Error("Recipe canonical URL contains a malformed percent escape");
  }
  httpUrlSchema.parse(value);
  const url = new URL(value);
  url.hash = "";
  return z.string().min(1).max(MAX_URL_LENGTH).parse(normalizePercentEncoding(url.href));
}

function identityKeyForCanonicalUrl(canonicalUrl: string): string {
  return `canonical:${normalizeRecipeCanonicalUrl(canonicalUrl)}`;
}

export function createRecipeId(canonicalUrl: string): string {
  const identityKey = identityKeyForCanonicalUrl(canonicalUrl);
  return `recipe:${createHash("sha256").update(identityKey).digest("hex")}`;
}

function createRecipeIdFromIdentityKey(identityKey: string): string {
  return `recipe:${createHash("sha256").update(identityKey).digest("hex")}`;
}

function normalizeUniqueTags(values: readonly string[], label: string): string[] {
  const normalized = values.map(normalizeRecipeTag);
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`${label} contain duplicate normalized values`);
  }
  return normalized;
}

function assertJsonValue(value: unknown, label: string, depth = 0): void {
  if (depth > 30) throw new Error(`${label} exceeds the maximum nesting depth`);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`${label} contains a non-finite number`);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 10_000) throw new Error(`${label} contains too many array entries`);
    for (const entry of value) assertJsonValue(entry, label, depth + 1);
    return;
  }
  if (typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain JSON objects`);
    }
    const entries = Object.entries(value);
    if (entries.length > 10_000) throw new Error(`${label} contains too many object entries`);
    for (const [key, entry] of entries) {
      if (key.length > 500) throw new Error(`${label} contains an oversized object key`);
      assertJsonValue(entry, label, depth + 1);
    }
    return;
  }
  throw new Error(`${label} contains a value that JSON cannot represent`);
}

function encodeJson(value: unknown, label: string, maximumBytes: number): string {
  assertJsonValue(value, label);
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} is not valid JSON`);
  if (Buffer.byteLength(encoded, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  return encoded;
}

function decodeJson(value: string, label: string, maximumBytes: number): unknown {
  if (Buffer.byteLength(value, "utf8") > maximumBytes) {
    throw new Error(`${label} exceeds ${maximumBytes} bytes`);
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new Error(`${label} contains malformed JSON`);
  }
  assertJsonValue(decoded, label);
  return decoded;
}

function normalizeImport(input: unknown): RecipeImport & { readonly normalizedTitle: string } {
  const parsed = recipeImportSchema.parse(input);
  const normalizedTitle = normalizeRecipeTitle(parsed.title);
  const title = parsed.title.trim();
  const normalizedIngredients = parsed.ingredients.map((ingredient) => ({
    ...ingredient,
    normalizedName: ingredient.normalizedName === null ? null : normalizeText(ingredient.normalizedName),
    unit: ingredient.unit === null ? null : ingredient.unit.trim(),
  }));
  for (const ingredient of normalizedIngredients) {
    if (ingredient.normalizedName !== null) {
      z.string().min(1).max(300).parse(ingredient.normalizedName);
    }
  }
  return {
    ...parsed,
    title,
    normalizedTitle,
    author: parsed.author === null ? null : parsed.author.trim(),
    cuisineTags: normalizeUniqueTags(parsed.cuisineTags, "Cuisine tags"),
    proteinTag: parsed.proteinTag === null ? null : normalizeRecipeTag(parsed.proteinTag),
    dietaryTags: normalizeUniqueTags(parsed.dietaryTags, "Dietary tags") as RecipeImport["dietaryTags"],
    suitabilityTags: (() => {
      if (new Set(parsed.suitabilityTags).size !== parsed.suitabilityTags.length) {
        throw new Error("Suitability tags contain duplicate values");
      }
      return parsed.suitabilityTags;
    })(),
    parserVersion: parsed.parserVersion.trim(),
    ingredients: normalizedIngredients,
  };
}

const SELECT_RECIPE = `
  SELECT
    id, identity_key AS identityKey, source_id AS sourceId, source_url AS sourceUrl,
    canonical_url AS canonicalUrl, normalized_canonical_url AS normalizedCanonicalUrl,
    title, normalized_title AS normalizedTitle, author, servings,
    prep_minutes AS prepMinutes, cook_minutes AS cookMinutes, total_minutes AS totalMinutes,
    cuisine_tags AS cuisineTagsJson, protein_tag AS proteinTag,
    dietary_tags AS dietaryTagsJson, suitability_tags AS suitabilityTagsJson,
    extra_meal_servings AS extraMealServings, preference, needs_review AS needsReview,
    parser_version AS parserVersion, fetched_at AS fetchedAt,
    raw_source_payload AS rawSourcePayloadJson, source_evidence AS sourceEvidenceJson
  FROM recipes
`;

function assertContiguousOrdinals(rows: readonly { readonly ordinal: number }[], label: string): void {
  for (const [expected, row] of rows.entries()) {
    if (row.ordinal !== expected) {
      throw new Error(`${label} ordinals must be unique and contiguous from zero`);
    }
  }
}

export class RecipeRepository {
  constructor(private readonly database: Database) {}

  import(input: unknown): Recipe {
    return this.importInternal(input);
  }

  /**
   * Resolves identity first, then lets the application merge review-owned
   * fields in the same transaction before persistence.
   */
  importSourceRefresh(input: unknown, merge: RecipeSourceRefreshMerge): Recipe {
    return this.importInternal(input, merge);
  }

  private importInternal(input: unknown, merge?: RecipeSourceRefreshMerge): Recipe {
    const recipe = normalizeImport(input);
    const normalizedCanonicalUrl = normalizeRecipeCanonicalUrl(recipe.canonicalUrl);
    const requestedIdentityKey = identityKeyForCanonicalUrl(recipe.canonicalUrl);

    return this.database.transaction(() => {
      const canonicalMatch = this.database.query<{ id: string }, [string]>(
        "SELECT id FROM recipes WHERE normalized_canonical_url = ?",
      ).get(normalizedCanonicalUrl);
      const identityMatch = this.database.query<{
        id: string;
        sourceId: string;
        normalizedTitle: string;
      }, [string]>(`
        SELECT id, source_id AS sourceId, normalized_title AS normalizedTitle
        FROM recipes
        WHERE identity_key = ?
      `).get(requestedIdentityKey);
      const titleMatch = this.database.query<{ id: string }, [string, string]>(
        "SELECT id FROM recipes WHERE source_id = ? AND normalized_title = ?",
      ).get(recipe.sourceId, recipe.normalizedTitle);
      const normalizedSourceUrl = normalizeRecipeCanonicalUrl(recipe.sourceUrl);
      const sourceCandidates = this.database.query<{ id: string; sourceUrl: string }, [string, number]>(
        "SELECT id, source_url AS sourceUrl FROM recipes WHERE source_id = ? LIMIT ?",
      ).all(recipe.sourceId, MAX_SOURCE_IDENTITY_CANDIDATES + 1);
      if (sourceCandidates.length > MAX_SOURCE_IDENTITY_CANDIDATES) {
        throw new Error("Recipe source URL identity lookup exceeded its bounded candidate limit");
      }
      const sourceMatches = sourceCandidates.filter(({ sourceUrl }) =>
        normalizeRecipeCanonicalUrl(sourceUrl) === normalizedSourceUrl);
      if (sourceMatches.length > 1) {
        throw new Error("Recipe import is ambiguous: source URL matches multiple recipes in one source");
      }
      const sourceMatch = sourceMatches[0] ?? null;
      if (canonicalMatch !== null && identityMatch !== null && canonicalMatch.id !== identityMatch.id) {
        throw new Error("Recipe import is ambiguous: current canonical URL and stable canonical identity differ");
      }
      const canonicalIdentityMatch = canonicalMatch ?? identityMatch;
      if (
        canonicalIdentityMatch !== null
        && titleMatch !== null
        && canonicalIdentityMatch.id !== titleMatch.id
      ) {
        if (canonicalMatch !== null) {
          throw new Error("Recipe import is ambiguous: canonical URL and source/title match different recipes");
        }
        throw new Error("Recipe import is ambiguous: canonical identity and source/title match different recipes");
      }
      if (
        sourceMatch !== null
        && canonicalIdentityMatch !== null
        && sourceMatch.id !== canonicalIdentityMatch.id
      ) {
        throw new Error("Recipe import is ambiguous: source URL and canonical identity match different recipes");
      }
      if (sourceMatch !== null && titleMatch !== null && sourceMatch.id !== titleMatch.id) {
        throw new Error("Recipe import is ambiguous: source URL and source/title match different recipes");
      }
      if (
        canonicalMatch === null
        && identityMatch !== null
        && titleMatch === null
        && sourceMatch === null
        && (
          identityMatch.sourceId !== recipe.sourceId
          || identityMatch.normalizedTitle !== recipe.normalizedTitle
        )
      ) {
        throw new Error("Recipe import is ambiguous: historical canonical identity does not match source/title");
      }

      const existingId = canonicalIdentityMatch?.id ?? titleMatch?.id ?? sourceMatch?.id;
      const id = existingId ?? createRecipeIdFromIdentityKey(requestedIdentityKey);
      const idRow = this.database.query<{ id: string; identityKey: string }, [string]>(
        "SELECT id, identity_key AS identityKey FROM recipes WHERE id = ?",
      ).get(id);
      if (idRow !== null && idRow.identityKey !== requestedIdentityKey && existingId === undefined) {
        throw new Error(`Recipe identity collision for ${id}`);
      }
      const identityKey = idRow?.identityKey ?? requestedIdentityKey;
      let recipeToPersist = recipe;
      if (merge !== undefined && existingId !== undefined) {
        const existing = this.getInCurrentTransaction(existingId);
        if (existing === null) throw new Error(`Existing recipe could not be read: ${existingId}`);
        const { normalizedTitle: _normalizedTitle, ...incoming } = recipe;
        recipeToPersist = normalizeImport(merge(incoming, existing));
        if (
          recipeToPersist.sourceId !== recipe.sourceId
          || recipeToPersist.sourceUrl !== recipe.sourceUrl
          || recipeToPersist.canonicalUrl !== recipe.canonicalUrl
          || recipeToPersist.title !== recipe.title
        ) {
          throw new Error("Source refresh merge changed source-owned recipe identity");
        }
      }
      const rawSourcePayloadJson = encodeJson(
        recipeToPersist.rawSourcePayload,
        "Raw recipe source payload",
        MAX_RAW_PAYLOAD_BYTES,
      );
      const sourceEvidenceJson = encodeJson(
        recipeToPersist.sourceEvidence,
        "Recipe source evidence",
        MAX_EVIDENCE_BYTES,
      );

      this.database.query(`
        INSERT INTO recipes (
          id, identity_key, source_id, source_url, canonical_url, normalized_canonical_url,
          title, normalized_title, author, servings, prep_minutes, cook_minutes, total_minutes,
          cuisine_tags, protein_tag, dietary_tags, suitability_tags, extra_meal_servings,
          preference, needs_review, parser_version, fetched_at, raw_source_payload, source_evidence
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          source_id = excluded.source_id,
          source_url = excluded.source_url,
          canonical_url = excluded.canonical_url,
          normalized_canonical_url = excluded.normalized_canonical_url,
          title = excluded.title,
          normalized_title = excluded.normalized_title,
          author = excluded.author,
          servings = excluded.servings,
          prep_minutes = excluded.prep_minutes,
          cook_minutes = excluded.cook_minutes,
          total_minutes = excluded.total_minutes,
          cuisine_tags = excluded.cuisine_tags,
          protein_tag = excluded.protein_tag,
          dietary_tags = excluded.dietary_tags,
          suitability_tags = excluded.suitability_tags,
          extra_meal_servings = excluded.extra_meal_servings,
          preference = excluded.preference,
          needs_review = excluded.needs_review,
          parser_version = excluded.parser_version,
          fetched_at = excluded.fetched_at,
          raw_source_payload = excluded.raw_source_payload,
          source_evidence = excluded.source_evidence
      `).run(
        id,
        identityKey,
        recipeToPersist.sourceId,
        recipeToPersist.sourceUrl,
        recipeToPersist.canonicalUrl,
        normalizedCanonicalUrl,
        recipeToPersist.title,
        recipeToPersist.normalizedTitle,
        recipeToPersist.author,
        recipeToPersist.servings,
        recipeToPersist.prepMinutes,
        recipeToPersist.cookMinutes,
        recipeToPersist.totalMinutes,
        JSON.stringify(recipeToPersist.cuisineTags),
        recipeToPersist.proteinTag,
        JSON.stringify(recipeToPersist.dietaryTags),
        JSON.stringify(recipeToPersist.suitabilityTags),
        recipeToPersist.extraMealServings,
        recipeToPersist.preference,
        recipeToPersist.needsReview ? 1 : 0,
        recipeToPersist.parserVersion,
        recipeToPersist.fetchedAt,
        rawSourcePayloadJson,
        sourceEvidenceJson,
      );

      this.database.query("DELETE FROM recipe_ingredients WHERE recipe_id = ?").run(id);
      this.database.query("DELETE FROM recipe_instructions WHERE recipe_id = ?").run(id);
      const insertIngredient = this.database.query(`
        INSERT INTO recipe_ingredients (
          recipe_id, ordinal, raw_text, normalized_name, quantity, unit, uncertain
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
      `);
      for (const [ordinal, ingredient] of recipeToPersist.ingredients.entries()) {
        insertIngredient.run(
          id,
          ordinal,
          ingredient.rawText,
          ingredient.normalizedName,
          ingredient.quantity,
          ingredient.unit,
          ingredient.uncertain ? 1 : 0,
        );
      }
      const insertInstruction = this.database.query(`
        INSERT INTO recipe_instructions (recipe_id, ordinal, text) VALUES (?, ?, ?)
      `);
      for (const [ordinal, instruction] of recipeToPersist.instructions.entries()) {
        insertInstruction.run(id, ordinal, instruction);
      }

      const persisted = this.getInCurrentTransaction(id);
      if (persisted === null) throw new Error(`Imported recipe could not be read: ${id}`);
      return persisted;
    }).immediate();
  }

  get(id: string): Recipe | null {
    const parsedId = parseRecipeId(id);
    return this.database.transaction(() => this.getInCurrentTransaction(parsedId))();
  }

  private getInCurrentTransaction(id: string): Recipe | null {
    const rawRow = this.database.query<Record<string, unknown>, [string]>(
      `${SELECT_RECIPE} WHERE id = ?`,
    ).get(id);
    if (rawRow === null) return null;
    return this.toRecipe(rawRow);
  }

  list(options: RecipeListOptions = {}): Recipe[] {
    const parsed = parseRecipeListOptions(options);
    const clauses: string[] = [];
    const parameters: Array<string | number> = [];
    if (parsed.sourceId !== undefined) {
      clauses.push("source_id = ?");
      parameters.push(parsed.sourceId);
    }
    if (parsed.query !== undefined) {
      const query = normalizeRecipeTitle(parsed.query);
      clauses.push("instr(normalized_title, ?) > 0");
      parameters.push(query);
    }
    if (parsed.cuisineTag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(cuisine_tags) WHERE value = ?)");
      parameters.push(normalizeRecipeTag(parsed.cuisineTag));
    }
    if (parsed.dietaryTag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(dietary_tags) WHERE value = ?)");
      parameters.push(parsed.dietaryTag);
    }
    if (parsed.suitabilityTag !== undefined) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(suitability_tags) WHERE value = ?)");
      parameters.push(parsed.suitabilityTag);
    }
    if (parsed.preference !== undefined) {
      clauses.push("preference = ?");
      parameters.push(parsed.preference);
    }
    if (parsed.needsReview !== undefined) {
      clauses.push("needs_review = ?");
      parameters.push(parsed.needsReview ? 1 : 0);
    }
    parameters.push(parsed.limit);
    const where = clauses.length === 0 ? "" : ` WHERE ${clauses.join(" AND ")}`;
    return this.database.transaction(() => {
      const rows = this.database.query<Record<string, unknown>, Array<string | number>>(
        `${SELECT_RECIPE}${where} ORDER BY normalized_title, id LIMIT ?`,
      ).all(...parameters);
      return rows.map((row) => this.toRecipe(row));
    })();
  }

  search(query: string, options: Omit<RecipeListOptions, "query"> = {}): Recipe[] {
    return this.list({ ...options, query });
  }

  remove(id: string): boolean {
    const parsedId = parseRecipeId(id);
    return this.database.query("DELETE FROM recipes WHERE id = ?").run(parsedId).changes > 0;
  }

  private toRecipe(rawRow: unknown): Recipe {
    const row = recipeRowSchema.parse(rawRow);
    if (row.normalizedCanonicalUrl !== normalizeRecipeCanonicalUrl(row.canonicalUrl)) {
      throw new Error("Recipe normalized canonical URL does not match its canonical URL");
    }
    if (row.normalizedTitle !== normalizeRecipeTitle(row.title)) {
      throw new Error("Recipe normalized title does not match its title");
    }
    if (row.id !== createRecipeIdFromIdentityKey(row.identityKey)) {
      throw new Error("Recipe id does not match its stable identity");
    }

    const ingredientRows = this.database.query<Record<string, unknown>, [string, number]>(`
      SELECT ordinal, raw_text AS rawText, normalized_name AS normalizedName,
             quantity, unit, uncertain
      FROM recipe_ingredients
      WHERE recipe_id = ?
      ORDER BY ordinal
      LIMIT ?
    `).all(row.id, MAX_INGREDIENTS + 1).map((ingredient) => ingredientRowSchema.parse(ingredient));
    const instructionRows = this.database.query<Record<string, unknown>, [string, number]>(`
      SELECT ordinal, text
      FROM recipe_instructions
      WHERE recipe_id = ?
      ORDER BY ordinal
      LIMIT ?
    `).all(row.id, MAX_INSTRUCTIONS + 1).map((instruction) => instructionRowSchema.parse(instruction));
    if (ingredientRows.length > MAX_INGREDIENTS || instructionRows.length > MAX_INSTRUCTIONS) {
      throw new Error("Recipe contains more persisted child rows than allowed");
    }
    assertContiguousOrdinals(ingredientRows, "Recipe ingredient");
    assertContiguousOrdinals(instructionRows, "Recipe instruction");

    const rawSourcePayload = decodeJson(
      row.rawSourcePayloadJson,
      "Raw recipe source payload",
      MAX_RAW_PAYLOAD_BYTES,
    );
    const sourceEvidence = decodeJson(row.sourceEvidenceJson, "Recipe source evidence", MAX_EVIDENCE_BYTES);
    const cuisineTags = decodeJson(row.cuisineTagsJson, "Recipe cuisine tags", 10_000);
    const dietaryTags = decodeJson(row.dietaryTagsJson, "Recipe dietary tags", 10_000);
    const suitabilityTags = decodeJson(row.suitabilityTagsJson, "Recipe suitability tags", 10_000);
    const candidate = normalizeImport({
      sourceId: row.sourceId,
      sourceUrl: row.sourceUrl,
      canonicalUrl: row.canonicalUrl,
      title: row.title,
      author: row.author,
      servings: row.servings,
      prepMinutes: row.prepMinutes,
      cookMinutes: row.cookMinutes,
      totalMinutes: row.totalMinutes,
      cuisineTags,
      proteinTag: row.proteinTag,
      dietaryTags,
      suitabilityTags,
      extraMealServings: row.extraMealServings,
      preference: row.preference,
      needsReview: row.needsReview === 1,
      parserVersion: row.parserVersion,
      fetchedAt: row.fetchedAt,
      rawSourcePayload,
      sourceEvidence,
      ingredients: ingredientRows.map((ingredient) => ({
        rawText: ingredient.rawText,
        normalizedName: ingredient.normalizedName,
        quantity: ingredient.quantity,
        unit: ingredient.unit,
        uncertain: ingredient.uncertain === 1,
      })),
      instructions: instructionRows.map(({ text }) => text),
    });
    if (candidate.normalizedTitle !== row.normalizedTitle) {
      throw new Error("Recipe normalized title changed during validation");
    }
    if (
      candidate.sourceId !== row.sourceId
      || candidate.sourceUrl !== row.sourceUrl
      || candidate.canonicalUrl !== row.canonicalUrl
      || candidate.title !== row.title
      || candidate.author !== row.author
      || candidate.parserVersion !== row.parserVersion
    ) {
      throw new Error("Recipe persisted text is not in normalized form");
    }
    if (
      JSON.stringify(cuisineTags) !== JSON.stringify(candidate.cuisineTags)
      || row.proteinTag !== candidate.proteinTag
      || JSON.stringify(dietaryTags) !== JSON.stringify(candidate.dietaryTags)
      || JSON.stringify(suitabilityTags) !== JSON.stringify(candidate.suitabilityTags)
    ) {
      throw new Error("Recipe persisted tags are not in normalized form");
    }
    for (const [index, ingredient] of candidate.ingredients.entries()) {
      if (
        ingredient.normalizedName !== ingredientRows[index]?.normalizedName
        || ingredient.unit !== ingredientRows[index]?.unit
      ) {
        throw new Error("Recipe ingredient normalized name or unit does not match its persisted value");
      }
    }
    return { id: row.id, ...candidate };
  }
}

export function createRecipeRepository(database: Database): RecipeRepository {
  return new RecipeRepository(database);
}
