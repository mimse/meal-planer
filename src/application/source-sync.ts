import type { Database } from "bun:sqlite";
import { BUILT_IN_RECIPE_SOURCES } from "../adapters/recipes/sources";
import { createConfigurationRepositories, type RecipeSource } from "../infrastructure/configuration-repositories";
import {
  discoverRecipeUrls,
  type DiscoveryFetcher,
  type DiscoveryLimits,
  type DiscoverySource,
  type SourceDiscoveryResult,
} from "./source-discovery";
import {
  createRecipeResourceFetcher,
  importRecipeUrl,
  parseRecipeLimit,
  type ImportRecipeDependencies,
} from "./recipe-ingestion";

const MAX_REPORT_DETAILS = 50;
const MAX_REPORT_TEXT = 500;

export type SourceSyncFailure = {
  readonly url: string | null;
  readonly error: string;
};

export type SourceSyncSourceReport = {
  readonly sourceId: string;
  readonly status: "completed" | "partial" | "failed";
  readonly discovered: number;
  readonly attempted: number;
  readonly imported: number;
  readonly failed: number;
  readonly capped: boolean;
  readonly cache: SourceDiscoveryResult["cache"];
  readonly warnings: readonly string[];
  readonly failures: readonly SourceSyncFailure[];
};

export type SourceSyncReport = {
  readonly limitPerSource: number;
  readonly sources: readonly SourceSyncSourceReport[];
  readonly totals: {
    readonly sources: number;
    readonly discovered: number;
    readonly attempted: number;
    readonly imported: number;
    readonly failed: number;
  };
};

export type SourceSyncDependencies = Pick<
  ImportRecipeDependencies,
  "fetchDependencies" | "minimumSpacingMs" | "now"
> & {
  readonly resourceFetcher?: DiscoveryFetcher;
  readonly discover?: (
    source: DiscoverySource,
    fetcher: DiscoveryFetcher,
    limits: Partial<DiscoveryLimits>,
  ) => Promise<SourceDiscoveryResult>;
};

function boundedText(value: unknown): string {
  return (value instanceof Error ? value.message : String(value)).slice(0, MAX_REPORT_TEXT);
}

function boundedWarnings(values: readonly string[]): string[] {
  return values.slice(0, MAX_REPORT_DETAILS).map((value) => value.slice(0, MAX_REPORT_TEXT));
}

function discoverySource(source: RecipeSource): DiscoverySource {
  const builtIn = BUILT_IN_RECIPE_SOURCES.find(({ id, baseUrl }) =>
    id === source.id && new URL(baseUrl).href === new URL(source.baseUrl).href);
  return {
    id: source.id,
    baseUrl: source.baseUrl,
    discoveryUrl: builtIn?.discoveryUrl ?? null,
    recipeScope: builtIn === undefined ? "path" : "site",
  };
}

function selectedSources(database: Database, sourceId: string | undefined): RecipeSource[] {
  const repository = createConfigurationRepositories(database).recipeSources;
  if (sourceId === undefined) return repository.list().filter(({ enabled }) => enabled);
  const source = repository.get(sourceId);
  if (source === null) throw new Error(`Recipe source does not exist: ${sourceId}`);
  if (!source.enabled) throw new Error(`Recipe source is disabled: ${sourceId}`);
  return [source];
}

export async function runSourceSync(
  database: Database,
  input: { readonly sourceId?: string; readonly limit?: string | number } = {},
  dependencies: SourceSyncDependencies = {},
): Promise<SourceSyncReport> {
  const limit = parseRecipeLimit(input.limit);
  const sources = selectedSources(database, input.sourceId);
  const fetcher = dependencies.resourceFetcher ?? createRecipeResourceFetcher(database, dependencies);
  const discover = dependencies.discover ?? discoverRecipeUrls;
  const sourceReports: SourceSyncSourceReport[] = [];

  for (const source of sources) {
    let discovered: SourceDiscoveryResult;
    try {
      discovered = await discover(discoverySource(source), fetcher, {
        maxRecipeUrls: limit,
        sampleSize: Math.min(limit, 10),
      });
    } catch (error) {
      sourceReports.push({
        sourceId: source.id,
        status: "failed",
        discovered: 0,
        attempted: 0,
        imported: 0,
        failed: 0,
        capped: false,
        cache: { misses: 0, refreshed: 0, revalidated: 0 },
        warnings: [],
        failures: [{ url: null, error: boundedText(error) }],
      });
      continue;
    }

    const urls = discovered.recipeUrls.slice(0, limit);
    const failures: SourceSyncFailure[] = [];
    const importedRecipeIds = new Set<string>();
    let successfulAttempts = 0;
    for (const url of urls) {
      try {
        const result = await importRecipeUrl(database, { url, sourceId: source.id }, {
          resourceFetcher: fetcher,
          ...(dependencies.now === undefined ? {} : { now: dependencies.now }),
        });
        successfulAttempts += 1;
        importedRecipeIds.add(result.recipe.id);
      } catch (error) {
        if (failures.length < MAX_REPORT_DETAILS) failures.push({ url, error: boundedText(error) });
      }
    }
    const imported = importedRecipeIds.size;
    const failed = urls.length - successfulAttempts;
    sourceReports.push({
      sourceId: source.id,
      status: failed === 0 ? "completed" : successfulAttempts === 0 ? "failed" : "partial",
      discovered: urls.length,
      attempted: urls.length,
      imported,
      failed,
      capped: discovered.capped || discovered.recipeUrls.length > limit,
      cache: discovered.cache,
      warnings: boundedWarnings(discovered.warnings),
      failures,
    });
  }

  return {
    limitPerSource: limit,
    sources: sourceReports,
    totals: {
      sources: sourceReports.length,
      discovered: sourceReports.reduce((total, source) => total + source.discovered, 0),
      attempted: sourceReports.reduce((total, source) => total + source.attempted, 0),
      imported: sourceReports.reduce((total, source) => total + source.imported, 0),
      failed: sourceReports.reduce((total, source) => total + source.failed, 0),
    },
  };
}
