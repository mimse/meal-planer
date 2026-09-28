import { describe, expect, test } from "bun:test";
import { extractRecipeJsonLd } from "../../src/adapters/recipes/jsonld";

const pageUrl = new URL("https://example.dk/opskrifter/tomatpasta");

const recipePage = `<!doctype html>
<html>
  <head>
    <link rel="canonical" href="https://example.dk/opskrifter/tomatpasta/" />
    <script type="application/ld+json">
      {
        "@context": "https://schema.org",
        "@graph": [
          {"@type": "BreadcrumbList", "itemListElement": []},
          {
            "@type": ["Recipe", "NewsArticle"],
            "name": "Tomatpasta",
            "recipeYield": "4 personer",
            "prepTime": "PT15M",
            "cookTime": "PT25M",
            "totalTime": "PT40M",
            "recipeIngredient": ["400 g pasta", "2 dåser tomater"],
            "recipeInstructions": [
              {"@type": "HowToStep", "text": "Kog pastaen."},
              "Bland saucen i."
            ],
            "suitableForDiet": "https://schema.org/VegetarianDiet",
            "url": "/opskrifter/tomatpasta/",
            "author": {"@type": "Person", "name": "Eksempel Kok"}
          }
        ]
      }
    </script>
  </head>
</html>`;

describe("extractRecipeJsonLd", () => {
  test("extracts a Recipe nested in an @graph and preserves source evidence", () => {
    const recipe = extractRecipeJsonLd(recipePage, pageUrl);

    expect(recipe).toEqual({
      title: "Tomatpasta",
      sourceUrl: "https://example.dk/opskrifter/tomatpasta/",
      canonicalUrl: "https://example.dk/opskrifter/tomatpasta/",
      author: "Eksempel Kok",
      servings: 4,
      prepMinutes: 15,
      cookMinutes: 25,
      totalMinutes: 40,
      rawIngredients: ["400 g pasta", "2 dåser tomater"],
      instructions: ["Kog pastaen.", "Bland saucen i."],
      dietaryTags: ["vegetarian"],
      raw: expect.any(Object),
    });
  });

  test("skips Recipe candidates that do not have a non-empty name", () => {
    const html = `
      <script type="application/ld+json">
        [
          {"@type":"Recipe","name":"  "},
          {"@type":"Recipe","name":"Valid recipe"}
        ]
      </script>`;

    expect(extractRecipeJsonLd(html, pageUrl).title).toBe("Valid recipe");
  });

  test("skips a named Recipe with a malformed URL and extracts the next candidate", () => {
    const html = `
      <script type="application/ld+json">
        [
          {"@type":"Recipe","name":"Broken recipe","url":"http://["},
          {"@type":"Recipe","name":"Valid recipe","url":"/valid-recipe"}
        ]
      </script>`;

    expect(extractRecipeJsonLd(html, pageUrl)).toMatchObject({
      title: "Valid recipe",
      sourceUrl: "https://example.dk/valid-recipe",
    });
  });

  test("ignores a malformed optional canonical URL", () => {
    const html = `
      <link rel="canonical" href="http://[">
      <script type="application/ld+json">
        {"@type":"Recipe","name":"Valid recipe","url":"/valid"}
      </script>`;

    expect(extractRecipeJsonLd(html, pageUrl)).toMatchObject({
      title: "Valid recipe",
      sourceUrl: "https://example.dk/valid",
      canonicalUrl: "https://example.dk/valid",
    });
  });

  test("ignores syntactically valid but disallowed optional canonical URLs", () => {
    for (const canonical of [
      "ftp://example.dk/recipe",
      "https://user:secret@example.dk/recipe",
      `https://example.dk/${"x".repeat(2_100)}`,
    ]) {
      const html = `<link rel="canonical" href="${canonical}">
        <script type="application/ld+json">{
          "@type":"Recipe","name":"Valid recipe","url":"/valid"
        }</script>`;
      expect(extractRecipeJsonLd(html, pageUrl)).toMatchObject({
        title: "Valid recipe",
        sourceUrl: "https://example.dk/valid",
        canonicalUrl: "https://example.dk/valid",
      });
    }
  });

  test("extracts instructions from a single HowToSection object", () => {
    const html = `
      <script type="application/ld+json">
        {
          "@type":"Recipe",
          "name":"Soup",
          "recipeInstructions": {
            "@type":"HowToSection",
            "itemListElement":[
              {"@type":"HowToStep","text":"Chop vegetables."},
              {"@type":"HowToStep","text":"Simmer."}
            ]
          }
        }
      </script>`;

    expect(extractRecipeJsonLd(html, pageUrl).instructions).toEqual([
      "Chop vegetables.",
      "Simmer.",
    ]);
  });

  test("returns null for ISO duration markers without duration components", () => {
    const html = `
      <script type="application/ld+json">
        {"@type":"Recipe","name":"Soup","prepTime":"P","cookTime":"PT","totalTime":"P1DT"}
      </script>`;

    expect(extractRecipeJsonLd(html, pageUrl)).toMatchObject({
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: null,
    });
  });

  test("returns null for non-positive and overflowing recipe yields", () => {
    const yields = [0, -2, "0 servings", "-4 portions", "1e309 servings"];

    for (const recipeYield of yields) {
      const html = `<script type="application/ld+json">${JSON.stringify({
        "@type": "Recipe",
        name: "Soup",
        recipeYield,
      })}</script>`;
      expect(extractRecipeJsonLd(html, pageUrl).servings).toBeNull();
    }
  });

  test("accepts zero durations but returns null for negative and overflowing durations", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Soup",
      prepTime: "P0D",
      cookTime: "PT-1M",
      totalTime: `P${"9".repeat(400)}D`,
    })}</script>`;

    expect(extractRecipeJsonLd(html, pageUrl)).toMatchObject({
      prepMinutes: 0,
      cookMinutes: null,
      totalMinutes: null,
    });
  });

  test("accepts bounded ISO durations and returns null above the persistence limit", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Soup",
      prepTime: "P365D",
      totalTime: "P366D",
    })}</script>`;

    expect(extractRecipeJsonLd(html, pageUrl)).toMatchObject({
      prepMinutes: 525_600,
      totalMinutes: null,
    });
  });

  test("skips candidates rejected by the shared output boundary", () => {
    const unsafe = '{"@type":"Recipe","name":"Unsafe","__proto__":{"polluted":true}}';
    const valid = '{"@type":"Recipe","name":"Safe"}';
    const html = `<script type="application/ld+json">[${unsafe},${valid}]</script>`;

    expect(extractRecipeJsonLd(html, pageUrl).title).toBe("Safe");
  });

  test("rejects a near-1.8MB wide block before choosing a later valid block", () => {
    const wide = `[{"@type":"Recipe","name":"Adversarial"},${"0,".repeat(899_000)}0]`;
    const html = `<script type="application/ld+json">${wide}</script>
      <script type="application/ld+json">{"@type":"Recipe","name":"Later valid"}</script>`;

    expect(Buffer.byteLength(wide, "utf8")).toBeGreaterThan(1_790_000);
    expect(extractRecipeJsonLd(html, pageUrl).title).toBe("Later valid");
  });

  test("rejects an over-depth block without recursion and chooses a later valid block", () => {
    let deep = '{"@type":"Recipe","name":"Too deep"}';
    for (let index = 0; index < 100; index += 1) deep = `{"@graph":${deep}}`;
    const html = `<script type="application/ld+json">${deep}</script>
      <script type="application/ld+json">{"@type":"Recipe","name":"Later valid"}</script>`;

    expect(extractRecipeJsonLd(html, pageUrl).title).toBe("Later valid");
  });

  test("continues after malformed JSON and extracts a later valid block", () => {
    const html = `<script type="application/ld+json">{"@type":"Recipe",</script>
      <script type="application/ld+json">{"@type":"Recipe","name":"Later valid"}</script>`;

    expect(extractRecipeJsonLd(html, pageUrl).title).toBe("Later valid");
  });

  test("reports a precise bounded failure when page-wide JSON-LD work is exhausted", () => {
    const block = JSON.stringify({ padding: "x".repeat(110_000) });
    const html = Array.from({ length: 6 }, () =>
      `<script type="application/ld+json">${block}</script>`).join("");

    expect(() => extractRecipeJsonLd(html, pageUrl))
      .toThrow("Schema.org JSON-LD exceeds page-wide resource limits");
  });
});
