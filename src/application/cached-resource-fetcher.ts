import {
  fetchPublicResource,
  type FetchedPublicResource,
  type PublicResourceKind,
  type PublicResourceOptions,
  type RecipeFetchDependencies,
} from "../adapters/recipes/fetch";
import { HostRateLimiter } from "../infrastructure/host-rate-limiter";
import { HttpCacheRepository, type HttpCacheEntry } from "../infrastructure/http-cache-repository";

const MEDIA_TYPES: Readonly<Record<PublicResourceKind, readonly string[]>> = {
  robots: ["text/plain"],
  sitemap: ["application/xml", "text/xml"],
  recipe: ["text/html", "application/xhtml+xml"],
};

type ResourceFetch = (
  url: URL,
  options: PublicResourceOptions,
  dependencies: RecipeFetchDependencies,
) => Promise<FetchedPublicResource>;

export type CachedResourceFetcherDependencies = {
  readonly fetchResource?: ResourceFetch;
  readonly fetchDependencies?: RecipeFetchDependencies;
};

export type CachedFetchResult = {
  readonly resource: FetchedPublicResource;
  readonly cacheStatus: "miss" | "refreshed" | "revalidated";
};

function resourceFromCache(entry: HttpCacheEntry): FetchedPublicResource {
  return {
    body: entry.body,
    url: new URL(entry.finalUrl),
    mediaType: entry.mediaType,
    status: 200,
    etag: entry.etag,
    lastModified: entry.lastModified,
  };
}

function assertMediaType(kind: PublicResourceKind, mediaType: string | null): asserts mediaType is string {
  if (mediaType === null || !MEDIA_TYPES[kind].includes(mediaType)) {
    throw new Error(`Cached ${kind} response has unsupported Content-Type: ${mediaType ?? "missing"}`);
  }
}

const MAX_ACTIVE_CACHE_KEYS = 256;

export class CachedResourceFetcher {
  private readonly fetchResource: ResourceFetch;
  private readonly fetchDependencies: RecipeFetchDependencies;
  private readonly cacheKeyLocks = new Map<string, Promise<void>>();

  constructor(
    private readonly cache: HttpCacheRepository,
    private readonly limiter: HostRateLimiter,
    dependencies: CachedResourceFetcherDependencies = {},
  ) {
    this.fetchResource = dependencies.fetchResource ?? fetchPublicResource;
    this.fetchDependencies = dependencies.fetchDependencies ?? {};
  }

  async fetch(url: URL, kind: PublicResourceKind, sourceScope?: URL): Promise<CachedFetchResult> {
    const requestUrl = new URL(url);
    requestUrl.hash = "";
    return this.withCacheKeyLock(requestUrl.href, () => this.fetchLocked(requestUrl, kind, sourceScope));
  }

  private async withCacheKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.cacheKeyLocks.get(key);
    if (previous === undefined && this.cacheKeyLocks.size >= MAX_ACTIVE_CACHE_KEYS) {
      throw new Error(`Too many concurrent HTTP cache keys; limit is ${MAX_ACTIVE_CACHE_KEYS}`);
    }

    let release!: () => void;
    const current = new Promise<void>((resolve) => { release = resolve; });
    this.cacheKeyLocks.set(key, current);
    if (previous !== undefined) await previous;

    try {
      return await operation();
    } finally {
      release();
      if (this.cacheKeyLocks.get(key) === current) this.cacheKeyLocks.delete(key);
    }
  }

  private async fetchLocked(
    requestUrl: URL,
    kind: PublicResourceKind,
    sourceScope?: URL,
  ): Promise<CachedFetchResult> {
    const cached = this.cache.get(requestUrl.href);
    if (cached !== null) assertMediaType(kind, cached.mediaType);

    const headers = new Headers(this.fetchDependencies.requestInit?.headers);
    headers.delete("if-none-match");
    headers.delete("if-modified-since");
    if (cached?.etag) headers.set("if-none-match", cached.etag);
    if (cached?.lastModified) headers.set("if-modified-since", cached.lastModified);
    const conditionalRequest = cached !== null && (cached.etag !== null || cached.lastModified !== null);
    const dependencies: RecipeFetchDependencies = {
      ...this.fetchDependencies,
      requestInit: {
        ...this.fetchDependencies.requestInit,
        headers,
      },
      requestGate: (requestUrl, operation) => this.limiter.run(requestUrl, operation),
    };

    const resource = await this.fetchResource(requestUrl, {
      kind,
      allowNotModified: conditionalRequest,
      ...(sourceScope === undefined ? {} : { sourceScope }),
    }, dependencies);
    if (resource.status === 304) {
      if (cached === null || !conditionalRequest) {
        throw new Error(`Received HTTP 304 without a conditional request and valid cached body: ${requestUrl.href}`);
      }
      if (resource.url.href !== cached.finalUrl) {
        throw new Error(`HTTP 304 final URL does not match the cached final URL: ${resource.url.href}`);
      }
      const revalidated = this.cache.put({
        url: cached.url,
        finalUrl: cached.finalUrl,
        mediaType: cached.mediaType,
        body: cached.body,
        etag: resource.etag ?? cached.etag,
        lastModified: resource.lastModified ?? cached.lastModified,
      });
      return { resource: resourceFromCache(revalidated), cacheStatus: "revalidated" };
    }

    assertMediaType(kind, resource.mediaType);
    const stored = this.cache.put({
      url: requestUrl.href,
      finalUrl: resource.url.href,
      mediaType: resource.mediaType,
      body: resource.body,
      etag: resource.etag,
      lastModified: resource.lastModified,
    });
    return {
      resource: resourceFromCache(stored),
      cacheStatus: cached === null ? "miss" : "refreshed",
    };
  }
}
