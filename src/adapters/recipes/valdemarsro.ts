import { load } from "cheerio";
import { isTag, type AnyNode } from "domhandler";
import { isBuiltInRecipeExtractionHost } from "./sources";
import {
  normalizeSchemaDietaryTags,
  tryResolveSameSiteHttpUrl,
  validateExtractedRecipe,
  type ExtractedRecipe,
} from "./extraction";

type LoadedPage = ReturnType<typeof load>;
type CandidateProperties = ReadonlyMap<string, readonly AnyNode[]>;
type MutableScopeProperties = {
  readonly properties: Map<string, AnyNode[]>;
  matches: number;
  overBudget: boolean;
};
type MicrodataIndex = {
  readonly candidates: readonly AnyNode[];
  readonly propertiesByScope: ReadonlyMap<AnyNode, MutableScopeProperties>;
  readonly canonicalHref: string | null;
};
type CandidateReadBudget = { nodesVisited: number };

export type ValdemarsroTraversalStats = {
  readonly domNodesVisited: number;
  readonly recipeCandidates: number;
  readonly propertyNodesVisited: number;
  readonly propertyTokensExamined: number;
  readonly propertyMatchesStored: number;
  readonly ancestorSearches: 0;
};

export type ValdemarsroExtractionOptions = {
  readonly onTraversalComplete?: (stats: ValdemarsroTraversalStats) => void;
};

const MAX_DOM_NODES = 20_000;
const MAX_RECIPE_CANDIDATES = 100;
const MAX_PAGE_PROPERTY_MATCHES = 20_000;
const MAX_CANDIDATE_PROPERTY_MATCHES = 1_100;
const MAX_CANDIDATE_VALUE_NODES = 20_000;
const MAX_INGREDIENTS = 500;
const MAX_INSTRUCTIONS = 500;
const EMPTY_PROPERTIES: CandidateProperties = new Map();

function spendReadBudget(budget: CandidateReadBudget): void {
  budget.nodesVisited += 1;
  if (budget.nodesVisited > MAX_CANDIDATE_VALUE_NODES) {
    throw new Error(
      `Valdemarsro Recipe candidate exceeds ${MAX_CANDIDATE_VALUE_NODES} value traversal nodes`,
    );
  }
}

function boundedText(element: AnyNode, budget: CandidateReadBudget): string {
  const stack: AnyNode[] = [element];
  const chunks: string[] = [];
  while (stack.length > 0) {
    const node = stack.pop()!;
    spendReadBudget(budget);
    if (node.type === "text") chunks.push(node.data);
    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push(node.childNodes[index]!);
      }
    }
  }
  return chunks.join("");
}

function itemValue(element: AnyNode, budget: CandidateReadBudget): string {
  if (isTag(element)) {
    const value = element.attribs.content ?? element.attribs.datetime ?? element.attribs.href;
    if (value !== undefined) return value.trim();
  }
  return boundedText(element, budget).trim();
}

function forEachWhitespaceToken(
  value: string,
  visit: (token: string) => boolean,
): void {
  const expression = /\S+/gu;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(value)) !== null) {
    if (!visit(match[0]!)) return;
  }
}

function hasRecipeType(value: string | undefined): boolean {
  if (value === undefined) return false;
  let found = false;
  forEachWhitespaceToken(value, (itemType) => {
    found = itemType === "http://schema.org/Recipe" || itemType === "https://schema.org/Recipe";
    return !found;
  });
  return found;
}

function hasCanonicalRel(value: string | undefined): boolean {
  if (value === undefined) return false;
  let found = false;
  forEachWhitespaceToken(value, (relation) => {
    found = relation.toLowerCase() === "canonical";
    return !found;
  });
  return found;
}

function buildMicrodataIndex($: LoadedPage): {
  readonly index: MicrodataIndex;
  readonly stats: ValdemarsroTraversalStats;
} {
  const root = $.root().get(0);
  const candidates: AnyNode[] = [];
  const propertiesByScope = new Map<AnyNode, MutableScopeProperties>();
  const stack: Array<{ node: AnyNode; ownerScope: AnyNode | null }> = root === undefined
    ? []
    : [{ node: root, ownerScope: null }];
  let canonicalHref: string | null = null;
  let domNodesVisited = 0;
  let propertyNodesVisited = 0;
  let propertyTokensExamined = 0;
  let propertyMatchesStored = 0;

  while (stack.length > 0) {
    const { node, ownerScope } = stack.pop()!;
    domNodesVisited += 1;
    if (domNodesVisited > MAX_DOM_NODES) {
      throw new Error(`Valdemarsro microdata exceeds ${MAX_DOM_NODES} DOM nodes`);
    }

    let childOwner = ownerScope;
    if (isTag(node)) {
      const isScope = node.attribs.itemscope !== undefined;
      if (canonicalHref === null && node.name === "link" && hasCanonicalRel(node.attribs.rel)) {
        canonicalHref = node.attribs.href ?? null;
      }
      if (isScope) {
        childOwner = node;
        if (hasRecipeType(node.attribs.itemtype)) {
          candidates.push(node);
          if (candidates.length > MAX_RECIPE_CANDIDATES) {
            throw new Error(
              `Valdemarsro microdata exceeds ${MAX_RECIPE_CANDIDATES} Recipe candidates`,
            );
          }
        }
      }

      const itemprop = node.attribs.itemprop;
      if (itemprop !== undefined && ownerScope !== null) {
        propertyNodesVisited += 1;
        let scopeProperties = propertiesByScope.get(ownerScope);
        if (scopeProperties === undefined) {
          scopeProperties = { properties: new Map(), matches: 0, overBudget: false };
          propertiesByScope.set(ownerScope, scopeProperties);
        }
        if (!scopeProperties.overBudget) {
          forEachWhitespaceToken(itemprop, (property) => {
            propertyTokensExamined += 1;
            if (propertyTokensExamined > MAX_PAGE_PROPERTY_MATCHES) {
              throw new Error(
                `Valdemarsro microdata exceeds ${MAX_PAGE_PROPERTY_MATCHES} property matches`,
              );
            }
            scopeProperties.matches += 1;
            if (scopeProperties.matches > MAX_CANDIDATE_PROPERTY_MATCHES) {
              scopeProperties.overBudget = true;
              scopeProperties.properties.clear();
              return false;
            }
            const elements = scopeProperties.properties.get(property);
            if (elements === undefined) scopeProperties.properties.set(property, [node]);
            else elements.push(node);
            propertyMatchesStored += 1;
            return true;
          });
        }
      }
    }

    if ("childNodes" in node) {
      for (let index = node.childNodes.length - 1; index >= 0; index -= 1) {
        stack.push({ node: node.childNodes[index]!, ownerScope: childOwner });
      }
    }
  }

  return {
    index: { candidates, propertiesByScope, canonicalHref },
    stats: {
      domNodesVisited,
      recipeCandidates: candidates.length,
      propertyNodesVisited,
      propertyTokensExamined,
      propertyMatchesStored,
      ancestorSearches: 0,
    },
  };
}

function candidateProperties(index: MicrodataIndex, scope: AnyNode): CandidateProperties {
  const state = index.propertiesByScope.get(scope);
  if (state?.overBudget) {
    throw new Error(
      `Valdemarsro Recipe candidate exceeds ${MAX_CANDIDATE_PROPERTY_MATCHES} owned property matches`,
    );
  }
  return state?.properties ?? EMPTY_PROPERTIES;
}

function nestedScopeProperties(index: MicrodataIndex, scope: AnyNode): CandidateProperties {
  const state = index.propertiesByScope.get(scope);
  if (state?.overBudget) {
    throw new Error(
      `Valdemarsro nested item scope exceeds ${MAX_CANDIDATE_PROPERTY_MATCHES} owned property matches`,
    );
  }
  return state?.properties ?? EMPTY_PROPERTIES;
}

function firstProperty(
  properties: CandidateProperties,
  property: string,
  budget: CandidateReadBudget,
): string | null {
  const element = properties.get(property)?.[0];
  if (element === undefined) return null;
  return itemValue(element, budget) || null;
}

function parseDuration(value: string | null): number | null {
  if (value === null) return null;
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?)?$/u.exec(value);
  if (
    match === null
    || (match[1] === undefined && match[2] === undefined && match[3] === undefined)
    || (value.includes("T") && match[2] === undefined && match[3] === undefined)
  ) return null;
  const minutes = Number(match[1] ?? 0) * 1_440
    + Number(match[2] ?? 0) * 60
    + Number(match[3] ?? 0);
  return Number.isSafeInteger(minutes) && minutes >= 0 && minutes <= 525_600 ? minutes : null;
}

function parseServings(value: string | null): number | null {
  if (value === null) return null;
  const match = value.match(/[+-]?(?:\d+(?:[.,]\d*)?|[.,]\d+)(?:e[+-]?\d+)?/iu);
  if (match === null) return null;
  const servings = Number(match[0].replace(",", "."));
  return Number.isFinite(servings) && servings > 0 ? servings : null;
}

function resolveEvidenceUrl(value: string | undefined, pageUrl: URL): string {
  const resolved = tryResolveSameSiteHttpUrl(value === undefined ? pageUrl.href : value, pageUrl);
  if (resolved === null) throw new Error("Recipe source URL is invalid, unsafe, or cross-site");
  return resolved;
}

function sourceProperty(
  properties: CandidateProperties,
  budget: CandidateReadBudget,
): string | undefined {
  const element = properties.get("mainEntityOfPage")?.[0];
  return element === undefined ? undefined : itemValue(element, budget);
}

function extractAuthor(
  index: MicrodataIndex,
  properties: CandidateProperties,
  budget: CandidateReadBudget,
): string | null {
  const authorElement = properties.get("author")?.[0];
  if (authorElement === undefined) return null;
  if (!isTag(authorElement) || authorElement.attribs.itemscope === undefined) {
    return itemValue(authorElement, budget) || null;
  }
  const name = nestedScopeProperties(index, authorElement).get("name")?.[0];
  return name === undefined ? null : itemValue(name, budget) || null;
}

function instructionTexts(
  properties: CandidateProperties,
  budget: CandidateReadBudget,
): string[] {
  const candidates: AnyNode[] = [];
  for (const element of properties.get("recipeInstructions") ?? []) {
    let paragraphs = 0;
    if ("childNodes" in element) {
      for (const child of element.childNodes) {
        spendReadBudget(budget);
        if (isTag(child) && child.name === "p") {
          paragraphs += 1;
          if (candidates.length >= MAX_INSTRUCTIONS) {
            throw new Error(`Recipe instructions exceeds ${MAX_INSTRUCTIONS} items`);
          }
          candidates.push(child);
        }
      }
    }
    if (paragraphs === 0) {
      if (candidates.length >= MAX_INSTRUCTIONS) {
        throw new Error(`Recipe instructions exceeds ${MAX_INSTRUCTIONS} items`);
      }
      candidates.push(element);
    }
  }
  return candidates.map((candidate) => boundedText(candidate, budget).trim()).filter(Boolean);
}

export function extractValdemarsroMicrodata(
  html: string,
  pageUrl: URL,
  options: ValdemarsroExtractionOptions = {},
): ExtractedRecipe {
  if (!isBuiltInRecipeExtractionHost("microdata", pageUrl)) {
    throw new Error("microdata adapter is only allowed for its configured built-in host");
  }
  const $ = load(html);
  const { index, stats } = buildMicrodataIndex($);
  options.onTraversalComplete?.(Object.freeze({ ...stats }));
  let candidateError: Error | null = null;

  for (const element of index.candidates) {
    try {
      const properties = candidateProperties(index, element);
      const readBudget: CandidateReadBudget = { nodesVisited: 0 };
      const title = firstProperty(properties, "name", readBudget);
      if (title === null) throw new Error("Recipe title cannot be empty");
      const sourceUrl = resolveEvidenceUrl(sourceProperty(properties, readBudget), pageUrl);
      const canonicalUrl = tryResolveSameSiteHttpUrl(index.canonicalHref, pageUrl) ?? sourceUrl;
      const author = extractAuthor(index, properties, readBudget);
      const recipeYield = firstProperty(properties, "recipeYield", readBudget);
      const prepTime = firstProperty(properties, "prepTime", readBudget);
      const cookTime = firstProperty(properties, "cookTime", readBudget);
      const totalTime = firstProperty(properties, "totalTime", readBudget);
      const ingredientElements = properties.get("recipeIngredient") ?? [];
      if (ingredientElements.length > MAX_INGREDIENTS) {
        throw new Error(`Recipe ingredients exceeds ${MAX_INGREDIENTS} items`);
      }
      const rawIngredients = ingredientElements
        .map((item) => itemValue(item, readBudget)).filter(Boolean);
      const instructions = instructionTexts(properties, readBudget);
      const rawDietaryEvidence = (properties.get("suitableForDiet") ?? [])
        .map((item) => itemValue(item, readBudget)).filter(Boolean);

      return validateExtractedRecipe({
        title,
        sourceUrl,
        canonicalUrl,
        author,
        servings: parseServings(recipeYield),
        prepMinutes: parseDuration(prepTime),
        cookMinutes: parseDuration(cookTime),
        totalMinutes: parseDuration(totalTime),
        rawIngredients,
        instructions,
        dietaryTags: normalizeSchemaDietaryTags(rawDietaryEvidence),
        raw: {
          kind: "microdata",
          itemType: isTag(element) ? element.attribs.itemtype! : "",
          title,
          sourceUrl,
          author,
          recipeYield,
          prepTime,
          cookTime,
          totalTime,
          ingredients: rawIngredients,
          instructions,
          suitableForDiet: rawDietaryEvidence,
        },
      });
    } catch (error) {
      candidateError = error instanceof Error ? error : new Error(String(error));
    }
  }

  if (candidateError !== null) throw candidateError;
  throw new Error(`No Schema.org Recipe microdata found at ${pageUrl.href}`);
}
