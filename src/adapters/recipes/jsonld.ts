import { load } from "cheerio";
import {
  normalizeSchemaDietaryTags,
  tryResolveHttpUrl,
  validateExtractedRecipe,
  type ExtractedRecipe,
} from "./extraction";

export type { ExtractedRecipe } from "./extraction";

type JsonLdNode = Record<string, unknown>;

const MAX_JSON_LD_BLOCK_BYTES = 2_000_000;
const MAX_JSON_LD_PAGE_BYTES = 2_100_000;
const MAX_JSON_LD_BLOCK_NODES = 10_000;
const MAX_JSON_LD_PAGE_NODES = 50_000;
const MAX_JSON_LD_CONTAINER_ITEMS = 10_000;
const MAX_JSON_LD_BLOCK_ITEMS = 20_000;
const MAX_JSON_LD_PAGE_ITEMS = 100_000;
const MAX_JSON_LD_DEPTH = 30;
const MAX_JSON_LD_BLOCK_TEXT_BYTES = 250_000;
const MAX_JSON_LD_PAGE_TEXT_BYTES = 500_000;

type JsonLdPageBudget = {
  bytes: number;
  nodes: number;
  items: number;
  textBytes: number;
};

function utf8Bytes(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

function isObject(value: unknown): value is JsonLdNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedJsonLdNodes(value: unknown, page: JsonLdPageBudget): JsonLdNode[] {
  const candidates: JsonLdNode[] = [];
  const stack: Array<{ value: unknown; depth: number; candidate: boolean }> = [
    { value, depth: 0, candidate: true },
  ];
  let blockNodes = 0;
  let blockItems = 0;
  let blockTextBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    blockNodes += 1;
    page.nodes += 1;
    if (blockNodes > MAX_JSON_LD_BLOCK_NODES || page.nodes > MAX_JSON_LD_PAGE_NODES) {
      throw new Error("Schema.org JSON-LD exceeds aggregate node limits");
    }
    if (current.depth > MAX_JSON_LD_DEPTH) {
      throw new Error(`Schema.org JSON-LD exceeds maximum depth ${MAX_JSON_LD_DEPTH}`);
    }

    if (typeof current.value === "string") {
      const bytes = utf8Bytes(current.value);
      blockTextBytes += bytes;
      page.textBytes += bytes;
      if (
        blockTextBytes > MAX_JSON_LD_BLOCK_TEXT_BYTES
        || page.textBytes > MAX_JSON_LD_PAGE_TEXT_BYTES
      ) throw new Error("Schema.org JSON-LD exceeds aggregate text limits");
      continue;
    }
    if (
      current.value === null
      || typeof current.value === "boolean"
      || typeof current.value === "number"
    ) continue;

    if (Array.isArray(current.value)) {
      if (current.value.length > MAX_JSON_LD_CONTAINER_ITEMS) {
        throw new Error(`Schema.org JSON-LD array exceeds ${MAX_JSON_LD_CONTAINER_ITEMS} items`);
      }
      blockItems += current.value.length;
      page.items += current.value.length;
      if (blockItems > MAX_JSON_LD_BLOCK_ITEMS || page.items > MAX_JSON_LD_PAGE_ITEMS) {
        throw new Error("Schema.org JSON-LD exceeds aggregate item limits");
      }
      for (let index = current.value.length - 1; index >= 0; index -= 1) {
        stack.push({
          value: current.value[index],
          depth: current.depth + 1,
          candidate: current.candidate,
        });
      }
      continue;
    }
    if (!isObject(current.value)) continue;

    const entries = Object.entries(current.value);
    if (entries.length > MAX_JSON_LD_CONTAINER_ITEMS) {
      throw new Error(`Schema.org JSON-LD object exceeds ${MAX_JSON_LD_CONTAINER_ITEMS} entries`);
    }
    blockItems += entries.length;
    page.items += entries.length;
    if (blockItems > MAX_JSON_LD_BLOCK_ITEMS || page.items > MAX_JSON_LD_PAGE_ITEMS) {
      throw new Error("Schema.org JSON-LD exceeds aggregate item limits");
    }
    if (current.candidate) candidates.push(current.value);
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [key, child] = entries[index]!;
      const keyBytes = utf8Bytes(key);
      blockTextBytes += keyBytes;
      page.textBytes += keyBytes;
      if (
        blockTextBytes > MAX_JSON_LD_BLOCK_TEXT_BYTES
        || page.textBytes > MAX_JSON_LD_PAGE_TEXT_BYTES
      ) throw new Error("Schema.org JSON-LD exceeds aggregate text limits");
      stack.push({
        value: child,
        depth: current.depth + 1,
        candidate: current.candidate && key === "@graph",
      });
    }
  }

  return candidates;
}

function hasType(node: JsonLdNode, expected: string): boolean {
  const type = node["@type"];
  return Array.isArray(type) ? type.includes(expected) : type === expected;
}

function isValidRecipe(node: JsonLdNode): node is JsonLdNode & { name: string } {
  return hasType(node, "Recipe") && typeof node.name === "string" && Boolean(node.name.trim());
}

function parseDuration(value: unknown): number | null {
  if (typeof value !== "string") return null;

  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/.exec(value);
  if (
    !match
    || (match[1] === undefined && match[2] === undefined && match[3] === undefined)
    || (value.includes("T") && match[2] === undefined && match[3] === undefined)
  ) {
    return null;
  }

  const minutes = Number(match[1] ?? 0) * 1_440
    + Number(match[2] ?? 0) * 60
    + Number(match[3] ?? 0);
  return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 525_600 ? minutes : null;
}

function parseServings(value: unknown): number | null {
  const candidate = Array.isArray(value) ? value[0] : value;
  if (typeof candidate === "number") {
    return Number.isFinite(candidate) && candidate > 0 ? candidate : null;
  }
  if (typeof candidate !== "string") return null;

  const match = candidate.match(/[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?/i);
  if (!match) return null;
  const servings = Number(match[0].replace(",", "."));
  return Number.isFinite(servings) && servings > 0 ? servings : null;
}

function extractAuthor(value: unknown): string | null {
  if (typeof value === "string") return value.trim() || null;
  if (Array.isArray(value)) return extractAuthor(value[0]);
  if (isObject(value) && typeof value.name === "string") return value.name.trim() || null;
  return null;
}

function extractInstructions(value: unknown): string[] {
  if (typeof value === "string") return [value.trim()].filter(Boolean);

  const entries = Array.isArray(value) ? value : [value];
  return entries.flatMap((entry) => {
    if (typeof entry === "string") return entry.trim() ? [entry.trim()] : [];
    if (!isObject(entry)) return [];
    if (typeof entry.text === "string" && entry.text.trim()) return [entry.text.trim()];
    return extractInstructions(entry.itemListElement);
  });
}

function extractDietaryTags(value: unknown): string[] {
  const values = Array.isArray(value) ? value : [value];
  return normalizeSchemaDietaryTags(values);
}

function resolveRecipeUrl(value: unknown, fallback: URL): string {
  if (typeof value !== "string" || !value.trim()) return fallback.href;
  const resolved = tryResolveHttpUrl(value, fallback);
  if (resolved === null) throw new Error("Recipe source URL is invalid or disallowed");
  return resolved;
}

function extractCandidate(
  raw: JsonLdNode,
  pageUrl: URL,
  canonicalHref: string | undefined,
): ExtractedRecipe | null {
  if (!isValidRecipe(raw)) return null;

  try {
    const sourceUrl = resolveRecipeUrl(raw.url, pageUrl);
    const canonicalUrl = tryResolveHttpUrl(canonicalHref, pageUrl) ?? sourceUrl;
    return validateExtractedRecipe({
      title: raw.name.trim(),
      sourceUrl,
      canonicalUrl,
      author: extractAuthor(raw.author),
      servings: parseServings(raw.recipeYield),
      prepMinutes: parseDuration(raw.prepTime),
      cookMinutes: parseDuration(raw.cookTime),
      totalMinutes: parseDuration(raw.totalTime),
      rawIngredients: Array.isArray(raw.recipeIngredient)
        ? raw.recipeIngredient.filter((item): item is string => typeof item === "string")
        : [],
      instructions: extractInstructions(raw.recipeInstructions),
      dietaryTags: extractDietaryTags(raw.suitableForDiet),
      raw,
    });
  } catch {
    return null;
  }
}

export function extractRecipeJsonLd(html: string, pageUrl: URL): ExtractedRecipe {
  const $ = load(html);
  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  const pageBudget: JsonLdPageBudget = { bytes: 0, nodes: 0, items: 0, textBytes: 0 };
  let pageLimitExceeded = false;

  for (const element of $('script[type="application/ld+json"]').toArray()) {
    const text = $(element).text().trim();
    if (!text) continue;

    const textBytes = utf8Bytes(text);
    pageBudget.bytes += textBytes;
    if (pageBudget.bytes > MAX_JSON_LD_PAGE_BYTES) {
      pageLimitExceeded = true;
      break;
    }
    if (textBytes > MAX_JSON_LD_BLOCK_BYTES) continue;

    try {
      const nodes = boundedJsonLdNodes(JSON.parse(text), pageBudget);
      for (const node of nodes) {
        const recipe = extractCandidate(node, pageUrl, canonicalHref);
        if (recipe) return recipe;
      }
    } catch {
      // A malformed block must not hide a valid Recipe block elsewhere on the page.
      if (
        pageBudget.nodes > MAX_JSON_LD_PAGE_NODES
        || pageBudget.items > MAX_JSON_LD_PAGE_ITEMS
        || pageBudget.textBytes > MAX_JSON_LD_PAGE_TEXT_BYTES
      ) {
        pageLimitExceeded = true;
        break;
      }
    }
  }

  if (pageLimitExceeded) throw new Error("Schema.org JSON-LD exceeds page-wide resource limits");
  throw new Error(`No valid Schema.org Recipe found at ${pageUrl.href}`);
}
