import { load } from "cheerio";
import { isBuiltInRecipeExtractionHost } from "./sources";
import {
  assertBoundedJsonValue,
  tryResolveSameSiteHttpUrl,
  validateExtractedRecipe,
  type ExtractedRecipe,
} from "./extraction";

const EXPECTED_COMPONENT = "app/pages/Recipes/Details";
const MAX_DATA_PAGE_BYTES = 1_000_000;
const MAX_GROUPS = 100;
const MAX_GROUP_ITEMS = 500;

type JsonObject = Record<string, unknown>;

type EvidenceGroup = {
  readonly title: string;
  readonly sortOrder: number;
  readonly ingredients?: readonly string[];
  readonly instructions?: readonly string[];
};

function objectValue(value: unknown, label: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as JsonObject;
}

function boundedString(value: unknown, label: string, maximum: number, nullable = false): string | null {
  if (nullable && value == null) return null;
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  const trimmed = value.trim();
  if (!trimmed) throw new Error(`${label} cannot be empty`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
  return trimmed;
}

function nullableNumber(value: unknown, label: string, minimum: number): number | null {
  if (value == null) return null;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a finite number or null`);
  }
  if (value < minimum || value > 1_000_000) {
    throw new Error(`${label} must be between ${minimum} and 1000000`);
  }
  return value;
}

function nullableMinutes(value: unknown, label: string): number | null {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 525_600) {
    throw new Error(`${label} must be a safe integer between 0 and 525600 or null`);
  }
  return value as number;
}

function requiredArray(value: unknown, label: string, maximum: number): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} items`);
  return value;
}

function parseDataPage(encodedPage: string): JsonObject {
  if (Buffer.byteLength(encodedPage, "utf8") > MAX_DATA_PAGE_BYTES) {
    throw new Error(`SPIS BEDRE data-page exceeds ${MAX_DATA_PAGE_BYTES} bytes`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(encodedPage);
  } catch {
    throw new Error("SPIS BEDRE data-page contains malformed JSON");
  }
  assertBoundedJsonValue(parsed, "SPIS BEDRE data-page");
  return objectValue(parsed, "SPIS BEDRE data-page");
}

function sortedGroups(value: unknown, label: string): Array<{ value: JsonObject; index: number; sortOrder: number }> {
  return requiredArray(value, label, MAX_GROUPS).map((entry, index) => {
    const group = objectValue(entry, `${label} ${index}`);
    if (!Number.isSafeInteger(group.sort_order)) {
      throw new Error(`${label} ${index} sort_order must be a safe integer`);
    }
    return { value: group, index, sortOrder: group.sort_order as number };
  }).sort((left, right) => left.sortOrder - right.sortOrder || left.index - right.index);
}

function amountText(value: unknown, label: string): { text: string; singular: boolean } {
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value <= 0 || value > 1_000_000_000) {
      throw new Error(`${label} amount must be a positive finite number at most 1000000000`);
    }
    return { text: String(value), singular: value === 1 };
  }
  if (
    typeof value !== "string"
    || value.length > 100
    || !/^(?:0|[1-9]\d*)(?:[.,]\d+)?$/u.test(value)
  ) throw new Error(`${label} amount must be a canonical positive decimal`);
  const number = Number(value.replace(",", "."));
  if (!Number.isFinite(number) || number <= 0 || number > 1_000_000_000) {
    throw new Error(`${label} amount must be a canonical positive decimal`);
  }
  return { text: value, singular: number === 1 };
}

function optionalText(value: unknown, label: string): string | null {
  return value == null ? null : boundedString(value, label, 300);
}

function renderIngredient(value: unknown, label: string): string {
  const item = objectValue(value, label);
  const amount = amountText(item.amount, label);
  const ingredient = objectValue(item.ingredient, `${label} ingredient`);
  const unit = item.unit == null ? null : objectValue(item.unit, `${label} unit`);
  const ingredientName = boundedString(
    ingredient[amount.singular ? "name_singular" : "name_plural"]
      ?? ingredient.name_singular
      ?? ingredient.name_plural,
    `${label} ingredient name`,
    300,
  );
  const unitName = unit === null ? null : boundedString(
    unit[amount.singular ? "name_singular" : "name_plural"]
      ?? unit.name_singular
      ?? unit.name_plural
      ?? unit.abbreviation,
    `${label} unit name`,
    100,
    true,
  );
  const prefix = optionalText(item.prefix, `${label} prefix`);
  const suffix = optionalText(item.suffix, `${label} suffix`);
  return [prefix, amount.text, unitName, ingredientName, suffix].filter((part) => part !== null).join(" ");
}

function extractIngredientGroups(value: unknown): EvidenceGroup[] {
  return sortedGroups(value, "SPIS BEDRE ingredient groups").map(({ value: group, sortOrder }, groupIndex) => {
    const title = boundedString(group.title, `SPIS BEDRE ingredient group ${groupIndex} title`, 500)!;
    const ingredients = requiredArray(
      group.ingredients,
      `SPIS BEDRE ingredient group ${groupIndex} ingredients`,
      MAX_GROUP_ITEMS,
    ).map((item, itemIndex) => renderIngredient(
      item,
      `SPIS BEDRE ingredient group ${groupIndex} item ${itemIndex}`,
    ));
    return { title, sortOrder, ingredients };
  });
}

function extractInstructionGroups(value: unknown): EvidenceGroup[] {
  return sortedGroups(value, "SPIS BEDRE instruction groups").map(({ value: group, sortOrder }, groupIndex) => {
    const title = boundedString(group.title, `SPIS BEDRE instruction group ${groupIndex} title`, 500)!;
    const instructions = requiredArray(
      group.instructions,
      `SPIS BEDRE instruction group ${groupIndex} instructions`,
      MAX_GROUP_ITEMS,
    ).map((entry, itemIndex) => {
      const instruction = objectValue(entry, `SPIS BEDRE instruction group ${groupIndex} item ${itemIndex}`);
      return boundedString(
        instruction.instruction,
        `SPIS BEDRE instruction group ${groupIndex} item ${itemIndex} text`,
        5_000,
      )!;
    });
    return { title, sortOrder, instructions };
  });
}

function assertAggregateGroupItems(
  value: unknown,
  label: string,
  itemField: "ingredients" | "instructions",
): void {
  const groups = requiredArray(value, label, MAX_GROUPS);
  let total = 0;
  for (let index = 0; index < groups.length; index += 1) {
    const group = objectValue(groups[index], `${label} ${index}`);
    const entries = requiredArray(
      group[itemField],
      `${label.slice(0, -1)} ${index} ${itemField}`,
      MAX_GROUP_ITEMS,
    );
    total += entries.length;
    if (total > MAX_GROUP_ITEMS) {
      throw new Error(`${label} exceed ${MAX_GROUP_ITEMS} aggregate items`);
    }
  }
}

function resolveSourceUrl(value: string, pageUrl: URL): string {
  const resolved = tryResolveSameSiteHttpUrl(value, pageUrl);
  if (resolved === null) throw new Error("Recipe source URL is invalid, unsafe, or cross-site");
  return resolved;
}

export function extractSpisBedreInertia(html: string, pageUrl: URL): ExtractedRecipe {
  if (!isBuiltInRecipeExtractionHost("spisbedre-inertia", pageUrl)) {
    throw new Error("spisbedre-inertia adapter is only allowed for its configured built-in host");
  }
  const $ = load(html);
  const encodedPage = $("#app[data-page]").first().attr("data-page");
  if (encodedPage === undefined) throw new Error("SPIS BEDRE page is missing #app[data-page]");
  const page = parseDataPage(encodedPage);
  if (page.component !== EXPECTED_COMPONENT) {
    throw new Error(`Unexpected SPIS BEDRE Inertia component: ${String(page.component)}`);
  }
  const props = objectValue(page.props, "SPIS BEDRE data-page props");
  const recipe = objectValue(props.recipe, "SPIS BEDRE data-page props.recipe");

  const title = boundedString(recipe.title, "SPIS BEDRE recipe title", 500)!;
  const slug = boundedString(recipe.slug, "SPIS BEDRE recipe slug", 500)!;
  const sourceUrl = resolveSourceUrl(boundedString(recipe.url, "SPIS BEDRE recipe URL", 2_048)!, pageUrl);
  const canonicalHref = $('link[rel="canonical"]').first().attr("href");
  const canonicalUrl = tryResolveSameSiteHttpUrl(canonicalHref, pageUrl) ?? sourceUrl;
  const author = boundedString(recipe.author, "SPIS BEDRE recipe author", 300, true);
  const servings = nullableNumber(recipe.serving_size, "SPIS BEDRE serving size", Number.MIN_VALUE);
  const prepMinutes = nullableMinutes(recipe.preparation_time, "SPIS BEDRE preparation time");
  const cookMinutes = nullableMinutes(recipe.cooking_time, "SPIS BEDRE cooking time");
  const totalMinutes = nullableMinutes(recipe.total_time, "SPIS BEDRE total time");
  assertAggregateGroupItems(recipe.grouped_ingredients, "SPIS BEDRE ingredient groups", "ingredients");
  assertAggregateGroupItems(recipe.grouped_instructions, "SPIS BEDRE instruction groups", "instructions");
  const ingredientGroups = extractIngredientGroups(recipe.grouped_ingredients);
  const instructionGroups = extractInstructionGroups(recipe.grouped_instructions);
  const rawIngredients = ingredientGroups.flatMap((group) => group.ingredients ?? []);
  const instructions = instructionGroups.flatMap((group) => group.instructions ?? []);

  return validateExtractedRecipe({
    title,
    sourceUrl,
    canonicalUrl,
    author,
    servings,
    prepMinutes,
    cookMinutes,
    totalMinutes,
    rawIngredients,
    instructions,
    dietaryTags: [],
    raw: {
      kind: "spisbedre-inertia",
      component: EXPECTED_COMPONENT,
      title,
      slug,
      url: sourceUrl,
      author,
      servingSize: servings,
      preparationTime: prepMinutes,
      cookingTime: cookMinutes,
      totalTime: totalMinutes,
      ingredientGroups,
      instructionGroups,
    },
  });
}
