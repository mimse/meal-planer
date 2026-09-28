import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { extractValdemarsroMicrodata } from "../../src/adapters/recipes/valdemarsro";
import { normalizeRecipeCanonicalUrl } from "../../src/infrastructure/recipe-repository";

const fixtureUrl = new URL("https://www.valdemarsro.dk/kage-med-rabarber/");
const fixture = readFileSync(
  resolve(import.meta.dir, "../fixtures/recipes/valdemarsro.html"),
  "utf8",
);
const ingredients = [
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
];
const instructions = [
  "Skær vaniljestangen igennem på langs, skrab forsigtigt kornene ud med en kniv og fordel dem i sukkeret. Pisk vanilje, sukker og smør sammen, til det er lyst og luftigt. Pisk derefter et æg i ad gangen og pisk til sidst fløden i.",
  "Bland bagepulver med hvedemel og sigt det i dejen. Vend dejen sammen og vend derefter rabarber og den hvide chokolade i dejen.",
  "Kom dejen i en smurt form beklædt med bagepapir. Bag i en forvarmet ovn ved 175 grader varmluft i ca. 45 minutter.",
  "Lad kagen køle lidt af på en bagerist og drys med flormelis inden servering.",
];

describe("Valdemarsro microdata extraction", () => {
  test("extracts the complete reduced fixture without repairing inconsistent times", () => {
    expect(extractValdemarsroMicrodata(fixture, fixtureUrl)).toEqual({
      title: "Kage med rabarber",
      sourceUrl: fixtureUrl.href,
      canonicalUrl: fixtureUrl.href,
      author: "Ann-Christine Hellerup Brandt",
      servings: 1,
      prepMinutes: null,
      cookMinutes: 90,
      totalMinutes: 30,
      rawIngredients: ingredients,
      instructions,
      dietaryTags: [],
      raw: {
        kind: "microdata",
        itemType: "http://schema.org/Recipe",
        title: "Kage med rabarber",
        sourceUrl: fixtureUrl.href,
        author: "Ann-Christine Hellerup Brandt",
        recipeYield: "1",
        prepTime: null,
        cookTime: "PT1H30M",
        totalTime: "PT30M",
        ingredients,
        instructions,
        suitableForDiet: [],
      },
    });
  });

  test("isolates nested publisher and author scopes from Recipe properties", () => {
    const html = `<link rel="canonical" href="/recipe">
      <div itemscope itemtype="https://schema.org/Recipe">
        <span itemprop="publisher" itemscope itemtype="https://schema.org/Organization">
          <span itemprop="name">Wrong title</span>
        </span>
        <span itemprop="author" itemscope itemtype="https://schema.org/Person">
          <span itemprop="name">Recipe Author</span>
        </span>
        <h1 itemprop="name">Right title</h1>
        <meta itemprop="suitableForDiet" content="https://schema.org/VeganDiet">
      </div>`;
    expect(extractValdemarsroMicrodata(html, fixtureUrl)).toMatchObject({
      title: "Right title",
      author: "Recipe Author",
      dietaryTags: ["vegan"],
    });
  });

  test("rejects missing titles and excessive ingredient evidence", () => {
    expect(() => extractValdemarsroMicrodata(
      '<div itemscope itemtype="https://schema.org/Recipe"><span itemprop="recipeYield">4</span></div>',
      fixtureUrl,
    )).toThrow("Recipe title cannot be empty");
    const excessive = Array.from({ length: 501 }, () => '<li itemprop="recipeIngredient">salt</li>').join("");
    expect(() => extractValdemarsroMicrodata(
      `<div itemscope itemtype="https://schema.org/Recipe"><h1 itemprop="name">Huge</h1>${excessive}</div>`,
      fixtureUrl,
    )).toThrow("Recipe ingredients exceeds 500 items");
  });

  test("recovers from malformed and oversized candidates and extracts a later Recipe", () => {
    const excessive = Array.from({ length: 501 }, () => '<li itemprop="recipeIngredient">salt</li>').join("");
    for (const firstCandidate of [
      `<div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Broken URL</h1>
        <a itemprop="mainEntityOfPage" href="http://["></a>
      </div>`,
      `<div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Oversized</h1>${excessive}
      </div>`,
    ]) {
      const html = `<link rel="canonical" href="ftp://example.dk/unsafe">
        ${firstCandidate}
        <div itemscope itemtype="https://schema.org/Recipe">
          <h1 itemprop="name">Later valid</h1>
          <a itemprop="mainEntityOfPage" href="/later-valid"></a>
        </div>`;
      expect(extractValdemarsroMicrodata(html, fixtureUrl)).toMatchObject({
        title: "Later valid",
        sourceUrl: "https://www.valdemarsro.dk/later-valid",
        canonicalUrl: "https://www.valdemarsro.dk/later-valid",
      });
    }
  });

  test("rejects cross-site source evidence and ignores cross-site optional canonicals", () => {
    const crossSiteSource = `<div itemscope itemtype="https://schema.org/Recipe">
      <h1 itemprop="name">Cross-site</h1>
      <a itemprop="mainEntityOfPage" href="https://evil.example/stolen"></a>
    </div>`;
    expect(() => extractValdemarsroMicrodata(crossSiteSource, fixtureUrl))
      .toThrow("Recipe source URL is invalid, unsafe, or cross-site");

    const safeSource = `<link rel="canonical" href="https://evil.example/stolen">
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Safe</h1>
        <a itemprop="mainEntityOfPage" href="https://valdemarsro.dk/safe#fragment"></a>
      </div>`;
    expect(extractValdemarsroMicrodata(safeSource, fixtureUrl)).toMatchObject({
      sourceUrl: "https://valdemarsro.dk/safe",
      canonicalUrl: "https://valdemarsro.dk/safe",
    });
  });

  test("rejects present but empty required source evidence instead of falling back", () => {
    const html = `<link rel="canonical" href="/otherwise-safe">
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Invalid source</h1>
        <a itemprop="mainEntityOfPage" href="   "></a>
      </div>`;
    expect(() => extractValdemarsroMicrodata(html, fixtureUrl))
      .toThrow("Recipe source URL is invalid, unsafe, or cross-site");
  });

  test("rejects unsafe page provenance before parsing embedded recipe evidence", () => {
    const html = `<div itemscope itemtype="https://schema.org/Recipe">
      <h1 itemprop="name">Safe embedded recipe</h1>
      <a itemprop="mainEntityOfPage" href="https://www.valdemarsro.dk/safe"></a>
    </div>`;
    for (const pageUrl of [
      "ftp://www.valdemarsro.dk/page",
      "https://user:secret@www.valdemarsro.dk/page",
      "https://www.valdemarsro.dk/%ZZ",
      "https://evil.example/page",
    ]) {
      expect(() => extractValdemarsroMicrodata(html, new URL(pageUrl)))
        .toThrow("microdata adapter is only allowed for its configured built-in host");
    }
  });

  test("falls back from persistence-incompatible optional canonicals", () => {
    for (const canonical of [
      "   ",
      "https://www.valdemarsro.dk/%ZZ",
      "https://www.valdemarsro.dk/%",
      "https://www.valdemarsro.dk/%2",
      "ftp://www.valdemarsro.dk/unsafe",
      "https://user:secret@www.valdemarsro.dk/unsafe",
      `https://www.valdemarsro.dk/${"x".repeat(2_100)}`,
      "https://evil.example/stolen",
    ]) {
      const html = `<link rel="canonical" href="${canonical}">
        <div itemscope itemtype="https://schema.org/Recipe">
          <h1 itemprop="name">Safe</h1>
          <a itemprop="mainEntityOfPage" href="/safe-source"></a>
        </div>`;
      const result = extractValdemarsroMicrodata(html, fixtureUrl);
      expect(result.canonicalUrl).toBe("https://www.valdemarsro.dk/safe-source");
      expect(() => normalizeRecipeCanonicalUrl(result.canonicalUrl)).not.toThrow();
    }
  });

  test("bounds page-wide DOM, Recipe candidates, and candidate-owned properties", () => {
    const nestedCandidates = `${Array.from({ length: 2_000 }, () =>
      '<div itemscope itemtype="https://schema.org/Recipe">').join("")} ${"</div>".repeat(2_000)}`;
    expect(() => extractValdemarsroMicrodata(nestedCandidates, fixtureUrl))
      .toThrow("Valdemarsro microdata exceeds 100 Recipe candidates");

    const excessiveDom = `<div itemscope itemtype="https://schema.org/Recipe">
      <h1 itemprop="name">Large DOM</h1>
      ${"<span></span>".repeat(20_001)}
    </div>`;
    expect(() => extractValdemarsroMicrodata(excessiveDom, fixtureUrl))
      .toThrow("Valdemarsro microdata exceeds 20000 DOM nodes");

    const excessiveProperties = `<div itemscope itemtype="https://schema.org/Recipe">
      <h1 itemprop="name">Too many properties</h1>
      ${'<meta itemprop="unknown" content="x">'.repeat(1_101)}
    </div>`;
    expect(() => extractValdemarsroMicrodata(excessiveProperties, fixtureUrl))
      .toThrow("Valdemarsro Recipe candidate exceeds 1100 owned property matches");

    const excessivePropertyTokens = `<div itemscope itemtype="https://schema.org/Recipe">
      <h1 itemprop="name">Too many property tokens</h1>
      <meta itemprop="${Array.from({ length: 1_101 }, (_, index) => `unknown-${index}`).join(" ")}" content="x">
    </div>`;
    expect(() => extractValdemarsroMicrodata(excessivePropertyTokens, fixtureUrl))
      .toThrow("Valdemarsro Recipe candidate exceeds 1100 owned property matches");
  });

  test("recovers from an over-budget candidate and extracts a later candidate within budget", () => {
    const html = `<div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Too many properties</h1>
        ${'<meta itemprop="unknown" content="x">'.repeat(1_101)}
      </div>
      <div itemscope itemtype="https://schema.org/Recipe">
        <h1 itemprop="name">Later valid</h1>
        <a itemprop="mainEntityOfPage" href="/later-valid#fragment"></a>
      </div>`;
    expect(extractValdemarsroMicrodata(html, fixtureUrl)).toMatchObject({
      title: "Later valid",
      sourceUrl: "https://www.valdemarsro.dk/later-valid",
      canonicalUrl: "https://www.valdemarsro.dk/later-valid",
    });
  });

  test("indexes the nested 100-candidate amplification shape with bounded property work", () => {
    const html = `${'<div itemscope itemtype="https://schema.org/Recipe">'.repeat(100)}
      ${'<meta itemprop="unknown" content="x">'.repeat(19_700)}
      ${"</div>".repeat(100)}`;
    let traversal: {
      readonly domNodesVisited: number;
      readonly recipeCandidates: number;
      readonly propertyNodesVisited: number;
      readonly propertyTokensExamined: number;
      readonly propertyMatchesStored: number;
      readonly ancestorSearches: number;
    } | undefined;

    expect(() => extractValdemarsroMicrodata(html, fixtureUrl, {
      onTraversalComplete(stats) {
        traversal = stats;
      },
    })).toThrow("Valdemarsro Recipe candidate exceeds 1100 owned property matches");
    expect(traversal).toBeDefined();
    expect(traversal!.domNodesVisited).toBeLessThanOrEqual(20_000);
    expect(traversal!.recipeCandidates).toBe(100);
    expect(traversal!.propertyNodesVisited).toBe(19_700);
    expect(traversal!.propertyTokensExamined).toBe(1_101);
    expect(traversal!.propertyMatchesStored).toBe(1_100);
    expect(traversal!.ancestorSearches).toBe(0);
  });
});
