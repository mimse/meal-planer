import { describe, expect, test } from "bun:test";
import {
  validateExtractedRecipe,
  type ExtractedRecipe,
} from "../../src/adapters/recipes/extraction";
import { DIETARY_TAGS } from "../../src/domain/recipe";

const validRecipe = (): ExtractedRecipe => ({
  title: "Tomatpasta",
  sourceUrl: "https://recipes.example/tomatpasta",
  canonicalUrl: "https://recipes.example/tomatpasta",
  author: "Example Cook",
  servings: 4,
  prepMinutes: 10,
  cookMinutes: 20,
  totalMinutes: 30,
  rawIngredients: ["400 g pasta"],
  instructions: ["Kog pastaen."],
  dietaryTags: ["vegetarian"],
  raw: { "@type": "Recipe", name: "Tomatpasta" },
});

describe("recipe extraction output boundary", () => {
  test("accepts a complete bounded extraction without changing evidence", () => {
    const recipe = validRecipe();
    expect(validateExtractedRecipe(recipe)).toBe(recipe);
    expect(validateExtractedRecipe(recipe).raw).toBe(recipe.raw);
  });

  test("accepts exact own data fields regardless of enumerability", () => {
    const recipe = validRecipe();
    Object.defineProperty(recipe, "title", {
      value: recipe.title,
      enumerable: false,
      configurable: true,
      writable: true,
    });
    expect(validateExtractedRecipe(recipe)).toBe(recipe);
  });

  test("rejects malformed extraction objects at runtime", () => {
    expect(() => validateExtractedRecipe(null)).toThrow("Recipe extraction must be an object");
    expect(() => validateExtractedRecipe({}))
      .toThrow("Recipe extraction must contain exactly the expected fields");
  });

  test("rejects non-HTTP URLs and embedded credentials", () => {
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      sourceUrl: "file:///etc/passwd",
    })).toThrow("Recipe source URL must use HTTP or HTTPS");
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      canonicalUrl: "https://user:secret@recipes.example/r",
    })).toThrow("Recipe canonical URL must not contain credentials");
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      sourceUrl: `https://recipes.example/${"x".repeat(2_100)}`,
    })).toThrow("Recipe source URL exceeds 2048 characters");
  });

  test("rejects non-finite and out-of-range serving and time values", () => {
    for (const [field, value, message] of [
      ["servings", Number.POSITIVE_INFINITY, "Recipe servings must be a finite number"],
      ["servings", 0, "Recipe servings must be greater than zero"],
      ["prepMinutes", -1, "Recipe prep minutes must be at least zero"],
      ["prepMinutes", 1.5, "Recipe prep minutes must be a safe integer"],
      ["cookMinutes", 525_601, "Recipe cook minutes exceeds 525600"],
      ["totalMinutes", Number.NaN, "Recipe total minutes must be a finite number"],
    ] as const) {
      expect(() => validateExtractedRecipe({
        ...validRecipe(),
        [field]: value,
      })).toThrow(message);
    }
  });

  test("rejects missing, oversized, and excessive textual evidence", () => {
    expect(() => validateExtractedRecipe({ ...validRecipe(), title: "  " }))
      .toThrow("Recipe title cannot be empty");
    expect(() => validateExtractedRecipe({ ...validRecipe(), author: "a".repeat(301) }))
      .toThrow("Recipe author exceeds 300 characters");
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      rawIngredients: Array.from({ length: 501 }, () => "salt"),
    })).toThrow("Recipe ingredients exceeds 500 items");
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      instructions: ["x".repeat(5_001)],
    })).toThrow("Recipe instruction 0 exceeds 5000 characters");
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      dietaryTags: Array.from({ length: 51 }, (_, index) => `tag-${index}`),
    })).toThrow("Recipe dietary tags exceeds 50 items");
  });

  test("rejects unsafe, deep, crowded, and oversized raw evidence", () => {
    const unsafe = JSON.parse('{"__proto__":{"polluted":true}}') as Record<string, unknown>;
    expect(() => validateExtractedRecipe({ ...validRecipe(), raw: unsafe }))
      .toThrow('Recipe raw evidence contains unsafe key "__proto__"');

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 31; index += 1) deep = { child: deep };
    expect(() => validateExtractedRecipe({ ...validRecipe(), raw: deep }))
      .toThrow("Recipe raw evidence exceeds maximum depth 30");

    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      raw: { values: Array.from({ length: 10_001 }, () => null) },
    })).toThrow("Recipe raw evidence contains an array with more than 10000 items");

    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      raw: { text: "x".repeat(250_001) },
    })).toThrow("Recipe raw evidence exceeds 250000 bytes");
  });

  test("rejects aggregate branching evidence before traversing unbounded values", () => {
    const raw = Object.fromEntries(
      Array.from({ length: 101 }, (_, index) => [
        `branch-${index}`,
        Array.from({ length: 100 }, () => null),
      ]),
    );

    expect(() => validateExtractedRecipe({ ...validRecipe(), raw }))
      .toThrow("Recipe raw evidence exceeds 10000 aggregate items");
  });

  test("rejects shared, cyclic, and accessor raw evidence without invoking accessors", () => {
    const shared = { value: "same" };
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      raw: { left: shared, right: shared },
    })).toThrow("Recipe raw evidence contains a cycle or shared reference");

    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => validateExtractedRecipe({ ...validRecipe(), raw: cyclic }))
      .toThrow("Recipe raw evidence contains a cycle or shared reference");

    let reads = 0;
    const accessor = Object.defineProperty({}, "value", {
      enumerable: true,
      get() {
        reads += 1;
        return "unsafe";
      },
    });
    expect(() => validateExtractedRecipe({ ...validRecipe(), raw: accessor }))
      .toThrow("Recipe raw evidence must contain only data properties");
    expect(reads).toBe(0);
  });

  test("rejects inexact extraction objects before reading any field", () => {
    let titleReads = 0;
    const withGetter = { ...validRecipe() } as Record<string, unknown>;
    Object.defineProperty(withGetter, "title", {
      enumerable: true,
      get() {
        titleReads += 1;
        return "Unsafe";
      },
    });
    expect(() => validateExtractedRecipe(withGetter))
      .toThrow("Recipe extraction fields must be own data properties");
    expect(titleReads).toBe(0);

    expect(() => validateExtractedRecipe({ ...validRecipe(), extra: true }))
      .toThrow("Recipe extraction must contain exactly the expected fields");
    expect(() => validateExtractedRecipe(Object.assign(Object.create({}), validRecipe())))
      .toThrow("Recipe extraction must be a plain object");
    const symbolRecipe = validRecipe() as ExtractedRecipe & { [key: symbol]: boolean };
    symbolRecipe[Symbol("extra")] = true;
    expect(() => validateExtractedRecipe(symbolRecipe))
      .toThrow("Recipe extraction must not contain symbol fields");
  });

  test("rejects sparse, accessor-backed, and custom-prototype text arrays", () => {
    const sparse = Array(1) as string[];
    expect(() => validateExtractedRecipe({ ...validRecipe(), instructions: sparse }))
      .toThrow("Recipe instructions must contain own data elements");

    let reads = 0;
    const accessor = ["placeholder"];
    Object.defineProperty(accessor, 0, {
      enumerable: true,
      get() {
        reads += 1;
        return "unsafe";
      },
    });
    expect(() => validateExtractedRecipe({ ...validRecipe(), rawIngredients: accessor }))
      .toThrow("Recipe ingredients must contain own data elements");
    expect(reads).toBe(0);

    const custom = ["vegetarian"];
    Object.setPrototypeOf(custom, {});
    expect(() => validateExtractedRecipe({ ...validRecipe(), dietaryTags: custom }))
      .toThrow("Recipe dietary tags must be an ordinary array");
  });

  test("rejects Proxy boundaries without firing any Proxy traps", () => {
    const trapCounts = {
      get: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
    };
    const proxy = <T extends object>(target: T): T => new Proxy(target, {
      get() {
        trapCounts.get += 1;
        return undefined;
      },
      getPrototypeOf() {
        trapCounts.getPrototypeOf += 1;
        return null;
      },
      ownKeys() {
        trapCounts.ownKeys += 1;
        return [];
      },
      getOwnPropertyDescriptor() {
        trapCounts.getOwnPropertyDescriptor += 1;
        return undefined;
      },
    });

    expect(() => validateExtractedRecipe(proxy(validRecipe())))
      .toThrow("Recipe extraction must not be a Proxy");
    expect(() => validateExtractedRecipe({ ...validRecipe(), rawIngredients: proxy(["salt"]) }))
      .toThrow("Recipe ingredients must not be a Proxy");
    expect(() => validateExtractedRecipe({ ...validRecipe(), raw: proxy({ value: "unsafe" }) }))
      .toThrow("Recipe raw evidence must not contain Proxy values");
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      raw: { nested: proxy({ value: "unsafe" }) },
    })).toThrow("Recipe raw evidence must not contain Proxy values");
    expect(trapCounts).toEqual({
      get: 0,
      getPrototypeOf: 0,
      ownKeys: 0,
      getOwnPropertyDescriptor: 0,
    });
  });

  test("accepts every persistence dietary tag and rejects unknown or duplicate tags", () => {
    expect(validateExtractedRecipe({
      ...validRecipe(),
      dietaryTags: [...DIETARY_TAGS],
    }).dietaryTags).toEqual(DIETARY_TAGS);
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      dietaryTags: ["pescatarian"],
    })).toThrow('Recipe dietary tag "pescatarian" is not supported');
    expect(() => validateExtractedRecipe({
      ...validRecipe(),
      dietaryTags: ["vegan", "vegan"],
    })).toThrow("Recipe dietary tags must not contain duplicates");
  });
});
