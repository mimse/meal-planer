export type RecipeExtractionKind = "jsonld" | "microdata" | "spisbedre-inertia";

export function normalizeRecipeSourceHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./u, "");
}

export type BuiltInRecipeSource = {
  id: string;
  name: string;
  host: string;
  baseUrl: string;
  discoveryUrl: string;
  extraction: RecipeExtractionKind;
};

export const BUILT_IN_RECIPE_SOURCES: readonly BuiltInRecipeSource[] = [
  {
    id: "valdemarsro",
    name: "Valdemarsro",
    host: "valdemarsro.dk",
    baseUrl: "https://www.valdemarsro.dk/",
    discoveryUrl: "https://www.valdemarsro.dk/sitemap_index.xml",
    extraction: "microdata",
  },
  {
    id: "gourministeriet",
    name: "Gourministeriet",
    host: "gourministeriet.dk",
    baseUrl: "https://gourministeriet.dk/",
    discoveryUrl: "https://gourministeriet.dk/sitemap.xml",
    extraction: "jsonld",
  },
  {
    id: "spisbedre",
    name: "SPIS BEDRE",
    host: "spisbedre.dk",
    baseUrl: "https://spisbedre.dk/",
    discoveryUrl: "https://spisbedre.dk/opskrifter/sitemap.xml",
    extraction: "spisbedre-inertia",
  },
  {
    id: "juliebruun",
    name: "Julie Bruun",
    host: "juliebruun.com",
    baseUrl: "https://juliebruun.com/category/opskrifter/",
    discoveryUrl: "https://juliebruun.com/sitemap_index.xml",
    extraction: "jsonld",
  },
  {
    id: "juliekarla",
    name: "Julie Karla",
    host: "juliekarla.dk",
    baseUrl: "https://www.juliekarla.dk/",
    discoveryUrl: "https://www.juliekarla.dk/sitemap.xml",
    extraction: "jsonld",
  },
  {
    id: "mummum",
    name: "Mummum",
    host: "mummum.dk",
    baseUrl: "https://mummum.dk/",
    discoveryUrl: "https://mummum.dk/sitemap_index.xml",
    extraction: "jsonld",
  },
] as const;

export function isBuiltInRecipeExtractionHost(kind: RecipeExtractionKind, pageUrl: URL): boolean {
  if (
    (pageUrl.protocol !== "http:" && pageUrl.protocol !== "https:")
    || pageUrl.username !== ""
    || pageUrl.password !== ""
    || /%(?![0-9a-f]{2})/iu.test(pageUrl.href)
  ) return false;
  const host = normalizeRecipeSourceHost(pageUrl.hostname);
  return BUILT_IN_RECIPE_SOURCES.some((source) =>
    source.extraction === kind && normalizeRecipeSourceHost(source.host) === host);
}
