import type { PublicResourceKind } from "../adapters/recipes/fetch";
import type { CachedFetchResult } from "./cached-resource-fetcher";
import { SaxesParser, type SaxesTagNS } from "saxes";
import { assertUrlWithinSourcePath } from "../adapters/recipes/path-scope";

const MAX_URL_LENGTH = 2_048;
const MAX_ROBOTS_LINES = 10_000;
const MAX_ROBOTS_LINE_LENGTH = 4_096;
const MAX_XML_ELEMENTS = 100_000;
const MAX_XML_DEPTH = 64;
const MAX_XML_TEXT_LENGTH = MAX_URL_LENGTH * 2;
const MAX_SITEMAP_LOCATIONS = 50_000;

export type DiscoverySource = {
  readonly id: string;
  readonly baseUrl: string;
  readonly discoveryUrl: string | null;
  readonly recipeScope?: "path" | "site";
};

export type DiscoveryFetcher = {
  fetch(url: URL, kind: PublicResourceKind, sourceScope?: URL): Promise<CachedFetchResult>;
};

export type DiscoveryLimits = {
  readonly maxSitemaps: number;
  readonly maxDepth: number;
  readonly maxRecipeUrls: number;
  readonly sampleSize: number;
};

export type SourceDiscoveryResult = {
  readonly sourceId: string;
  readonly routes: readonly string[];
  readonly recipeUrls: readonly string[];
  readonly sampleRecipeUrls: readonly string[];
  readonly capped: boolean;
  readonly cache: {
    readonly misses: number;
    readonly refreshed: number;
    readonly revalidated: number;
  };
  readonly warnings: readonly string[];
};

const DEFAULT_LIMITS: DiscoveryLimits = {
  maxSitemaps: 32,
  maxDepth: 3,
  maxRecipeUrls: 500,
  sampleSize: 10,
};

function assertLimits(limits: DiscoveryLimits): void {
  const maxima: DiscoveryLimits = {
    maxSitemaps: 1_000,
    maxDepth: 10,
    maxRecipeUrls: 10_000,
    sampleSize: 100,
  };
  for (const key of Object.keys(limits) as Array<keyof DiscoveryLimits>) {
    const value = limits[key];
    if (!Number.isSafeInteger(value) || value <= 0 || value > maxima[key]) {
      throw new Error(`Invalid source discovery limit: ${key}`);
    }
  }
}

function scopedUrl(value: string | URL, base: URL, label: string): URL {
  const rawValue = value instanceof URL ? value.href : value;
  if (/%(?![0-9a-f]{2})/iu.test(rawValue)) throw new Error(`${label} contains a malformed percent escape`);
  let url: URL;
  try {
    url = value instanceof URL ? new URL(value) : new URL(value, base);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.href.length > MAX_URL_LENGTH) throw new Error(`${label} exceeds ${MAX_URL_LENGTH} characters`);
  if (url.username !== "" || url.password !== "") throw new Error(`${label} must not contain credentials`);
  if (url.protocol !== base.protocol) throw new Error(`${label} changed source scheme`);
  const sourceHost = base.hostname.toLowerCase().replace(/^www\./u, "");
  const candidateHost = url.hostname.toLowerCase().replace(/^www\./u, "");
  if (sourceHost !== candidateHost || url.port !== base.port) {
    throw new Error(`${label} is outside configured source host scope`);
  }
  url.hash = "";
  return url;
}

function canonicalScopeKey(url: URL): string {
  const identity = new URL(url);
  identity.hostname = identity.hostname.toLowerCase().replace(/^www\./u, "");
  return identity.href;
}

export function parseRobotsSitemaps(
  body: string,
  robotsUrl: URL,
  sourceBaseUrl: URL,
  onInvalid?: (message: string) => void,
): URL[] {
  const lines = body.split(/\r?\n/u);
  if (lines.length > MAX_ROBOTS_LINES) throw new Error("robots.txt contains too many lines");
  const results: URL[] = [];
  const seen = new Set<string>();
  for (const line of lines) {
    if (line.length > MAX_ROBOTS_LINE_LENGTH) throw new Error("robots.txt contains an oversized line");
    const match = /^\s*sitemap\s*:\s*(\S.*?)\s*$/iu.exec(line);
    if (!match) continue;
    try {
      let resolved: URL;
      try {
        resolved = new URL(match[1]!, robotsUrl);
      } catch {
        throw new Error("Robots sitemap URL is not a valid URL");
      }
      const url = scopedUrl(resolved, sourceBaseUrl, "Robots sitemap URL");
      if (!seen.has(url.href)) {
        seen.add(url.href);
        results.push(url);
      }
    } catch (error) {
      if (onInvalid === undefined) throw error;
      onInvalid(error instanceof Error ? error.message : String(error));
    }
  }
  return results;
}

type ParsedSitemap = {
  readonly kind: "index" | "urlset";
  readonly locations: readonly string[];
};

const SITEMAP_NAMESPACE = "http://www.sitemaps.org/schemas/sitemap/0.9";

type XmlElement = {
  readonly localName: string;
  readonly namespace: string | null;
  text: string;
  hasChild: boolean;
};

export function parseSitemapXml(xml: string, onInvalidLocation?: (message: string) => void): ParsedSitemap {
  const stack: XmlElement[] = [];
  const locations: string[] = [];
  let rootKind: ParsedSitemap["kind"] | null = null;
  let rootNamespace: string | null = null;
  let elements = 0;

  const parser = new SaxesParser({ xmlns: true });
  parser.on("doctype", () => {
    throw new Error("Sitemap XML declarations are not allowed");
  });
  parser.on("error", (error) => {
    throw new Error(`Sitemap XML is malformed: ${error.message}`);
  });
  parser.on("opentag", (tag: SaxesTagNS) => {
    elements += 1;
    if (elements > MAX_XML_ELEMENTS) throw new Error("Sitemap XML contains too many elements");
    if (stack.length >= MAX_XML_DEPTH) throw new Error("Sitemap XML nesting is too deep");
    if (stack.length > 0) stack[stack.length - 1]!.hasChild = true;

    const namespace = tag.uri === "" ? null : tag.uri;
    if (stack.length === 0) {
      if (rootKind !== null) throw new Error("Sitemap XML contains multiple root elements");
      if (tag.local !== "sitemapindex" && tag.local !== "urlset") {
        throw new Error("Sitemap XML root must be sitemapindex or urlset");
      }
      if (namespace !== null && namespace !== SITEMAP_NAMESPACE) {
        throw new Error("Sitemap XML root must use the standard sitemap namespace");
      }
      rootKind = tag.local === "sitemapindex" ? "index" : "urlset";
      rootNamespace = namespace;
    }
    stack.push({
      localName: tag.local,
      namespace,
      text: "",
      hasChild: false,
    });
  });
  const appendText = (text: string): void => {
    const current = stack.at(-1);
    if (current === undefined) {
      if (text.trim() !== "") throw new Error("Sitemap XML contains text outside its root");
      return;
    }
    current.text += text;
    if (current.text.length > MAX_XML_TEXT_LENGTH) {
      throw new Error("Sitemap XML element text is too long");
    }
  };
  parser.on("text", appendText);
  parser.on("cdata", (text) => {
    if (stack.length === 0) throw new Error("Sitemap XML contains CDATA outside its root");
    appendText(text);
  });
  parser.on("closetag", (_tag: SaxesTagNS) => {
    const current = stack.pop();
    if (current === undefined) throw new Error("Sitemap XML has mismatched elements");
    const root = stack[0];
    const parent = stack[1];
    const expectedParent = rootKind === "urlset" ? "url" : "sitemap";
    if (
      current.localName === "loc"
      && !current.hasChild
      && stack.length === 2
      && root?.namespace === rootNamespace
      && parent?.localName === expectedParent
      && parent.namespace === rootNamespace
      && current.namespace === rootNamespace
    ) {
      try {
        const location = current.text.trim();
        if (location.length === 0 || location.length > MAX_URL_LENGTH) {
          throw new Error("Sitemap loc must be a non-empty bounded URL");
        }
        if (locations.length >= MAX_SITEMAP_LOCATIONS) {
          throw new Error("Sitemap XML contains too many locations");
        }
        locations.push(location);
      } catch (error) {
        if (onInvalidLocation === undefined) throw error;
        onInvalidLocation(error instanceof Error ? error.message : String(error));
      }
    }
  });

  parser.write(xml).close();

  if (stack.length !== 0 || rootKind === null) throw new Error("Sitemap XML is incomplete");
  return { kind: rootKind, locations };
}

export async function discoverRecipeUrls(
  source: DiscoverySource,
  fetcher: DiscoveryFetcher,
  requestedLimits: Partial<DiscoveryLimits> = {},
): Promise<SourceDiscoveryResult> {
  if (source.id.length === 0 || source.id.length > 100) throw new Error("Source id is invalid");
  const base = scopedUrl(source.baseUrl, new URL(source.baseUrl), "Source base URL");
  const limits = { ...DEFAULT_LIMITS, ...requestedLimits };
  assertLimits(limits);
  const routes: string[] = [];
  const warnings: string[] = [];
  const addWarning = (warning: string): void => {
    if (warnings.length < 50) warnings.push(warning.slice(0, 500));
  };
  const cache = { misses: 0, refreshed: 0, revalidated: 0 };
  const recipeUrls: string[] = [];
  const recipeSeen = new Set<string>();
  const visitedSitemaps = new Set<string>();
  const sitemapCandidates = new Set<string>();
  let sitemapCandidateCount = 0;
  let sitemapLimitWarned = false;
  let capped = false;
  const noteSitemapLimit = (): void => {
    capped = true;
    if (!sitemapLimitWarned) {
      sitemapLimitWarned = true;
      addWarning("Sitemap candidate limit reached; additional sitemap URLs were ignored");
    }
  };

  const fetch = async (url: URL, kind: PublicResourceKind): Promise<CachedFetchResult> => {
    const result = await fetcher.fetch(url, kind, base);
    const finalUrl = scopedUrl(result.resource.url, base, `${kind} redirect target`);
    routes.push(url.href);
    if (result.cacheStatus === "miss") cache.misses += 1;
    else if (result.cacheStatus === "refreshed") cache.refreshed += 1;
    else cache.revalidated += 1;
    return { ...result, resource: { ...result.resource, url: finalUrl } };
  };

  const robotsUrl = new URL("/robots.txt", base);
  let advertised: URL[] = [];
  try {
    const robots = await fetch(robotsUrl, "robots");
    advertised = parseRobotsSitemaps(
      robots.resource.body,
      robots.resource.url,
      base,
      (message) => addWarning(`robots.txt: ${message}`),
    );
  } catch (error) {
    addWarning(`robots.txt: ${error instanceof Error ? error.message : String(error)}`);
  }

  const traverse = async (root: URL): Promise<void> => {
    const queue: Array<{ url: URL; depth: number }> = [];
    const enqueue = (candidate: URL, depth: number): boolean => {
      const key = canonicalScopeKey(candidate);
      if (sitemapCandidates.has(key)) return true;
      if (sitemapCandidateCount >= limits.maxSitemaps) {
        noteSitemapLimit();
        return false;
      }
      sitemapCandidates.add(key);
      sitemapCandidateCount += 1;
      queue.push({ url: candidate, depth });
      return true;
    };
    if (!enqueue(scopedUrl(root, base, "Sitemap URL"), 0)) return;

    while (queue.length > 0) {
      const current = queue.shift()!;
      const scoped = current.url;
      const scopedKey = canonicalScopeKey(scoped);
      if (visitedSitemaps.has(scopedKey)) continue;
      visitedSitemaps.add(scopedKey);
      try {
        const response = await fetch(scoped, "sitemap");
        const finalKey = canonicalScopeKey(response.resource.url);
        sitemapCandidates.add(finalKey);
        visitedSitemaps.add(finalKey);
        const parsed = parseSitemapXml(
          response.resource.body,
          (message) => addWarning(`${scoped.href}: ${message}`),
        );
        if (parsed.kind === "index") {
          if (current.depth >= limits.maxDepth) {
            for (const location of parsed.locations) {
              try {
                const nested = scopedUrl(location, base, "Nested sitemap URL");
                if (!sitemapCandidates.has(canonicalScopeKey(nested))) capped = true;
              } catch (error) {
                addWarning(`${scoped.href}: ${error instanceof Error ? error.message : String(error)}`);
              }
            }
            continue;
          }
          for (const location of parsed.locations) {
            try {
              const nested = scopedUrl(location, base, "Nested sitemap URL");
              if (!enqueue(nested, current.depth + 1)) break;
            } catch (error) {
              addWarning(`${scoped.href}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        } else {
          for (const location of parsed.locations) {
            try {
              const recipeUrl = scopedUrl(location, base, "Recipe URL");
              if (source.recipeScope !== "site") {
                assertUrlWithinSourcePath(recipeUrl, base, "Recipe URL", location);
              }
              const recipeKey = canonicalScopeKey(recipeUrl);
              if (!recipeSeen.has(recipeKey)) {
                if (recipeUrls.length >= limits.maxRecipeUrls) {
                  capped = true;
                  break;
                }
                recipeSeen.add(recipeKey);
                recipeUrls.push(recipeUrl.href);
              }
            } catch (error) {
              addWarning(`${scoped.href}: ${error instanceof Error ? error.message : String(error)}`);
            }
          }
        }
      } catch (error) {
        addWarning(`${scoped.href}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  };

  const fallbackValues = [
    source.discoveryUrl,
    new URL("/sitemap.xml", base).href,
    new URL("/sitemap_index.xml", base).href,
  ].filter((value): value is string => value !== null);
  const fallback = [...new Set(fallbackValues)].map((value) => scopedUrl(value, base, "Discovery URL"));
  for (const root of advertised) {
    try {
      await traverse(root);
    } catch (error) {
      addWarning(`${root.href}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  if (recipeUrls.length === 0 && !capped) {
    for (const root of fallback) {
      if (recipeUrls.length > 0 || capped) break;
      try {
        await traverse(root);
      } catch (error) {
        addWarning(`${root.href}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  if (recipeUrls.length === 0) {
    const detail = capped
      ? "discovery limit reached before any recipe URL was found"
      : warnings.length === 0
        ? "sitemaps contained no recipe URLs"
        : warnings.join(" | ");
    throw new Error(`No usable sitemap found for source ${source.id}: ${detail}`);
  }

  return {
    sourceId: source.id,
    routes,
    recipeUrls,
    sampleRecipeUrls: recipeUrls.slice(0, limits.sampleSize),
    capped,
    cache,
    warnings,
  };
}
