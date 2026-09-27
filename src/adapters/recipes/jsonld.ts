import { load } from "cheerio";

export type ExtractedRecipe = {
  title: string;
  sourceUrl: string;
  canonicalUrl: string;
  author: string | null;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  rawIngredients: string[];
  instructions: string[];
  dietaryTags: string[];
  raw: Record<string, unknown>;
};

type JsonLdNode = Record<string, unknown>;

function isObject(value: unknown): value is JsonLdNode {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function flattenNodes(value: unknown): JsonLdNode[] {
  if (Array.isArray(value)) {
    return value.flatMap(flattenNodes);
  }

  if (!isObject(value)) {
    return [];
  }

  const graph = value["@graph"];
  return graph === undefined ? [value] : [value, ...flattenNodes(graph)];
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
  return Number.isFinite(minutes) && minutes >= 0 ? minutes : null;
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
  return values.flatMap((entry) => {
    if (typeof entry !== "string") return [];
    const name = entry.split("/").filter(Boolean).at(-1)?.replace(/Diet$/, "").toLowerCase();
    return name ? [name] : [];
  });
}

function resolveUrl(value: unknown, fallback: URL): string {
  if (typeof value !== "string" || !value.trim()) return fallback.href;
  return new URL(value, fallback).href;
}

function extractCandidate(
  raw: JsonLdNode,
  pageUrl: URL,
  canonicalHref: string | undefined,
): ExtractedRecipe | null {
  if (!isValidRecipe(raw)) return null;

  try {
    const sourceUrl = resolveUrl(raw.url, pageUrl);
    let canonicalUrl = sourceUrl;
    if (canonicalHref) {
      try {
        canonicalUrl = resolveUrl(canonicalHref, pageUrl);
      } catch {
        // Canonical metadata is optional evidence; keep the valid recipe URL.
      }
    }
    return {
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
    };
  } catch {
    return null;
  }
}

export function extractRecipeJsonLd(html: string, pageUrl: URL): ExtractedRecipe {
  const $ = load(html);
  const nodes: JsonLdNode[] = [];

  $('script[type="application/ld+json"]').each((_, element) => {
    const text = $(element).text().trim();
    if (!text) return;

    try {
      nodes.push(...flattenNodes(JSON.parse(text)));
    } catch {
      // A malformed block must not hide a valid Recipe block elsewhere on the page.
    }
  });

  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  for (const node of nodes) {
    const recipe = extractCandidate(node, pageUrl, canonicalHref);
    if (recipe) return recipe;
  }

  throw new Error(`No valid Schema.org Recipe found at ${pageUrl.href}`);
}
