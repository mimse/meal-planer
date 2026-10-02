import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  BUILT_IN_RECIPE_EXTRACTION_KINDS,
  RECIPE_EXTRACTION_ADAPTERS,
  buildRecipeSourceRouting,
  extractRecipeWithAdapter,
  getRecipeExtractionAdapter,
} from "../../src/adapters/recipes/registry";
import { BUILT_IN_RECIPE_SOURCES } from "../../src/adapters/recipes/sources";
import { DIETARY_TAGS } from "../../src/domain/recipe";
import { extractRecipeJsonLd } from "../../src/adapters/recipes/jsonld";
import { extractValdemarsroMicrodata } from "../../src/adapters/recipes/valdemarsro";

const fixtureDirectory = resolve(import.meta.dir, "../fixtures/recipes");
const fixtureUrls: Readonly<Record<string, string>> = {
  valdemarsro: "https://www.valdemarsro.dk/kage-med-rabarber/",
  gourministeriet: "https://gourministeriet.dk/frikadeller-med-perlebygsalat-broccoli-og-feta/",
  spisbedre: "https://spisbedre.dk/opskrifter/3-slags-pindemadder",
  juliebruun: "https://juliebruun.com/flaeskesteg-i-airfryer/",
  juliekarla: "https://www.juliekarla.dk/opskrift-bladbeder-figner-pinjekerner/",
  mummum: "https://mummum.dk/opskrift-paa-nemme-croutoner/",
};
const fixtureTitles: Readonly<Record<string, string>> = {
  valdemarsro: "Kage med rabarber",
  gourministeriet: "Frikadeller med perlebygsalat, broccoli og feta",
  spisbedre: "3 slags pindemadder",
  juliebruun: "Flæskesteg i airfryer",
  juliekarla: "Opskrift med bladbeder, figner og pinjekerner",
  mummum: "Brødcroutoner",
};
const fixtureExpectations = {
  valdemarsro: {
    title: "Kage med rabarber",
    url: "https://www.valdemarsro.dk/kage-med-rabarber/",
    author: "Ann-Christine Hellerup Brandt",
    servings: 1,
    prepMinutes: null,
    cookMinutes: 90,
    totalMinutes: 30,
    ingredientCount: 10,
    firstIngredient: "½ vaniljestang",
    lastIngredient: "1 spsk flormelis, til drys",
    instructionCount: 4,
    firstInstruction: "Skær vaniljestangen igennem på langs, skrab forsigtigt kornene ud med en kniv og fordel dem i sukkeret. Pisk vanilje, sukker og smør sammen, til det er lyst og luftigt. Pisk derefter et æg i ad gangen og pisk til sidst fløden i.",
    lastInstruction: "Lad kagen køle lidt af på en bagerist og drys med flormelis inden servering.",
  },
  gourministeriet: {
    title: "Frikadeller med perlebygsalat, broccoli og feta",
    url: "https://gourministeriet.dk/frikadeller-med-perlebygsalat-broccoli-og-feta/",
    author: "Dianna",
    servings: 4,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: 60,
    ingredientCount: 2,
    firstIngredient: "600 g hakket svinekød eller kalv/flæsk",
    lastIngredient: "1  stort løg – finthakket, revet eller blendet",
    instructionCount: 1,
    firstInstruction: "Hæld alle ingredienserne i en skål, krydr med friskkværnet peber og rør farsen godt sammen. Lad farsen hvile i 15-20 minutter.",
    lastInstruction: "Hæld alle ingredienserne i en skål, krydr med friskkværnet peber og rør farsen godt sammen. Lad farsen hvile i 15-20 minutter.",
  },
  spisbedre: {
    title: "3 slags pindemadder",
    url: "https://spisbedre.dk/opskrifter/3-slags-pindemadder",
    author: "Inge Skovdal",
    servings: 10,
    prepMinutes: 60,
    cookMinutes: 45,
    totalMinutes: 60,
    ingredientCount: 3,
    firstIngredient: "2 stk. cherrytomater",
    lastIngredient: "små 60 gram kartofler med skræl",
    instructionCount: 3,
    firstInstruction: "Skyl, og bag tomaterne i ovnen i ca. 25 minutter ved 150°. Lad dem afkøle.",
    lastInstruction: "Vask persillen godt for jord. Kom alle ingredienser i en blender, og blend til en jævn masse. Smag pestoen\ntil med salt.",
  },
  juliebruun: {
    title: "Flæskesteg i airfryer",
    url: "https://juliebruun.com/flaeskesteg-i-airfryer/",
    author: "Julie Bruun",
    servings: 6,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: 75,
    ingredientCount: 3,
    firstIngredient: "1,3 kg svinekam med ridset svær ",
    lastIngredient: "1 spsk. salt ",
    instructionCount: 1,
    firstInstruction: "Tænd din airfryer, så den varmer lidt op i 5 minutters tid\nTjek imens at dine svær er ridset godt ned i stegen. Undgå dog at skære ned i selve kødet.\nLæg din steg i en airfryer og hæld 8 dl kogende vand over den (hen over grisens svær)\nKom salt over den og gnid det godt ned mellem de her svær\nGiv den 60 minutter ved 180 grader.\nHver 10. eller 15. minut kan du skovle lidt af vandet fra kurven op over flæskestegen.\nNår den har fået en time, tages den ud og lægges på et skærebræt, lad den ligge sådan 10-15 minutter\nSå er du klar til at skære stykker af din flæskesteg",
    lastInstruction: "Tænd din airfryer, så den varmer lidt op i 5 minutters tid\nTjek imens at dine svær er ridset godt ned i stegen. Undgå dog at skære ned i selve kødet.\nLæg din steg i en airfryer og hæld 8 dl kogende vand over den (hen over grisens svær)\nKom salt over den og gnid det godt ned mellem de her svær\nGiv den 60 minutter ved 180 grader.\nHver 10. eller 15. minut kan du skovle lidt af vandet fra kurven op over flæskestegen.\nNår den har fået en time, tages den ud og lægges på et skærebræt, lad den ligge sådan 10-15 minutter\nSå er du klar til at skære stykker af din flæskesteg",
  },
  juliekarla: {
    title: "Opskrift med bladbeder, figner og pinjekerner",
    url: "https://www.juliekarla.dk/opskrift-bladbeder-figner-pinjekerner/",
    author: "Julie Karla",
    servings: 3,
    prepMinutes: 15,
    cookMinutes: 10,
    totalMinutes: 25,
    ingredientCount: 2,
    firstIngredient: "400  gr. bladbeder",
    lastIngredient: "2-3 fed hvidløg",
    instructionCount: 1,
    firstInstruction: "Skyl bladbederne grundigt. Skær stænglerne af og snit dem fint.",
    lastInstruction: "Skyl bladbederne grundigt. Skær stænglerne af og snit dem fint.",
  },
  mummum: {
    title: "Brødcroutoner",
    url: "https://mummum.dk/opskrift-paa-nemme-croutoner/",
    author: "mummum",
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 15,
    totalMinutes: 25,
    ingredientCount: 4,
    firstIngredient: "200 g. franskbrød",
    lastIngredient: " salt",
    instructionCount: 1,
    firstInstruction: "Opvarm ovnen til 200 grader varmluft. Skær brød i tern. Pres hvidløg og vend det i olivenolien og tilsæt salt. Vend nu olien i brødternene og bag dem i 15 minutter. Vend dem evt. lidt rundt undervejs.",
    lastInstruction: "Opvarm ovnen til 200 grader varmluft. Skær brød i tern. Pres hvidløg og vend det i olivenolien og tilsæt salt. Vend nu olien i brødternene og bag dem i 15 minutter. Vend dem evt. lidt rundt undervejs.",
  },
} as const;

function fixture(id: string): string {
  return readFileSync(resolve(fixtureDirectory, `${id}.html`), "utf8");
}

describe("recipe extraction registry", () => {
  test("registers every configured adapter and maps all six built-ins explicitly", () => {
    expect(Object.keys(RECIPE_EXTRACTION_ADAPTERS).sort()).toEqual([
      "auto",
      "jsonld",
      "microdata",
      "spisbedre-inertia",
    ]);
    expect(BUILT_IN_RECIPE_EXTRACTION_KINDS).toEqual(Object.fromEntries(
      BUILT_IN_RECIPE_SOURCES.map((source) => [source.id, source.extraction]),
    ));
    for (const source of BUILT_IN_RECIPE_SOURCES) {
      expect(BUILT_IN_RECIPE_EXTRACTION_KINDS[source.id]).toBe(source.extraction);
      expect(getRecipeExtractionAdapter(source.extraction).kind).toBe(source.extraction);
    }
  });

  test("rejects duplicate source ids and normalized hosts while building routes", () => {
    const source = BUILT_IN_RECIPE_SOURCES[0]!;
    expect(() => buildRecipeSourceRouting([
      source,
      { ...source, host: "different.example" },
    ])).toThrow(`Duplicate built-in recipe source id: ${source.id}`);
    expect(() => buildRecipeSourceRouting([
      source,
      { ...source, id: "different", host: `www.${source.host}` },
    ])).toThrow(`Duplicate built-in recipe source host: ${source.host}`);
  });

  test("extracts every built-in fixture against independent expected contracts", () => {
    for (const source of BUILT_IN_RECIPE_SOURCES) {
      const url = new URL(fixtureUrls[source.id]!);
      const expected = fixtureExpectations[source.id as keyof typeof fixtureExpectations];
      const recipe = extractRecipeWithAdapter(source.extraction, fixture(source.id), url);
      expect(recipe).toMatchObject({
        title: expected.title,
        sourceUrl: expected.url,
        canonicalUrl: expected.url,
        author: expected.author,
        servings: expected.servings,
        prepMinutes: expected.prepMinutes,
        cookMinutes: expected.cookMinutes,
        totalMinutes: expected.totalMinutes,
        dietaryTags: [],
      });
      expect(recipe.rawIngredients).toHaveLength(expected.ingredientCount);
      expect(recipe.rawIngredients[0]).toBe(expected.firstIngredient);
      expect(recipe.rawIngredients.at(-1)).toBe(expected.lastIngredient);
      expect(recipe.instructions).toHaveLength(expected.instructionCount);
      expect(recipe.instructions[0]).toBe(expected.firstInstruction);
      expect(recipe.instructions.at(-1)).toBe(expected.lastInstruction);
    }
  });

  test("auto selects custom built-ins by host and generic JSON-LD otherwise", () => {
    for (const source of BUILT_IN_RECIPE_SOURCES) {
      const url = new URL(fixtureUrls[source.id]!);
      const recipe = extractRecipeWithAdapter("auto", fixture(source.id), url);
      expect(recipe.title).toBe(fixtureTitles[source.id]!);
    }

    const generic = `<script type="application/ld+json">{
      "@type":"Recipe","name":"External soup","url":"/soup"
    }</script>`;
    expect(extractRecipeWithAdapter(
      "auto",
      generic,
      new URL("https://recipes.example/soup"),
    ).title).toBe("External soup");
  });

  test("rejects explicitly selected site-specific adapters on mismatched hosts", () => {
    expect(() => extractRecipeWithAdapter(
      "microdata",
      '<div itemscope itemtype="https://schema.org/Recipe"><h1 itemprop="name">Wrong host</h1></div>',
      new URL("https://recipes.example/wrong"),
    )).toThrow("microdata adapter is only allowed for its configured built-in host");
    expect(() => extractRecipeWithAdapter(
      "spisbedre-inertia",
      fixture("spisbedre"),
      new URL("https://recipes.example/wrong"),
    )).toThrow("spisbedre-inertia adapter is only allowed for its configured built-in host");
  });

  test("normalizes Schema.org dietary enums without inventing a manual unrestricted classification", () => {
    const enumNames = [
      "DiabeticDiet",
      "GlutenFreeDiet",
      "HalalDiet",
      "HinduDiet",
      "KosherDiet",
      "LowCalorieDiet",
      "LowFatDiet",
      "LowLactoseDiet",
      "LowSaltDiet",
      "VeganDiet",
      "VegetarianDiet",
      "UnknownDiet",
      "VeganDiet",
    ];
    const jsonLd = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Diet recipe",
      suitableForDiet: enumNames.map((name) => `https://schema.org/${name}`),
    })}</script>`;
    const microdata = `<div itemscope itemtype="https://schema.org/Recipe">
      <h1 itemprop="name">Diet recipe</h1>
      ${enumNames.map((name) => `<meta itemprop="suitableForDiet" content="https://schema.org/${name}">`).join("")}
    </div>`;

    const sourceDietaryTags = DIETARY_TAGS.filter((tag) => tag !== "unrestricted");
    expect(extractRecipeJsonLd(jsonLd, new URL("https://recipes.example/diet")).dietaryTags)
      .toEqual(sourceDietaryTags);
    expect(extractValdemarsroMicrodata(microdata, new URL("https://www.valdemarsro.dk/diet")).dietaryTags)
      .toEqual(sourceDietaryTags);
  });
});
