import type { ExtractedRecipe } from "../adapters/recipes/jsonld";
import { extractRecipeJsonLd } from "../adapters/recipes/jsonld";
import {
  fetchRecipePage,
  type RecipeFetchDependencies,
} from "../adapters/recipes/fetch";

export async function inspectRecipeUrl(
  url: URL,
  dependencies: RecipeFetchDependencies = {},
): Promise<ExtractedRecipe> {
  const page = await fetchRecipePage(url, dependencies);
  return extractRecipeJsonLd(page.html, page.url);
}
