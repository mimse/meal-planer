import type { Database } from "bun:sqlite";
import { BUILT_IN_RECIPE_SOURCES } from "../adapters/recipes/sources";
import type { RecipeFetchDependencies } from "../adapters/recipes/fetch";
import { createConfigurationRepositories } from "../infrastructure/configuration-repositories";
import { HostRateLimiter } from "../infrastructure/host-rate-limiter";
import { HttpCacheRepository } from "../infrastructure/http-cache-repository";
import { CachedResourceFetcher } from "./cached-resource-fetcher";
import {
  discoverRecipeUrls,
  type DiscoveryFetcher,
  type DiscoveryLimits,
} from "./source-discovery";

export type SourceTestReport = {
  readonly sourceId: string;
  readonly discoveryRoutes: readonly string[];
  readonly count: number;
  readonly capped: boolean;
  readonly sampleRecipeUrls: readonly string[];
  readonly cache: {
    readonly misses: number;
    readonly refreshed: number;
    readonly revalidated: number;
  };
  readonly warnings: readonly string[];
};

export type SourceTestDependencies = {
  readonly discoveryFetcher?: DiscoveryFetcher;
  readonly fetchDependencies?: RecipeFetchDependencies;
  readonly discoveryLimits?: Partial<DiscoveryLimits>;
  readonly minimumSpacingMs?: number;
};

function boundedWarnings(warnings: readonly string[]): string[] {
  return warnings.slice(0, 50).map((warning) => warning.slice(0, 500));
}

export async function runSourceTest(
  database: Database,
  sourceId: string,
  dependencies: SourceTestDependencies = {},
): Promise<SourceTestReport> {
  const source = createConfigurationRepositories(database).recipeSources.get(sourceId);
  if (source === null) throw new Error(`Recipe source does not exist: ${sourceId}`);
  if (!source.enabled) throw new Error(`Recipe source is disabled: ${sourceId}`);

  const builtIn = BUILT_IN_RECIPE_SOURCES.find(({ id, baseUrl }) =>
    id === source.id && new URL(baseUrl).href === new URL(source.baseUrl).href);
  const discoveryFetcher = dependencies.discoveryFetcher ?? new CachedResourceFetcher(
    new HttpCacheRepository(database, {
      maxEntries: 256,
      maxBodyBytes: 2 * 1024 * 1024,
    }),
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
            "user-agent": "meal-planer/0.1 source-discovery",
            ...Object.fromEntries(new Headers(dependencies.fetchDependencies?.requestInit?.headers).entries()),
          }),
        },
      },
    },
  );
  const discovered = await discoverRecipeUrls({
    id: source.id,
    baseUrl: source.baseUrl,
    discoveryUrl: builtIn?.discoveryUrl ?? null,
    recipeScope: builtIn === undefined ? "path" : "site",
  }, discoveryFetcher, dependencies.discoveryLimits);

  return {
    sourceId: source.id,
    discoveryRoutes: discovered.routes,
    count: discovered.recipeUrls.length,
    capped: discovered.capped,
    sampleRecipeUrls: discovered.sampleRecipeUrls,
    cache: discovered.cache,
    warnings: boundedWarnings(discovered.warnings),
  };
}
