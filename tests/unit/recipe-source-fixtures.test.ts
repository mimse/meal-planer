import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "cheerio";
import { extractRecipeJsonLd } from "../../src/adapters/recipes/jsonld";
import {
  BUILT_IN_RECIPE_SOURCES,
  type RecipeExtractionKind,
} from "../../src/adapters/recipes/sources";

type FixtureContract = {
  id: string;
  file: string;
  captureFile: string;
  captureSha256: string;
  captureDate: "2026-09-27";
  reduction: string;
  url: string;
  title: string;
  extraction: RecipeExtractionKind;
  jsonld?: {
    author: string;
    servings: number;
    prepMinutes: number | null;
    cookMinutes: number | null;
    totalMinutes: number;
    ingredients: string[];
    instructions: string[];
  };
};

const fixturesDirectory = resolve(import.meta.dir, "../fixtures/recipes");
const fixtureContracts: readonly FixtureContract[] = [
  {
    id: "valdemarsro",
    file: "valdemarsro.html",
    captureFile: "valdemarsro_dk.html",
    captureSha256: "fee70c234c53cdf09aeace9b95997c30bd31f192cd747b217bf20c11f0261a6d",
    captureDate: "2026-09-27",
    reduction: "Recipe microdata core fields; ingredients; instruction paragraphs",
    url: "https://www.valdemarsro.dk/kage-med-rabarber/",
    title: "Kage med rabarber",
    extraction: "microdata",
  },
  {
    id: "gourministeriet",
    file: "gourministeriet.html",
    captureFile: "gourministeriet_dk.html",
    captureSha256: "40adb4eb0b22bf01110a9d3523f83a4bdca1e91ae8515fe165d53a1db259c8f3",
    captureDate: "2026-09-27",
    reduction: "Recipe JSON-LD; one nested section and step",
    url: "https://gourministeriet.dk/frikadeller-med-perlebygsalat-broccoli-og-feta/",
    title: "Frikadeller med perlebygsalat, broccoli og feta",
    extraction: "jsonld",
    jsonld: {
      author: "Dianna",
      servings: 4,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: 60,
      ingredients: [
        "600 g hakket svinekød eller kalv/flæsk",
        "1  stort løg – finthakket, revet eller blendet",
      ],
      instructions: [
        "Hæld alle ingredienserne i en skål, krydr med friskkværnet peber og rør farsen godt sammen. Lad farsen hvile i 15-20 minutter.",
      ],
    },
  },
  {
    id: "spisbedre",
    file: "spisbedre.html",
    captureFile: "spisbedre_dk.html",
    captureSha256: "a54eceba0d649634dceb270a63b885da80ccc0274272ef6e94469a64376e0ba3",
    captureDate: "2026-09-27",
    reduction: "Inertia recipe core fields; one member per ingredient and instruction group",
    url: "https://spisbedre.dk/opskrifter/3-slags-pindemadder",
    title: "3 slags pindemadder",
    extraction: "spisbedre-inertia",
  },
  {
    id: "juliebruun",
    file: "juliebruun.html",
    captureFile: "juliebruun_com.html",
    captureSha256: "5d359e6d55306716b755ed0b8096a471857dae3ce0fe9384e6a3c927dfbabc15",
    captureDate: "2026-09-27",
    reduction: "Recipe JSON-LD core fields",
    url: "https://juliebruun.com/flaeskesteg-i-airfryer/",
    title: "Flæskesteg i airfryer",
    extraction: "jsonld",
    jsonld: {
      author: "Julie Bruun",
      servings: 6,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: 75,
      ingredients: [
        "1,3 kg svinekam med ridset svær ",
        "8 dl vand ",
        "1 spsk. salt ",
      ],
      instructions: [
        "Tænd din airfryer, så den varmer lidt op i 5 minutters tid\nTjek imens at dine svær er ridset godt ned i stegen. Undgå dog at skære ned i selve kødet.\nLæg din steg i en airfryer og hæld 8 dl kogende vand over den (hen over grisens svær)\nKom salt over den og gnid det godt ned mellem de her svær\nGiv den 60 minutter ved 180 grader.\nHver 10. eller 15. minut kan du skovle lidt af vandet fra kurven op over flæskestegen.\nNår den har fået en time, tages den ud og lægges på et skærebræt, lad den ligge sådan 10-15 minutter\nSå er du klar til at skære stykker af din flæskesteg",
      ],
    },
  },
  {
    id: "juliekarla",
    file: "juliekarla.html",
    captureFile: "juliekarla_dk.html",
    captureSha256: "f85992885ddd462231c4dc87842e8b0cd28ff48a5930fbf1e0eaacd490cb9c7a",
    captureDate: "2026-09-27",
    reduction: "Recipe JSON-LD; representative HowToStep",
    url: "https://www.juliekarla.dk/opskrift-bladbeder-figner-pinjekerner/",
    title: "Opskrift med bladbeder, figner og pinjekerner",
    extraction: "jsonld",
    jsonld: {
      author: "Julie Karla",
      servings: 3,
      prepMinutes: 15,
      cookMinutes: 10,
      totalMinutes: 25,
      ingredients: ["400  gr. bladbeder", "2-3 fed hvidløg"],
      instructions: [
        "Skyl bladbederne grundigt. Skær stænglerne af og snit dem fint.",
      ],
    },
  },
  {
    id: "mummum",
    file: "mummum.html",
    captureFile: "mummum_dk.html",
    captureSha256: "6716a1b43e822364e64d7fa3c5ac84b2e89b74931587568f18651558a9f15f13",
    captureDate: "2026-09-27",
    reduction: "Recipe JSON-LD core fields and source-page links",
    url: "https://mummum.dk/opskrift-paa-nemme-croutoner/",
    title: "Brødcroutoner",
    extraction: "jsonld",
    jsonld: {
      author: "mummum",
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 15,
      totalMinutes: 25,
      ingredients: [
        "200 g. franskbrød",
        "5 spsk. olivenolie",
        "1 fed hvidløg",
        " salt",
      ],
      instructions: [
        "Opvarm ovnen til 200 grader varmluft. Skær brød i tern. Pres hvidløg og vend det i olivenolien og tilsæt salt. Vend nu olien i brødternene og bag dem i 15 minutter. Vend dem evt. lidt rundt undervejs.",
      ],
    },
  },
] as const;

function readFixture(contract: FixtureContract): string {
  return readFileSync(resolve(fixturesDirectory, contract.file), "utf8");
}

function canonicalUrl(html: string): string | undefined {
  return load(html)('link[rel="canonical"]').first().attr("href");
}

function provenanceRows(markdown: string): Array<{
  file: string;
  url: string;
  captureDate: string;
  extraction: string;
  captureFile: string;
  captureSha256: string;
  reduction: string;
}> {
  return markdown
    .split("\n")
    .filter((line) => /^\|\s*`[^`]+\.html`\s*\|/.test(line))
    .map((line) => {
      const columns = line
        .split("|")
        .slice(1, -1)
        .map((cell) => cell.trim().replace(/^`|`$/g, ""));
      if (columns.length !== 7) {
        throw new Error(`Malformed fixture provenance row: ${line}`);
      }
      const [file, url, captureDate, extraction, captureFile, captureSha256, reduction] = columns as [
        string,
        string,
        string,
        string,
        string,
        string,
        string,
      ];
      return { file, url, captureDate, extraction, captureFile, captureSha256, reduction };
    });
}

describe("recipe source fixture contract", () => {
  test("binds one compact reduced snapshot to every built-in source", () => {
    expect(
      fixtureContracts.map(({ id, extraction }) => ({ id, extraction })),
    ).toEqual(
      BUILT_IN_RECIPE_SOURCES.map(({ id, extraction }) => ({ id, extraction })),
    );

    for (const contract of fixtureContracts) {
      const source = BUILT_IN_RECIPE_SOURCES.find(({ id }) => id === contract.id);
      if (!source) throw new Error(`Missing built-in source for ${contract.id}`);
      expect(source.extraction).toBe(contract.extraction);
      expect(new URL(contract.url).hostname.replace(/^www\./, "")).toBe(source.host);

      const html = readFixture(contract);
      expect(Buffer.byteLength(html)).toBeLessThan(8_192);
      expect(html).not.toMatch(/google-analytics|googletagmanager|doubleclick|dataLayer/i);
      expect(canonicalUrl(html)).toBe(contract.url);
    }
  });

  test("binds every provenance row to one fixture and its source capture", () => {
    const provenance = readFileSync(resolve(fixturesDirectory, "README.md"), "utf8");
    expect(provenance.toLowerCase()).toContain("reduced snapshots");
    expect(provenance).toContain("retained value and field nesting is copied verbatim");
    expect(provenanceRows(provenance)).toEqual(
      fixtureContracts.map((contract) => ({
        file: contract.file,
        url: contract.url,
        captureDate: contract.captureDate,
        extraction: contract.extraction,
        captureFile: contract.captureFile,
        captureSha256: contract.captureSha256,
        reduction: contract.reduction,
      })),
    );
  });
});

describe("generic JSON-LD source fixtures", () => {
  for (const contract of fixtureContracts.filter(({ jsonld }) => jsonld !== undefined)) {
    test(`preserves explicit ${contract.id} source evidence`, () => {
      const expected = contract.jsonld!;
      const recipe = extractRecipeJsonLd(readFixture(contract), new URL(contract.url));

      expect(recipe.title).toBe(contract.title);
      expect(recipe.author).toBe(expected.author);
      expect(recipe.servings).toBe(expected.servings);
      expect(recipe.prepMinutes).toBe(expected.prepMinutes);
      expect(recipe.cookMinutes).toBe(expected.cookMinutes);
      expect(recipe.totalMinutes).toBe(expected.totalMinutes);
      expect(recipe.rawIngredients).toEqual(expected.ingredients);
      expect(recipe.instructions).toEqual(expected.instructions);
      expect(recipe.sourceUrl).toBe(contract.url);
      expect(recipe.canonicalUrl).toBe(contract.url);

      if (contract.id === "gourministeriet") {
        expect(recipe.raw.author).toEqual({ "@type": "Person", name: "Dianna" });
        expect(recipe.raw.recipeYield).toEqual(["4", "4 personer"]);
        expect(recipe.raw.recipeInstructions).toEqual([
          {
            "@type": "HowToSection",
            name: "Frikadellerne",
            itemListElement: [
              {
                "@type": "HowToStep",
                text: expected.instructions[0],
              },
            ],
          },
        ]);
      } else if (contract.id === "juliebruun") {
        expect(recipe.raw.author).toBe("Julie Bruun");
        expect(recipe.raw.recipeYield).toBe("6-8 personer  person");
        expect(recipe.raw.recipeInstructions).toBe(`${expected.instructions[0]} `);
      } else if (contract.id === "juliekarla") {
        expect(recipe.raw.author).toEqual({ "@type": "Person", name: "Julie Karla" });
        expect(recipe.raw.recipeYield).toEqual(["3", "3 -4"]);
        expect(recipe.raw.recipeInstructions).toEqual([
          { "@type": "HowToStep", text: expected.instructions[0] },
        ]);
      } else if (contract.id === "mummum") {
        expect(recipe.raw.name).toBe("Brødcroutoner ");
        expect(recipe.raw.url).toBe(contract.url);
        expect(recipe.raw.mainEntityOfPage).toEqual({
          "@type": "WebPage",
          "@id": contract.url,
        });
      }
    });
  }
});

describe("custom extraction evidence fixtures", () => {
  test("preserves Valdemarsro Recipe microdata values, element forms, and nested scopes", () => {
    const contract = fixtureContracts.find(({ id }) => id === "valdemarsro")!;
    const $ = load(readFixture(contract));
    const scopes = $('[itemscope][itemtype="http://schema.org/Recipe"]');

    expect(scopes).toHaveLength(1);
    const scope = scopes.first();
    expect(scope.prop("tagName")).toBe("DIV");

    const publisher = scope.find(':scope [itemprop="publisher"]').first();
    expect(publisher.prop("tagName")).toBe("SPAN");
    expect(publisher.attr("itemscope")).toBeDefined();
    expect(publisher.attr("itemtype")).toBe("https://schema.org/Organization");
    expect(publisher.children('[itemprop="name"]').first().text()).toBe("Valdemarsro");

    const author = scope.find(':scope [itemprop="author"]').first();
    expect(author.prop("tagName")).toBe("SPAN");
    expect(author.attr("itemscope")).toBeDefined();
    expect(author.attr("itemtype")).toBe("https://schema.org/Person");
    expect(author.children('[itemprop="name"]').first().text()).toBe(
      "Ann-Christine Hellerup Brandt",
    );

    const names = scope.find('[itemprop="name"]');
    expect(names.first().text()).toBe("Valdemarsro");
    expect(scope.find('h2[itemprop="name"]').text()).toBe(contract.title);
    expect(scope.find('[itemprop="mainEntityOfPage"]').text()).toBe(contract.url);

    for (const [property, value] of [
      ["cookTime", "PT1H30M"],
      ["totalTime", "PT30M"],
      ["recipeYield", "1"],
    ] as const) {
      const element = scope.find(`[itemprop="${property}"]`);
      expect(element.prop("tagName")).toBe("SPAN");
      expect(element.attr("content")).toBeUndefined();
      expect(element.text()).toBe(value);
    }

    expect(
      scope.find('[itemprop="recipeIngredient"]').toArray().map((element) => $(element).text()),
    ).toEqual([
      "½ vaniljestang",
      "300 g sukker",
      "300 g smør",
      "4 æg",
      "1 dl piskefløde",
      "2½ tsk bagepulver",
      "290 g hvedemel",
      "400 g rabarber, i tern",
      "100 g hvid chokolade, grofthakket",
      "1 spsk flormelis, til drys",
    ]);

    const instructions = scope.find('div[itemprop="recipeInstructions"]');
    expect(instructions.prop("tagName")).toBe("DIV");
    expect(instructions.attr("class")).toBe("content");
    expect(instructions.children("p").toArray().map((element) => $(element).text())).toEqual([
      "Skær vaniljestangen igennem på langs, skrab forsigtigt kornene ud med en kniv og fordel dem i sukkeret. Pisk vanilje, sukker og smør sammen, til det er lyst og luftigt. Pisk derefter et æg i ad gangen og pisk til sidst fløden i.",
      "Bland bagepulver med hvedemel og sigt det i dejen. Vend dejen sammen og vend derefter rabarber og den hvide chokolade i dejen.",
      "Kom dejen i en smurt form beklædt med bagepapir. Bag i en forvarmet ovn ved 175 grader varmluft i ca. 45 minutter.",
      "Lad kagen køle lidt af på en bagerist og drys med flormelis inden servering.",
    ]);
  });

  test("preserves explicit SPIS BEDRE grouped Inertia evidence", () => {
    const contract = fixtureContracts.find(({ id }) => id === "spisbedre")!;
    const $ = load(readFixture(contract));
    const encodedPage = $("#app").attr("data-page");

    expect(encodedPage).toBeDefined();
    const page = JSON.parse(encodedPage!) as {
      component?: unknown;
      props?: { recipe?: Record<string, unknown> };
    };
    expect(page.component).toBe("app/pages/Recipes/Details");
    expect(page.props?.recipe).toEqual({
      title: contract.title,
      slug: "3-slags-pindemadder",
      serving_size: 10,
      preparation_time: 60,
      cooking_time: 45,
      total_time: 60,
      url: contract.url,
      author: "Inge Skovdal",
      grouped_ingredients: [
        {
          title: "Pindemad med tomat og mozzarella",
          sort_order: 0,
          ingredients: [
            {
              amount: 2,
              ingredient: {
                name_singular: "cherrytomat",
                name_plural: "cherrytomater",
              },
              unit: {
                name_singular: "stk.",
                name_plural: "stk.",
                abbreviation: "stk.",
              },
            },
          ],
        },
        {
          title: "Kylling-bacon-sticks",
          sort_order: 1,
          ingredients: [
            {
              amount: 2,
              ingredient: {
                name_singular: "kyllingeinderfilet",
                name_plural: "kyllingeinderfileter",
              },
              unit: {
                name_singular: "stk.",
                name_plural: "stk.",
                abbreviation: "stk.",
              },
            },
          ],
        },
        {
          title: "Små kartofler i persillepesto",
          sort_order: 2,
          ingredients: [
            {
              prefix: "små",
              suffix: "med skræl",
              amount: 60,
              ingredient: {
                name_singular: "kartoffel",
                name_plural: "kartofler",
              },
              unit: {
                name_singular: "gram",
                name_plural: "gram",
                abbreviation: "g",
              },
            },
          ],
        },
      ],
      grouped_instructions: [
        {
          title: "Pindemad med tomat og mozzarella",
          sort_order: 0,
          instructions: [
            {
              instruction: "Skyl, og bag tomaterne i ovnen i ca. 25 minutter ved 150°. Lad dem afkøle.",
            },
          ],
        },
        {
          title: "Kylling-bacon-sticks",
          sort_order: 1,
          instructions: [
            {
              instruction: "Læg træpindene i vand i mindst 30 minutter. Tænd ovnen på 200°.",
            },
          ],
        },
        {
          title: "Små kartofler i persillepesto",
          sort_order: 2,
          instructions: [
            {
              instruction: "Vask persillen godt for jord. Kom alle ingredienser i en blender, og blend til en jævn masse. Smag pestoen\ntil med salt.",
            },
          ],
        },
      ],
    });
  });
});
