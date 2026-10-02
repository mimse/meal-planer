import type { Database } from "bun:sqlite";
import { normalizeIngredient } from "../domain/ingredients";
import type { ExtractedRecipe } from "../adapters/recipes/extraction";
import { extractRecipeWithAdapter } from "../adapters/recipes/registry";
import type { RecipeFetchDependencies } from "../adapters/recipes/fetch";
import { BUILT_IN_RECIPE_SOURCES, normalizeRecipeSourceHost } from "../adapters/recipes/sources";
import {
  createConfigurationRepositories,
  type RecipeSource,
} from "../infrastructure/configuration-repositories";
import { HostRateLimiter } from "../infrastructure/host-rate-limiter";
import { HttpCacheRepository } from "../infrastructure/http-cache-repository";
import {
  createRecipeRepository,
  type Recipe,
  type RecipeImport,
} from "../infrastructure/recipe-repository";
import { CachedResourceFetcher, type CachedFetchResult } from "./cached-resource-fetcher";
import { assertSafeRawUrlPath, assertUrlWithinSourcePath } from "../adapters/recipes/path-scope";
import {
  applyReviewOverrides,
  parseReviewOverrides,
  preserveReviewOverrideMetadata,
} from "./recipe-review-overrides";

export const DEFAULT_RECIPE_LIMIT = 50;
export const MAX_RECIPE_LIMIT = 100;

function assertValidPercentEscapes(value: string): void {
  if (/%(?![0-9a-f]{2})/iu.test(value)) {
    throw new Error("Recipe URL contains a malformed percent escape");
  }
}

function isExactBuiltInSource(source: RecipeSource): boolean {
  return BUILT_IN_RECIPE_SOURCES.some((builtIn) =>
    builtIn.id === source.id && new URL(builtIn.baseUrl).href === new URL(source.baseUrl).href);
}

function recipeFetchScope(source: RecipeSource): URL {
  const base = new URL(source.baseUrl);
  return isExactBuiltInSource(source) ? new URL(`${base.origin}/`) : base;
}

export function validateRecipeUrlForSource(value: string | URL, source: RecipeSource): URL {
  assertValidPercentEscapes(value instanceof URL ? value.href : value);
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value);
  } catch {
    throw new Error("Recipe URL is not a valid URL");
  }
  if (url.href.length > 2_048) throw new Error("Recipe URL exceeds 2048 characters");
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Recipe URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error("Recipe URL must not contain credentials");
  }
  if (url.hash !== "") throw new Error("Recipe URL must not contain a fragment");

  const base = new URL(source.baseUrl);
  if (
    url.protocol !== base.protocol
    || url.port !== base.port
    || normalizeRecipeSourceHost(url.hostname) !== normalizeRecipeSourceHost(base.hostname)
  ) {
    throw new Error(`Recipe URL is outside configured source site: ${source.id}`);
  }
  if (!isExactBuiltInSource(source)) {
    try {
      assertUrlWithinSourcePath(url, base, "Recipe URL", typeof value === "string" ? value : undefined);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("outside configured source path scope")) {
        throw new Error(`Recipe URL is outside configured source path: ${source.id}`);
      }
      throw error;
    }
  }
  return url;
}

export function parseRecipeLimit(value: string | number | undefined): number {
  const parsed = value === undefined ? DEFAULT_RECIPE_LIMIT : typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_RECIPE_LIMIT) {
    throw new Error(`Recipe limit must be a positive integer between 1 and ${MAX_RECIPE_LIMIT}`);
  }
  return parsed;
}

type PlanningEvidence = Pick<
  ExtractedRecipe,
  "servings" | "prepMinutes" | "cookMinutes" | "totalMinutes" | "dietaryTags"
> & { readonly rawIngredients?: readonly string[]; readonly ingredients?: readonly unknown[] };

/**
 * Planning-critical evidence is complete only when servings are known, at
 * least one duration is known, at least one ingredient exists, and at least
 * one explicit dietary classification exists.
 */
export function hasPlanningCriticalEvidence(recipe: PlanningEvidence): boolean {
  const ingredientCount = recipe.rawIngredients?.length ?? recipe.ingredients?.length ?? 0;
  return recipe.servings !== null
    && (recipe.prepMinutes !== null || recipe.cookMinutes !== null || recipe.totalMinutes !== null)
    && ingredientCount > 0
    && recipe.dietaryTags.length > 0;
}

function mergeReviewOverridesOnRefresh(incoming: RecipeImport, existing: Recipe): RecipeImport {
  const overrides = parseReviewOverrides(existing.sourceEvidence);
  const merged = applyReviewOverrides(incoming, existing, overrides);
  merged.sourceEvidence = preserveReviewOverrideMetadata(incoming.sourceEvidence, existing.sourceEvidence);
  const incomplete = !hasPlanningCriticalEvidence(merged);
  merged.needsReview = incomplete
    || (overrides.includes("needsReview") && existing.needsReview);
  return merged;
}

export type RecipeMappingEvidence = {
  readonly requestUrl: string;
  readonly finalUrl: string;
  readonly fetchedAt: string;
  readonly cacheStatus: "miss" | "refreshed" | "revalidated";
};

export function mapExtractedRecipeToImport(
  source: RecipeSource,
  extracted: ExtractedRecipe,
  evidence: RecipeMappingEvidence,
): RecipeImport {
  validateRecipeUrlForSource(extracted.sourceUrl, source);
  validateRecipeUrlForSource(extracted.canonicalUrl, source);
  validateRecipeUrlForSource(evidence.requestUrl, source);
  validateRecipeUrlForSource(evidence.finalUrl, source);

  return {
    sourceId: source.id,
    sourceUrl: extracted.sourceUrl,
    canonicalUrl: extracted.canonicalUrl,
    title: extracted.title,
    author: extracted.author,
    servings: extracted.servings,
    prepMinutes: extracted.prepMinutes,
    cookMinutes: extracted.cookMinutes,
    totalMinutes: extracted.totalMinutes,
    cuisineTags: [],
    proteinTag: null,
    dietaryTags: [...extracted.dietaryTags],
    suitabilityTags: [],
    extraMealServings: 0,
    preference: "neutral",
    needsReview: !hasPlanningCriticalEvidence(extracted),
    parserVersion: `${source.adapter}@1`,
    fetchedAt: evidence.fetchedAt,
    rawSourcePayload: extracted.raw,
    sourceEvidence: {
      adapter: source.adapter,
      cacheStatus: evidence.cacheStatus,
      configuredSourceId: source.id,
      configuredBaseUrl: source.baseUrl,
      requestUrl: evidence.requestUrl,
      finalUrl: evidence.finalUrl,
      extractedSourceUrl: extracted.sourceUrl,
      extractedCanonicalUrl: extracted.canonicalUrl,
    },
    ingredients: extracted.rawIngredients.map(normalizeIngredient),
    instructions: [...extracted.instructions],
  };
}

export type RecipeResourceFetcher = {
  fetch(url: URL, kind: "recipe", sourceScope?: URL): Promise<CachedFetchResult>;
};

export type ImportRecipeDependencies = {
  readonly resourceFetcher?: RecipeResourceFetcher;
  readonly fetchDependencies?: RecipeFetchDependencies;
  readonly minimumSpacingMs?: number;
  readonly now?: () => string;
};

export type ImportRecipeResult = {
  readonly sourceId: string;
  readonly cacheStatus: CachedFetchResult["cacheStatus"];
  readonly recipe: Recipe;
};

export function createRecipeResourceFetcher(
  database: Database,
  dependencies: Pick<ImportRecipeDependencies, "fetchDependencies" | "minimumSpacingMs"> = {},
): CachedResourceFetcher {
  return new CachedResourceFetcher(
    new HttpCacheRepository(database, { maxEntries: 256, maxBodyBytes: 2 * 1024 * 1024 }),
    new HostRateLimiter({
      minimumSpacingMs: dependencies.minimumSpacingMs ?? 1_000,
      maxHosts: 64,
    }),
    {
      fetchDependencies: {
        ...dependencies.fetchDependencies,
        requestInit: {
          ...dependencies.fetchDependencies?.requestInit,
          headers: new Headers({
            "user-agent": "meal-planer/0.1 recipe-ingestion",
            ...Object.fromEntries(new Headers(dependencies.fetchDependencies?.requestInit?.headers).entries()),
          }),
        },
      },
    },
  );
}

export function parseRecipeRequestUrl(value: string): URL {
  assertValidPercentEscapes(value);
  assertSafeRawUrlPath(value, "Recipe URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Recipe URL is not a valid URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Recipe URL must use HTTP or HTTPS");
  }
  if (url.username !== "" || url.password !== "") throw new Error("Recipe URL must not contain credentials");
  if (url.hash !== "") throw new Error("Recipe URL must not contain a fragment");
  if (url.href.length > 2_048) throw new Error("Recipe URL exceeds 2048 characters");
  return url;
}

export function resolveRecipeSource(
  database: Database,
  url: URL,
  sourceId?: string,
  rawUrl?: string,
): RecipeSource {
  const sources = createConfigurationRepositories(database).recipeSources;
  if (sourceId !== undefined) {
    const source = sources.get(sourceId);
    if (source === null) throw new Error(`Recipe source does not exist: ${sourceId}`);
    if (!source.enabled) throw new Error(`Recipe source is disabled: ${sourceId}`);
    validateRecipeUrlForSource(rawUrl ?? url, source);
    return source;
  }

  const normalizedHost = normalizeRecipeSourceHost(url.hostname);
  const matches = sources.list().filter((source) =>
    source.enabled && normalizeRecipeSourceHost(new URL(source.baseUrl).hostname) === normalizedHost);
  if (matches.length === 0) throw new Error(`No enabled recipe source matches host: ${normalizedHost}`);
  if (matches.length > 1) {
    throw new Error(`Ambiguous enabled recipe sources for host ${normalizedHost}: ${matches.map(({ id }) => id).join(", ")}`);
  }
  validateRecipeUrlForSource(rawUrl ?? url, matches[0]!);
  return matches[0]!;
}

export async function importRecipeUrl(
  database: Database,
  input: { readonly url: string; readonly sourceId?: string },
  dependencies: ImportRecipeDependencies = {},
): Promise<ImportRecipeResult> {
  const requestUrl = parseRecipeRequestUrl(input.url);
  const source = resolveRecipeSource(database, requestUrl, input.sourceId, input.url);
  const resourceFetcher = dependencies.resourceFetcher ?? createRecipeResourceFetcher(database, dependencies);
  const fetched = await resourceFetcher.fetch(requestUrl, "recipe", recipeFetchScope(source));
  const finalUrl = validateRecipeUrlForSource(fetched.resource.url, source);
  const extracted = extractRecipeWithAdapter(source.adapter, fetched.resource.body, finalUrl);
  const imported = mapExtractedRecipeToImport(source, extracted, {
    requestUrl: requestUrl.href,
    finalUrl: finalUrl.href,
    fetchedAt: (dependencies.now ?? (() => new Date().toISOString()))(),
    cacheStatus: fetched.cacheStatus,
  });
  return {
    sourceId: source.id,
    cacheStatus: fetched.cacheStatus,
    recipe: createRecipeRepository(database).importSourceRefresh(imported, mergeReviewOverridesOnRefresh),
  };
}
