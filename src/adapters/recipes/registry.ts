import {
  BUILT_IN_RECIPE_SOURCES,
  normalizeRecipeSourceHost,
  type BuiltInRecipeSource,
  type RecipeExtractionKind,
} from "./sources";
import { extractRecipeJsonLd } from "./jsonld";
import { extractSpisBedreInertia } from "./spisbedre";
import { extractValdemarsroMicrodata } from "./valdemarsro";
import {
  validateExtractedRecipe,
  type ExtractedRecipe,
  type RecipeExtractionAdapter,
} from "./extraction";

export type ConfiguredRecipeExtractionKind = RecipeExtractionKind | "auto";

export function buildRecipeSourceRouting(sources: readonly BuiltInRecipeSource[]): {
  readonly byId: Readonly<Record<string, RecipeExtractionKind>>;
  readonly byHost: Readonly<Record<string, RecipeExtractionKind>>;
} {
  const byId = new Map<string, RecipeExtractionKind>();
  const byHost = new Map<string, RecipeExtractionKind>();
  for (const source of sources) {
    if (byId.has(source.id)) throw new Error(`Duplicate built-in recipe source id: ${source.id}`);
    const host = normalizeRecipeSourceHost(source.host);
    if (byHost.has(host)) throw new Error(`Duplicate built-in recipe source host: ${host}`);
    byId.set(source.id, source.extraction);
    byHost.set(host, source.extraction);
  }
  return Object.freeze({
    byId: Object.freeze(Object.fromEntries(byId)),
    byHost: Object.freeze(Object.fromEntries(byHost)),
  });
}

const BUILT_IN_ROUTES = buildRecipeSourceRouting(BUILT_IN_RECIPE_SOURCES);
export const BUILT_IN_RECIPE_EXTRACTION_KINDS = BUILT_IN_ROUTES.byId;
const HOST_EXTRACTION_KINDS = BUILT_IN_ROUTES.byHost;

function adapterKindForUrl(pageUrl: URL): RecipeExtractionKind {
  return HOST_EXTRACTION_KINDS[normalizeRecipeSourceHost(pageUrl.hostname)] ?? "jsonld";
}

const jsonLdAdapter: RecipeExtractionAdapter = {
  kind: "jsonld",
  extract: extractRecipeJsonLd,
};
const microdataAdapter: RecipeExtractionAdapter = {
  kind: "microdata",
  extract: extractValdemarsroMicrodata,
};
const spisBedreAdapter: RecipeExtractionAdapter = {
  kind: "spisbedre-inertia",
  extract: extractSpisBedreInertia,
};
const autoAdapter: RecipeExtractionAdapter = {
  kind: "auto",
  extract(html, pageUrl) {
    return getRecipeExtractionAdapter(adapterKindForUrl(pageUrl)).extract(html, pageUrl);
  },
};

export const RECIPE_EXTRACTION_ADAPTERS: Readonly<
  Record<ConfiguredRecipeExtractionKind, RecipeExtractionAdapter>
> = Object.freeze({
  auto: autoAdapter,
  jsonld: jsonLdAdapter,
  microdata: microdataAdapter,
  "spisbedre-inertia": spisBedreAdapter,
});

export function getRecipeExtractionAdapter(
  kind: ConfiguredRecipeExtractionKind,
): RecipeExtractionAdapter {
  const adapter = RECIPE_EXTRACTION_ADAPTERS[kind];
  if (adapter === undefined) throw new Error(`Unsupported recipe extraction adapter: ${String(kind)}`);
  return adapter;
}

export function getBuiltInRecipeExtractionAdapter(sourceId: string): RecipeExtractionAdapter {
  const kind = BUILT_IN_RECIPE_EXTRACTION_KINDS[sourceId];
  if (kind === undefined) throw new Error(`Unknown built-in recipe source: ${sourceId}`);
  return getRecipeExtractionAdapter(kind);
}

export function extractRecipeWithAdapter(
  kind: ConfiguredRecipeExtractionKind,
  html: string,
  pageUrl: URL,
): ExtractedRecipe {
  return validateExtractedRecipe(getRecipeExtractionAdapter(kind).extract(html, pageUrl));
}
