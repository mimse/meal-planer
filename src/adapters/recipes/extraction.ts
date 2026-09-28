import { types } from "node:util";
import { DIETARY_TAGS, type DietaryTag } from "../../domain/recipe";
import { normalizeRecipeSourceHost } from "./sources";

export type ExtractedRecipe = {
  readonly title: string;
  readonly sourceUrl: string;
  readonly canonicalUrl: string;
  readonly author: string | null;
  readonly servings: number | null;
  readonly prepMinutes: number | null;
  readonly cookMinutes: number | null;
  readonly totalMinutes: number | null;
  readonly rawIngredients: readonly string[];
  readonly instructions: readonly string[];
  readonly dietaryTags: readonly DietaryTag[];
  readonly raw: Record<string, unknown>;
};

export interface RecipeExtractionAdapter {
  readonly kind: "jsonld" | "microdata" | "spisbedre-inertia" | "auto";
  extract(html: string, pageUrl: URL): ExtractedRecipe;
}

export function tryResolveHttpUrl(value: unknown, base?: URL): string | null {
  if (
    typeof value !== "string"
    || value.trim().length === 0
    || value.length > 2_048
    || /%(?![0-9a-f]{2})/iu.test(value)
  ) return null;
  let url: URL;
  try {
    url = base === undefined ? new URL(value) : new URL(value, base);
  } catch {
    return null;
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:")
    || url.username !== ""
    || url.password !== ""
    || url.href.length > 2_048
  ) return null;
  return url.href;
}

export function tryResolveSameSiteHttpUrl(
  value: unknown,
  base: URL,
  expectedHostname = base.hostname,
): string | null {
  const resolved = tryResolveHttpUrl(value, base);
  if (resolved === null) return null;
  const url = new URL(resolved);
  if (normalizeRecipeSourceHost(url.hostname) !== normalizeRecipeSourceHost(expectedHostname)) {
    return null;
  }
  url.hash = "";
  return url.href;
}

function validateHttpUrl(value: string, label: string): void {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.length > 2_048) throw new Error(`${label} exceeds 2048 characters`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} is not a valid URL`);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`${label} must use HTTP or HTTPS`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new Error(`${label} must not contain credentials`);
  }
}

function validateNullableNumber(
  value: number | null,
  label: string,
  minimum: number,
  maximum: number,
  safeInteger = false,
): void {
  if (value === null) return;
  if (!Number.isFinite(value)) throw new Error(`${label} must be a finite number`);
  if (safeInteger && !Number.isSafeInteger(value)) throw new Error(`${label} must be a safe integer`);
  if (value < minimum) {
    throw new Error(`${label} must be ${minimum === 0 ? "at least zero" : "greater than zero"}`);
  }
  if (value > maximum) throw new Error(`${label} exceeds ${maximum}`);
}

const SCHEMA_DIETARY_TAGS: Readonly<Record<string, DietaryTag>> = Object.freeze({
  DiabeticDiet: "diabetic",
  GlutenFreeDiet: "gluten-free",
  HalalDiet: "halal",
  HinduDiet: "hindu",
  KosherDiet: "kosher",
  LowCalorieDiet: "low-calorie",
  LowFatDiet: "low-fat",
  LowLactoseDiet: "low-lactose",
  LowSaltDiet: "low-salt",
  VeganDiet: "vegan",
  VegetarianDiet: "vegetarian",
});

export function normalizeSchemaDietaryTags(values: readonly unknown[]): DietaryTag[] {
  const tags: DietaryTag[] = [];
  const seen = new Set<DietaryTag>();
  for (const value of values) {
    if (typeof value !== "string") continue;
    const enumName = value.split("/").filter(Boolean).at(-1);
    const tag = enumName === undefined ? undefined : SCHEMA_DIETARY_TAGS[enumName];
    if (tag !== undefined && !seen.has(tag)) {
      seen.add(tag);
      tags.push(tag);
    }
  }
  return tags;
}

function validateText(value: string, label: string, maximum: number): void {
  if (typeof value !== "string") throw new Error(`${label} must be a string`);
  if (value.trim().length === 0) throw new Error(`${label} cannot be empty`);
  if (value.length > maximum) throw new Error(`${label} exceeds ${maximum} characters`);
}

function validateTextArray(
  value: readonly string[],
  label: string,
  maximumItems: number,
  maximumItemLength: number,
): void {
  if (types.isProxy(value)) throw new Error(`${label} must not be a Proxy`);
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  if (Object.getPrototypeOf(value) !== Array.prototype) {
    throw new Error(`${label} must be an ordinary array`);
  }
  if (value.length > maximumItems) throw new Error(`${label} exceeds ${maximumItems} items`);
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new Error(`${label} must contain own data elements`);
  }
  const expectedKeys = new Set(["length", ...Array.from({ length: value.length }, (_, index) => String(index))]);
  if (
    ownKeys.length !== expectedKeys.size
    || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
  ) throw new Error(`${label} must contain own data elements`);

  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
      throw new Error(`${label} must contain own data elements`);
    }
    validateText(
      descriptor.value as string,
      `${label.slice(0, -1)} ${index}`,
      maximumItemLength,
    );
  }
}

const UNSAFE_RAW_KEYS = new Set(["__proto__", "constructor", "prototype"]);
const MAX_RAW_BYTES = 250_000;
const MAX_RAW_DEPTH = 30;
const MAX_RAW_ITEMS = 10_000;
const MAX_RAW_NODES = 10_000;

export function assertBoundedJsonValue(value: unknown, label: string): void {
  const stack: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  const seen = new WeakSet<object>();
  let nodes = 0;
  let items = 0;
  let textBytes = 0;

  while (stack.length > 0) {
    const current = stack.pop()!;
    nodes += 1;
    if (nodes > MAX_RAW_NODES) throw new Error(`${label} exceeds ${MAX_RAW_NODES} aggregate nodes`);
    if (current.depth > MAX_RAW_DEPTH) {
      throw new Error(`${label} exceeds maximum depth ${MAX_RAW_DEPTH}`);
    }

    if (current.value === null || typeof current.value === "boolean") continue;
    if (typeof current.value === "string") {
      textBytes += Buffer.byteLength(current.value, "utf8");
      if (textBytes > MAX_RAW_BYTES) throw new Error(`${label} exceeds ${MAX_RAW_BYTES} bytes`);
      continue;
    }
    if (typeof current.value === "number") {
      if (!Number.isFinite(current.value)) throw new Error(`${label} contains a non-finite number`);
      continue;
    }
    if (typeof current.value !== "object") throw new Error(`${label} contains a non-JSON value`);
    if (types.isProxy(current.value)) throw new Error(`${label} must not contain Proxy values`);
    if (seen.has(current.value)) throw new Error(`${label} contains a cycle or shared reference`);
    seen.add(current.value);

    const isArray = Array.isArray(current.value);
    const prototype = Object.getPrototypeOf(current.value);
    if (isArray ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
      throw new Error(`${label} must contain only plain objects and ordinary arrays`);
    }
    const ownKeys = Reflect.ownKeys(current.value);
    if (ownKeys.some((key) => typeof key === "symbol")) {
      throw new Error(`${label} contains a non-JSON symbol key`);
    }

    if (isArray) {
      const arrayValue = current.value as unknown[];
      if (arrayValue.length > MAX_RAW_ITEMS) {
        throw new Error(`${label} contains an array with more than ${MAX_RAW_ITEMS} items`);
      }
      const expectedKeys = new Set([
        "length",
        ...Array.from({ length: arrayValue.length }, (_, index) => String(index)),
      ]);
      if (
        ownKeys.length !== expectedKeys.size
        || ownKeys.some((key) => typeof key !== "string" || !expectedKeys.has(key))
      ) throw new Error(`${label} must contain only dense arrays of data properties`);
      items += arrayValue.length;
      if (items > MAX_RAW_ITEMS) throw new Error(`${label} exceeds ${MAX_RAW_ITEMS} aggregate items`);
      for (let index = arrayValue.length - 1; index >= 0; index -= 1) {
        const descriptor = Object.getOwnPropertyDescriptor(arrayValue, String(index));
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
          throw new Error(`${label} must contain only data properties`);
        }
        stack.push({ value: descriptor.value, depth: current.depth + 1 });
      }
      continue;
    }

    const stringKeys = ownKeys as string[];
    if (stringKeys.length > MAX_RAW_ITEMS) {
      throw new Error(`${label} contains an object with more than ${MAX_RAW_ITEMS} entries`);
    }
    items += stringKeys.length;
    if (items > MAX_RAW_ITEMS) throw new Error(`${label} exceeds ${MAX_RAW_ITEMS} aggregate items`);
    for (let index = stringKeys.length - 1; index >= 0; index -= 1) {
      const key = stringKeys[index]!;
      if (UNSAFE_RAW_KEYS.has(key)) throw new Error(`${label} contains unsafe key "${key}"`);
      if (key.length > 500) throw new Error(`${label} contains a key exceeding 500 characters`);
      textBytes += Buffer.byteLength(key, "utf8");
      if (textBytes > MAX_RAW_BYTES) throw new Error(`${label} exceeds ${MAX_RAW_BYTES} bytes`);
      const descriptor = Object.getOwnPropertyDescriptor(current.value, key)!;
      if (!("value" in descriptor) || !descriptor.enumerable) {
        throw new Error(`${label} must contain only data properties`);
      }
      stack.push({ value: descriptor.value, depth: current.depth + 1 });
    }
  }
}

function validateRawEvidence(value: unknown): asserts value is Record<string, unknown> {
  if (typeof value === "object" && value !== null && types.isProxy(value)) {
    throw new Error("Recipe raw evidence must not contain Proxy values");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recipe raw evidence must be an object");
  }
  assertBoundedJsonValue(value, "Recipe raw evidence");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, "utf8") > MAX_RAW_BYTES) {
    throw new Error(`Recipe raw evidence exceeds ${MAX_RAW_BYTES} bytes`);
  }
}

export function validateExtractedRecipe(value: unknown): ExtractedRecipe {
  if (typeof value === "object" && value !== null && types.isProxy(value)) {
    throw new Error("Recipe extraction must not be a Proxy");
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Recipe extraction must be an object");
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw new Error("Recipe extraction must be a plain object");
  }
  const ownKeys = Reflect.ownKeys(value);
  if (ownKeys.some((key) => typeof key === "symbol")) {
    throw new Error("Recipe extraction must not contain symbol fields");
  }
  const expectedKeys: readonly (keyof ExtractedRecipe)[] = [
    "title",
    "sourceUrl",
    "canonicalUrl",
    "author",
    "servings",
    "prepMinutes",
    "cookMinutes",
    "totalMinutes",
    "rawIngredients",
    "instructions",
    "dietaryTags",
    "raw",
  ];
  const expectedKeySet = new Set<string>(expectedKeys);
  if (
    ownKeys.length !== expectedKeys.length
    || ownKeys.some((key) => typeof key !== "string" || !expectedKeySet.has(key))
  ) throw new Error("Recipe extraction must contain exactly the expected fields");
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (expectedKeys.some((key) => {
    const descriptor = descriptors[key];
    return descriptor === undefined || !("value" in descriptor);
  })) throw new Error("Recipe extraction fields must be own data properties");
  const recipe = Object.fromEntries(
    expectedKeys.map((key) => [key, descriptors[key]!.value]),
  ) as Record<keyof ExtractedRecipe, unknown>;
  validateText(recipe.title as string, "Recipe title", 500);
  validateHttpUrl(recipe.sourceUrl as string, "Recipe source URL");
  validateHttpUrl(recipe.canonicalUrl as string, "Recipe canonical URL");
  if (recipe.author !== null) validateText(recipe.author as string, "Recipe author", 300);
  validateNullableNumber(recipe.servings as number | null, "Recipe servings", Number.MIN_VALUE, 1_000_000);
  validateNullableNumber(recipe.prepMinutes as number | null, "Recipe prep minutes", 0, 525_600, true);
  validateNullableNumber(recipe.cookMinutes as number | null, "Recipe cook minutes", 0, 525_600, true);
  validateNullableNumber(recipe.totalMinutes as number | null, "Recipe total minutes", 0, 525_600, true);
  validateTextArray(recipe.rawIngredients as readonly string[], "Recipe ingredients", 500, 2_000);
  validateTextArray(recipe.instructions as readonly string[], "Recipe instructions", 500, 5_000);
  const dietaryTags = recipe.dietaryTags as readonly string[];
  validateTextArray(dietaryTags, "Recipe dietary tags", 50, 64);
  const allowedDietaryTags = new Set<string>(DIETARY_TAGS);
  for (const tag of dietaryTags) {
    if (!allowedDietaryTags.has(tag)) {
      throw new Error(`Recipe dietary tag "${tag}" is not supported`);
    }
  }
  if (new Set(dietaryTags).size !== dietaryTags.length) {
    throw new Error("Recipe dietary tags must not contain duplicates");
  }
  validateRawEvidence(recipe.raw);
  return value as ExtractedRecipe;
}
