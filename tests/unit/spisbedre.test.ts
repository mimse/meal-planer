import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractSpisBedreInertia } from "../../src/adapters/recipes/spisbedre";
import { normalizeRecipeCanonicalUrl } from "../../src/infrastructure/recipe-repository";

const fixtureUrl = new URL("https://spisbedre.dk/opskrifter/3-slags-pindemadder");
const fixture = readFileSync(resolve(import.meta.dir, "../fixtures/recipes/spisbedre.html"), "utf8");

function inertiaHtml(page: unknown): string {
  const encoded = JSON.stringify(page).replace(/&/gu, "&amp;").replace(/'/gu, "&#39;");
  return `<div id="app" data-page='${encoded}'></div>`;
}

function minimalRecipe(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    title: "Test recipe",
    slug: "test-recipe",
    serving_size: 1,
    preparation_time: 5,
    cooking_time: 10,
    total_time: 15,
    url: "https://spisbedre.dk/opskrifter/test-recipe",
    author: "Test Author",
    grouped_ingredients: [],
    grouped_instructions: [],
    ...overrides,
  };
}

const ingredientGroups = [
  {
    title: "Pindemad med tomat og mozzarella",
    sortOrder: 0,
    ingredients: ["2 stk. cherrytomater"],
  },
  {
    title: "Kylling-bacon-sticks",
    sortOrder: 1,
    ingredients: ["2 stk. kyllingeinderfileter"],
  },
  {
    title: "Små kartofler i persillepesto",
    sortOrder: 2,
    ingredients: ["små 60 gram kartofler med skræl"],
  },
];
const instructionGroups = [
  {
    title: "Pindemad med tomat og mozzarella",
    sortOrder: 0,
    instructions: ["Skyl, og bag tomaterne i ovnen i ca. 25 minutter ved 150°. Lad dem afkøle."],
  },
  {
    title: "Kylling-bacon-sticks",
    sortOrder: 1,
    instructions: ["Læg træpindene i vand i mindst 30 minutter. Tænd ovnen på 200°."],
  },
  {
    title: "Små kartofler i persillepesto",
    sortOrder: 2,
    instructions: ["Vask persillen godt for jord. Kom alle ingredienser i en blender, og blend til en jævn masse. Smag pestoen\ntil med salt."],
  },
];

describe("SPIS BEDRE Inertia extraction", () => {
  test("extracts the complete reduced fixture in deterministic group order", () => {
    expect(extractSpisBedreInertia(fixture, fixtureUrl)).toEqual({
      title: "3 slags pindemadder",
      sourceUrl: fixtureUrl.href,
      canonicalUrl: fixtureUrl.href,
      author: "Inge Skovdal",
      servings: 10,
      prepMinutes: 60,
      cookMinutes: 45,
      totalMinutes: 60,
      rawIngredients: ingredientGroups.flatMap(({ ingredients }) => ingredients),
      instructions: instructionGroups.flatMap(({ instructions }) => instructions),
      dietaryTags: [],
      raw: {
        kind: "spisbedre-inertia",
        component: "app/pages/Recipes/Details",
        title: "3 slags pindemadder",
        slug: "3-slags-pindemadder",
        url: fixtureUrl.href,
        author: "Inge Skovdal",
        servingSize: 10,
        preparationTime: 60,
        cookingTime: 45,
        totalTime: 60,
        ingredientGroups,
        instructionGroups,
      },
    });
  });

  test("sorts groups stably and renders singular and plural ingredient evidence", () => {
    const group = (title: string, sortOrder: number, amount: number) => ({
      title,
      sort_order: sortOrder,
      ingredients: [{
        prefix: "friske",
        amount,
        unit: { name_singular: "stykke", name_plural: "stykker" },
        ingredient: { name_singular: "tomat", name_plural: "tomater" },
        suffix: "i skiver",
      }],
    });
    const recipe = minimalRecipe({
      grouped_ingredients: [group("Plural", 2, 2), group("Singular", 1, 1), group("Also singular", 1, 1)],
    });
    const result = extractSpisBedreInertia(inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: { recipe },
    }), fixtureUrl);

    expect(result.rawIngredients).toEqual([
      "friske 1 stykke tomat i skiver",
      "friske 1 stykke tomat i skiver",
      "friske 2 stykker tomater i skiver",
    ]);
    expect(result.raw.ingredientGroups).toEqual([
      { title: "Singular", sortOrder: 1, ingredients: ["friske 1 stykke tomat i skiver"] },
      { title: "Also singular", sortOrder: 1, ingredients: ["friske 1 stykke tomat i skiver"] },
      { title: "Plural", sortOrder: 2, ingredients: ["friske 2 stykker tomater i skiver"] },
    ]);
  });

  test("rejects malformed JSON, the wrong component, and a missing recipe shape", () => {
    expect(() => extractSpisBedreInertia('<div id="app" data-page="{"></div>', fixtureUrl))
      .toThrow("SPIS BEDRE data-page contains malformed JSON");
    expect(() => extractSpisBedreInertia(inertiaHtml({ component: "Other", props: {} }), fixtureUrl))
      .toThrow("Unexpected SPIS BEDRE Inertia component: Other");
    expect(() => extractSpisBedreInertia(inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: {},
    }), fixtureUrl)).toThrow("SPIS BEDRE data-page props.recipe must be an object");
  });

  test("rejects missing titles, unsafe URLs, excessive groups and items", () => {
    const page = (recipe: Record<string, unknown>) => inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: { recipe },
    });
    expect(() => extractSpisBedreInertia(page(minimalRecipe({ title: "" })), fixtureUrl))
      .toThrow("SPIS BEDRE recipe title cannot be empty");
    expect(() => extractSpisBedreInertia(page(minimalRecipe({ url: "file:///etc/passwd" })), fixtureUrl))
      .toThrow("Recipe source URL is invalid, unsafe, or cross-site");
    expect(() => extractSpisBedreInertia(page(minimalRecipe({
      grouped_ingredients: Array.from({ length: 101 }, (_, sort_order) => ({
        title: "group",
        sort_order,
        ingredients: [],
      })),
    })), fixtureUrl)).toThrow("SPIS BEDRE ingredient groups exceeds 100 items");
    expect(() => extractSpisBedreInertia(page(minimalRecipe({
      grouped_instructions: [{
        title: "group",
        sort_order: 0,
        instructions: Array.from({ length: 501 }, () => ({ instruction: "step" })),
      }],
    })), fixtureUrl)).toThrow("SPIS BEDRE instruction group 0 instructions exceeds 500 items");
  });

  test("rejects unsafe keys and excessive input depth before reading the recipe", () => {
    const unsafe = '<div id="app" data-page="{&quot;component&quot;:&quot;app/pages/Recipes/Details&quot;,&quot;__proto__&quot;:{}}"></div>';
    expect(() => extractSpisBedreInertia(unsafe, fixtureUrl))
      .toThrow('SPIS BEDRE data-page contains unsafe key "__proto__"');

    let deep: Record<string, unknown> = {};
    for (let index = 0; index < 31; index += 1) deep = { child: deep };
    expect(() => extractSpisBedreInertia(inertiaHtml(deep), fixtureUrl))
      .toThrow("SPIS BEDRE data-page exceeds maximum depth 30");
  });

  test("enforces aggregate ingredient and instruction caps before flattening groups", () => {
    const ingredient = {
      amount: 1,
      ingredient: { name_singular: "salt", name_plural: "salt" },
      unit: null,
    };
    const ingredients = Array.from({ length: 300 }, () => ingredient);
    const instructions = Array.from({ length: 300 }, () => ({ instruction: "Stir." }));
    const page = (recipe: Record<string, unknown>) => inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: { recipe },
    });

    expect(() => extractSpisBedreInertia(page(minimalRecipe({
      grouped_ingredients: [
        { title: "A", sort_order: 0, ingredients },
        { title: "B", sort_order: 1, ingredients },
      ],
    })), fixtureUrl)).toThrow("SPIS BEDRE ingredient groups exceed 500 aggregate items");
    expect(() => extractSpisBedreInertia(page(minimalRecipe({
      grouped_instructions: [
        { title: "A", sort_order: 0, instructions },
        { title: "B", sort_order: 1, instructions },
      ],
    })), fixtureUrl)).toThrow("SPIS BEDRE instruction groups exceed 500 aggregate items");
  });

  test("accepts only canonical positive decimal ingredient amounts", () => {
    const extractAmount = (amount: string | number): string => {
      const recipe = minimalRecipe({
        grouped_ingredients: [{
          title: "Group",
          sort_order: 0,
          ingredients: [{
            amount,
            ingredient: { name_singular: "tomat", name_plural: "tomater" },
            unit: null,
          }],
        }],
      });
      return extractSpisBedreInertia(inertiaHtml({
        component: "app/pages/Recipes/Details",
        props: { recipe },
      }), fixtureUrl).rawIngredients[0]!;
    };

    for (const [amount, expected] of [
      ["1", "1 tomat"],
      ["1.5", "1.5 tomater"],
      ["1,5", "1,5 tomater"],
      ["0.5", "0.5 tomater"],
      [1, "1 tomat"],
      [1.5, "1.5 tomater"],
    ] as const) expect(extractAmount(amount)).toBe(expected);

    for (const amount of ["-1", "0", "01", "+1", "1e2", "0x10", " 1", "1 ", "Infinity", "NaN"] as const) {
      expect(() => extractAmount(amount)).toThrow("amount must be a canonical positive decimal");
    }
    for (const amount of [-1, 0, 1_000_000_001]) {
      expect(() => extractAmount(amount)).toThrow("amount must be a positive finite number at most 1000000000");
    }
  });

  test("rejects fractional and out-of-range minute values", () => {
    for (const [field, value] of [
      ["preparation_time", 1.5],
      ["cooking_time", 525_601],
      ["total_time", -1],
    ] as const) {
      expect(() => extractSpisBedreInertia(inertiaHtml({
        component: "app/pages/Recipes/Details",
        props: { recipe: minimalRecipe({ [field]: value }) },
      }), fixtureUrl)).toThrow("must be a safe integer between 0 and 525600 or null");
    }
  });

  test("rejects cross-site payload provenance including evil.example", () => {
    const html = inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: { recipe: minimalRecipe({ url: "https://evil.example/stolen" }) },
    });
    expect(() => extractSpisBedreInertia(html, fixtureUrl))
      .toThrow("Recipe source URL is invalid, unsafe, or cross-site");
  });

  test("rejects unsafe page provenance before parsing embedded recipe evidence", () => {
    const html = inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: { recipe: minimalRecipe() },
    });
    for (const pageUrl of [
      "ftp://spisbedre.dk/page",
      "https://user:secret@spisbedre.dk/page",
      "https://spisbedre.dk/%ZZ",
      "https://evil.example/page",
    ]) {
      expect(() => extractSpisBedreInertia(html, new URL(pageUrl)))
        .toThrow("spisbedre-inertia adapter is only allowed for its configured built-in host");
    }
  });

  test("falls back from persistence-incompatible optional canonicals", () => {
    for (const canonical of [
      "   ",
      "http://[",
      "https://spisbedre.dk/%ZZ",
      "https://spisbedre.dk/%",
      "https://spisbedre.dk/%2",
      "javascript:alert(1)",
      "ftp://spisbedre.dk/unsafe",
      "https://user:secret@spisbedre.dk/unsafe",
      `https://spisbedre.dk/${"x".repeat(2_100)}`,
      "https://evil.example/stolen",
    ]) {
      const html = `<link rel="canonical" href="${canonical}">${inertiaHtml({
        component: "app/pages/Recipes/Details",
        props: { recipe: minimalRecipe() },
      })}`;
      const result = extractSpisBedreInertia(html, fixtureUrl);
      expect(result).toMatchObject({
        sourceUrl: "https://spisbedre.dk/opskrifter/test-recipe",
        canonicalUrl: "https://spisbedre.dk/opskrifter/test-recipe",
      });
      expect(() => normalizeRecipeCanonicalUrl(result.canonicalUrl)).not.toThrow();
    }
  });

  test("accepts www-equivalent same-site provenance and strips fragments", () => {
    const html = `<link rel="canonical" href="https://spisbedre.dk/canonical#section">${inertiaHtml({
      component: "app/pages/Recipes/Details",
      props: {
        recipe: minimalRecipe({ url: "https://www.spisbedre.dk/opskrifter/test-recipe#details" }),
      },
    })}`;
    expect(extractSpisBedreInertia(html, fixtureUrl)).toMatchObject({
      sourceUrl: "https://www.spisbedre.dk/opskrifter/test-recipe",
      canonicalUrl: "https://spisbedre.dk/canonical",
    });
  });
});
