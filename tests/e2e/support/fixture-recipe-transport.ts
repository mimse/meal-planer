import type { PublicResourceKind } from "../../../src/adapters/recipes/fetch";
import type { CachedFetchResult } from "../../../src/application/cached-resource-fetcher";
import type { DiscoveryFetcher } from "../../../src/application/source-discovery";

export const FIXTURE_SOURCE_ID = "fixture-recipes";
export const FIXTURE_SOURCE_BASE_URL = "https://fixture-recipes.example/recipes/";
export const FIXTURE_RECIPE_COUNT = 8;

function recipeUrl(index: number): string {
  return `${FIXTURE_SOURCE_BASE_URL}${index + 1}`;
}

function recipeHtml(index: number): string {
  const recipe = {
    "@context": "https://schema.org",
    "@type": "Recipe",
    name: `Fixture Recipe ${index + 1}`,
    url: recipeUrl(index),
    author: { "@type": "Person", name: "Fixture Kitchen" },
    recipeYield: "4 servings",
    prepTime: "PT10M",
    cookTime: "PT15M",
    totalTime: "PT25M",
    recipeCuisine: "Danish",
    suitableForDiet: "https://schema.org/VegetarianDiet",
    recipeIngredient: ["100 g carrots", `${index + 1} tomatoes`],
    recipeInstructions: [{ "@type": "HowToStep", text: `Cook fixture recipe ${index + 1}.` }],
  };
  return `<!doctype html><html><head><script type="application/ld+json">${JSON.stringify(recipe)}</script></head><body></body></html>`;
}

function sitemapXml(): string {
  const locations = Array.from({ length: FIXTURE_RECIPE_COUNT }, (_, index) =>
    `<url><loc>${recipeUrl(index)}</loc></url>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${locations}</urlset>`;
}

function result(url: URL, body: string, mediaType: string): CachedFetchResult {
  return {
    resource: {
      url,
      body,
      mediaType,
      status: 200,
      etag: null,
      lastModified: null,
    },
    cacheStatus: "miss",
  };
}

export function createFixtureRecipeTransport(): DiscoveryFetcher {
  return {
    async fetch(url: URL, kind: PublicResourceKind): Promise<CachedFetchResult> {
      if (url.href === "https://fixture-recipes.example/robots.txt" && kind === "robots") {
        return result(url, `Sitemap: ${FIXTURE_SOURCE_BASE_URL}sitemap.xml\n`, "text/plain");
      }
      if (url.href === `${FIXTURE_SOURCE_BASE_URL}sitemap.xml` && kind === "sitemap") {
        return result(url, sitemapXml(), "application/xml");
      }
      const recipeIndex = Array.from({ length: FIXTURE_RECIPE_COUNT }, (_, index) => index)
        .find(index => url.href === recipeUrl(index));
      if (recipeIndex !== undefined && kind === "recipe") {
        return result(url, recipeHtml(recipeIndex), "text/html");
      }
      throw new Error(`Unexpected fixture request: ${kind} ${url.href}`);
    },
  };
}
