import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { BUILT_IN_RECIPE_SOURCES } from "../../src/adapters/recipes/sources";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository } from "../../src/infrastructure/recipe-repository";
import { importRecipeUrl, parseRecipeRequestUrl } from "../../src/application/recipe-ingestion";
import { reviewRecipe } from "../../src/application/recipe-review";

function fetched(url: URL, body: string, cacheStatus: "miss" | "refreshed" = "miss") {
  return {
    resource: {
      body,
      url,
      mediaType: "text/html",
      status: 200 as const,
      etag: null,
      lastModified: null,
    },
    cacheStatus,
  };
}

const html = (title: string) => `<script type="application/ld+json">${JSON.stringify({
  "@type": "Recipe",
  name: title,
  url: "/recipes/soup",
  recipeYield: "4 personer",
  totalTime: "PT30M",
  suitableForDiet: "https://schema.org/VegetarianDiet",
  recipeIngredient: ["2 dåser tomater"],
  recipeInstructions: ["Kog suppen."],
})}</script>`;

describe("importRecipeUrl", () => {
  test("resolves one enabled configured host, safely fetches, persists, and atomically reimports", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example",
      name: "Example",
      baseUrl: "https://recipes.example/recipes/",
      adapter: "jsonld",
      enabled: true,
    });
    const requested: Array<{ url: string; kind: string; scope: string | undefined }> = [];
    let title = "Soup";
    let cacheStatus: "miss" | "refreshed" = "miss";
    const resourceFetcher = {
      fetch: async (url: URL, kind: "robots" | "sitemap" | "recipe", scope?: URL) => {
        requested.push({ url: url.href, kind, scope: scope?.href });
        return fetched(url, html(title), cacheStatus);
      },
    };

    const first = await importRecipeUrl(database, { url: "https://recipes.example/recipes/soup" }, {
      resourceFetcher,
      now: () => "2026-09-28T12:00:00.000Z",
    });
    title = "Soup updated";
    cacheStatus = "refreshed";
    const second = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup",
      sourceId: "example",
    }, {
      resourceFetcher,
      now: () => "2026-09-28T13:00:00.000Z",
    });

    expect(requested).toEqual([
      { url: "https://recipes.example/recipes/soup", kind: "recipe", scope: "https://recipes.example/recipes/" },
      { url: "https://recipes.example/recipes/soup", kind: "recipe", scope: "https://recipes.example/recipes/" },
    ]);
    expect(second.recipe.id).toBe(first.recipe.id);
    expect(second.recipe.title).toBe("Soup updated");
    expect(second.recipe.fetchedAt).toBe("2026-09-28T13:00:00.000Z");
    expect(second.cacheStatus).toBe("refreshed");
    expect(createRecipeRepository(database).list()).toEqual([second.recipe]);
    database.close();
  });

  test("source reimport refreshes source fields while preserving every reviewed planner field", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    let body = html("Soup");
    const resourceFetcher = { fetch: async (url: URL) => fetched(url, body) };
    const initial = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher, now: () => "2026-09-28T12:00:00.000Z" });
    const reviewed = reviewRecipe(database, initial.recipe.id, {
      servings: 7,
      prepMinutes: 11,
      cookMinutes: 22,
      totalMinutes: 33,
      cuisineTags: ["Danish"],
      proteinTag: "pork",
      dietaryTags: ["gluten-free"],
      suitabilityTags: ["quick", "reheatFriendly"],
      preference: "favorite",
      markReviewed: true,
    });
    const repository = createRecipeRepository(database);
    const { id: _id, normalizedTitle: _normalizedTitle, ...reviewedInput } = reviewed;
    repository.import({ ...reviewedInput, extraMealServings: 3 });
    body = `<link rel="canonical" href="/recipes/new-canonical">${html("Soup refreshed")}`
      .replace("Kog suppen.", "Kog den nye suppe.");

    const refreshed = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher, now: () => "2026-09-28T13:00:00.000Z" });

    expect(refreshed.recipe).toMatchObject({
      id: initial.recipe.id,
      title: "Soup refreshed",
      canonicalUrl: "https://recipes.example/recipes/new-canonical",
      servings: 7,
      prepMinutes: 11,
      cookMinutes: 22,
      totalMinutes: 33,
      cuisineTags: ["danish"],
      proteinTag: "pork",
      dietaryTags: ["gluten-free"],
      suitabilityTags: ["quick", "reheatFriendly"],
      extraMealServings: 0,
      preference: "favorite",
      needsReview: false,
      fetchedAt: "2026-09-28T13:00:00.000Z",
      instructions: ["Kog den nye suppe."],
      sourceEvidence: expect.objectContaining({
        reviewOverrides: [
          "servings", "prepMinutes", "cookMinutes", "totalMinutes", "cuisineTags", "proteinTag",
          "dietaryTags", "suitabilityTags", "preference", "needsReview",
        ],
      }),
    });
    database.close();
  });

  test("first source refresh updates unreviewed extraction defaults", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    let body = html("Soup").replace(
      ',"suitableForDiet":"https://schema.org/VegetarianDiet"',
      "",
    );
    const resourceFetcher = { fetch: async (url: URL) => fetched(url, body) };
    const initial = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });
    expect(initial.recipe.needsReview).toBe(true);
    body = html("Soup refreshed")
      .replace('"recipeYield":"4 personer"', '"recipeYield":"6 personer"')
      .replace('"totalTime":"PT30M"', '"totalTime":"PT45M"')
      .replace("https://schema.org/VegetarianDiet", "https://schema.org/VeganDiet");

    const refreshed = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });

    expect(refreshed.recipe).toMatchObject({
      id: initial.recipe.id,
      title: "Soup refreshed",
      servings: 6,
      totalMinutes: 45,
      dietaryTags: ["vegan"],
      needsReview: false,
      sourceEvidence: expect.not.objectContaining({ reviewOverrides: expect.anything() }),
    });
    database.close();
  });

  test("keeps a partial manual review pending after complete refreshed evidence", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    let body = html("Soup").replace(
      ',"suitableForDiet":"https://schema.org/VegetarianDiet"',
      "",
    );
    const resourceFetcher = { fetch: async (url: URL) => fetched(url, body) };
    const initial = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });
    expect(initial.recipe.needsReview).toBe(true);
    expect(reviewRecipe(database, initial.recipe.id, { preference: "favorite" }).needsReview).toBe(true);
    body = html("Soup refreshed");

    const refreshed = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });

    expect(refreshed.recipe.needsReview).toBe(true);
    expect(refreshed.recipe.sourceEvidence).toEqual(expect.objectContaining({
      reviewOverrides: ["preference", "needsReview"],
    }));
    database.close();
  });

  test("keeps a marked-reviewed recipe complete after complete refreshed evidence", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    let body = html("Soup");
    const resourceFetcher = { fetch: async (url: URL) => fetched(url, body) };
    const initial = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });
    expect(reviewRecipe(database, initial.recipe.id, { markReviewed: true }).needsReview).toBe(false);
    body = html("Soup refreshed");

    const refreshed = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });

    expect(refreshed.recipe.needsReview).toBe(false);
    expect(refreshed.recipe.sourceEvidence).toEqual(expect.objectContaining({
      reviewOverrides: ["needsReview"],
    }));
    database.close();
  });

  test("reopens a marked-reviewed recipe when refreshed ingredients disappear", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    let body = html("Soup");
    const resourceFetcher = { fetch: async (url: URL) => fetched(url, body) };
    const initial = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });
    expect(reviewRecipe(database, initial.recipe.id, { markReviewed: true }).needsReview).toBe(false);
    body = html("Soup").replace('"recipeIngredient":["2 dåser tomater"],', '"recipeIngredient":[],');

    const refreshed = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });
    expect(refreshed.recipe.ingredients).toEqual([]);
    expect(refreshed.recipe.needsReview).toBe(true);

    const stillPending = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup", sourceId: "example",
    }, { resourceFetcher });
    expect(stillPending.recipe.needsReview).toBe(true);
    database.close();
  });

  test("imports extraction-valid long and NFKC-expanding raw ingredients without invented normalized names", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    const ordinary = `1 ${"a".repeat(350)}`;
    const expanding = "ﷺ".repeat(40);
    const body = `<script type="application/ld+json">${JSON.stringify({
      "@type": "Recipe",
      name: "Long ingredients",
      url: "/recipes/long",
      recipeYield: "4 personer",
      totalTime: "PT30M",
      suitableForDiet: "https://schema.org/VegetarianDiet",
      recipeIngredient: [ordinary, expanding],
      recipeInstructions: ["Cook."],
    })}</script>`;

    const imported = await importRecipeUrl(database, {
      url: "https://recipes.example/recipes/long", sourceId: "example",
    }, { resourceFetcher: { fetch: async (url) => fetched(url, body) } });

    expect(imported.recipe.ingredients).toEqual([
      { rawText: ordinary, normalizedName: null, quantity: null, unit: null, uncertain: true },
      { rawText: expanding, normalizedName: null, quantity: null, unit: null, uncertain: true },
    ]);
    database.close();
  });

  test("rejects malformed percent escapes at every ingestion URL boundary without persistence", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true,
    });
    let fetches = 0;
    const never = { fetch: async () => { fetches += 1; throw new Error("must not fetch"); } };
    for (const suffix of ["%zz", "%", "%2"]) {
      await expect(importRecipeUrl(database, { url: `https://recipes.example/recipes/${suffix}` }, { resourceFetcher: never }))
        .rejects.toThrow("malformed percent escape");
      await expect(importRecipeUrl(database, {
        url: `https://recipes.example/recipes/${suffix}`, sourceId: "example",
      }, { resourceFetcher: never })).rejects.toThrow("malformed percent escape");
    }
    expect(fetches).toBe(0);

    for (const suffix of ["%zz", "%", "%2"]) {
      await expect(importRecipeUrl(database, {
        url: "https://recipes.example/recipes/soup", sourceId: "example",
      }, {
        resourceFetcher: {
          fetch: async () => fetched(new URL(`https://recipes.example/recipes/${suffix}`), html("Malformed final")),
        },
      })).rejects.toThrow("malformed percent escape");
    }
    expect(createRecipeRepository(database).list()).toEqual([]);
    database.close();
  });

  test("rejects lossy raw request paths before fetch while accepting encoded Unicode", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "custom", name: "Custom", baseUrl: "https://custom.example/recipes/", adapter: "jsonld", enabled: true,
    });
    const requested: string[] = [];
    const resourceFetcher = {
      fetch: async (url: URL) => {
        requested.push(url.href);
        return fetched(url, html("Unicode soup"));
      },
    };

    for (const url of [
      "https://custom.example/recipes/a/%2e%2e/safe",
      "https://custom.example/recipes\\safe",
      "https://custom.example/recipes/%2foutside",
      "https://custom.example/recipes/%5coutside",
      "https://custom.example/recipes/%252e%252e/outside",
    ]) {
      expect(() => parseRecipeRequestUrl(url)).toThrow(/unsafe|traversal/u);
      await expect(importRecipeUrl(database, { url, sourceId: "custom" }, { resourceFetcher }))
        .rejects.toThrow(/unsafe|traversal/u);
    }
    expect(requested).toEqual([]);

    const imported = await importRecipeUrl(database, {
      url: "https://custom.example/recipes/caf%C3%A9", sourceId: "custom",
    }, { resourceFetcher });
    expect(requested).toEqual(["https://custom.example/recipes/caf%C3%A9"]);
    expect(imported.recipe.title).toBe("Unicode soup");
    database.close();
  });

  test("rejects unknown, disabled, ambiguous, out-of-path, and final redirect sources before persistence", async () => {
    const database = openDatabase(":memory:");
    const sources = createConfigurationRepositories(database).recipeSources;
    sources.upsert({ id: "one", name: "One", baseUrl: "https://recipes.example/recipes/", adapter: "jsonld", enabled: true });
    sources.upsert({ id: "two", name: "Two", baseUrl: "https://recipes.example/other/", adapter: "jsonld", enabled: true });
    sources.upsert({ id: "off", name: "Off", baseUrl: "https://off.example/", adapter: "jsonld", enabled: false });
    const never = { fetch: async () => { throw new Error("must not fetch"); } };

    await expect(importRecipeUrl(database, { url: "https://unknown.example/recipe" }, { resourceFetcher: never }))
      .rejects.toThrow("No enabled recipe source matches host: unknown.example");
    await expect(importRecipeUrl(database, { url: "https://off.example/recipe", sourceId: "off" }, { resourceFetcher: never }))
      .rejects.toThrow("Recipe source is disabled: off");
    await expect(importRecipeUrl(database, { url: "https://recipes.example/recipes/soup" }, { resourceFetcher: never }))
      .rejects.toThrow("Ambiguous enabled recipe sources for host recipes.example: one, two");
    await expect(importRecipeUrl(database, { url: "https://recipes.example/outside", sourceId: "one" }, { resourceFetcher: never }))
      .rejects.toThrow("outside configured source path");

    await expect(importRecipeUrl(database, {
      url: "https://recipes.example/recipes/soup",
      sourceId: "one",
    }, {
      resourceFetcher: {
        fetch: async () => fetched(new URL("https://recipes.example/outside"), html("Outside")),
      },
    })).rejects.toThrow("outside configured source path");
    expect(createRecipeRepository(database).list()).toEqual([]);
    database.close();
  });

  test("uses origin scope for an exact built-in while transport still blocks custom paths before request", async () => {
    const database = openDatabase(":memory:");
    const sources = createConfigurationRepositories(database).recipeSources;
    const julieBruun = BUILT_IN_RECIPE_SOURCES.find(({ id }) => id === "juliebruun")!;
    sources.upsert({
      id: julieBruun.id,
      name: julieBruun.name,
      baseUrl: julieBruun.baseUrl,
      adapter: julieBruun.extraction,
      enabled: true,
    });
    sources.upsert({
      id: "custom",
      name: "Custom",
      baseUrl: "https://custom.example/recipes/",
      adapter: "jsonld",
      enabled: true,
    });
    const requested: string[] = [];
    const fixture = readFileSync(resolve(import.meta.dir, "../fixtures/recipes/juliebruun.html"), "utf8");
    const fetchDependencies = {
      allowTestTransport: true,
      resolveHostname: async () => ["93.184.216.34"],
      fetchImpl: async (url: URL) => {
        requested.push(url.href);
        if (url.hostname === "juliebruun.com") {
          return new Response(fixture, { headers: { "content-type": "text/html" } });
        }
        if (url.pathname === "/recipes/start") {
          return new Response(null, { status: 302, headers: { location: "/outside" } });
        }
        throw new Error(`Unexpected transport request: ${url.href}`);
      },
    };

    const imported = await importRecipeUrl(database, {
      url: "https://juliebruun.com/flaeskesteg-i-airfryer/",
      sourceId: "juliebruun",
    }, { fetchDependencies, minimumSpacingMs: 0 });
    expect(imported.recipe.sourceId).toBe("juliebruun");
    expect(imported.recipe.ingredients.length).toBeGreaterThan(0);

    await expect(importRecipeUrl(database, {
      url: "https://custom.example/outside",
      sourceId: "custom",
    }, { fetchDependencies, minimumSpacingMs: 0 })).rejects.toThrow("outside configured source path");
    await expect(importRecipeUrl(database, {
      url: "https://custom.example/recipes/start",
      sourceId: "custom",
    }, { fetchDependencies, minimumSpacingMs: 0 })).rejects.toThrow("outside configured source path scope");
    expect(requested).toEqual([
      "https://juliebruun.com/flaeskesteg-i-airfryer/",
      "https://custom.example/recipes/start",
    ]);
    database.close();
  });

  test("imports all six built-in fixture routes through configured source identities", async () => {
    const database = openDatabase(":memory:");
    const sources = createConfigurationRepositories(database).recipeSources;
    const fixtureDirectory = resolve(import.meta.dir, "../fixtures/recipes");
    const urls: Record<string, string> = {
      valdemarsro: "https://www.valdemarsro.dk/kage-med-rabarber/",
      gourministeriet: "https://gourministeriet.dk/frikadeller-med-perlebygsalat-broccoli-og-feta/",
      spisbedre: "https://spisbedre.dk/opskrifter/3-slags-pindemadder",
      juliebruun: "https://juliebruun.com/flaeskesteg-i-airfryer/",
      juliekarla: "https://www.juliekarla.dk/opskrift-bladbeder-figner-pinjekerner/",
      mummum: "https://mummum.dk/opskrift-paa-nemme-croutoner/",
    };
    for (const source of BUILT_IN_RECIPE_SOURCES) {
      sources.upsert({
        id: source.id,
        name: source.name,
        baseUrl: source.baseUrl,
        adapter: source.extraction,
        enabled: true,
      });
    }

    for (const source of BUILT_IN_RECIPE_SOURCES) {
      const url = urls[source.id]!;
      const result = await importRecipeUrl(database, { url, sourceId: source.id }, {
        resourceFetcher: {
          fetch: async (requestUrl) => fetched(
            requestUrl,
            readFileSync(resolve(fixtureDirectory, `${source.id}.html`), "utf8"),
          ),
        },
        now: () => "2026-09-28T12:00:00.000Z",
      });
      expect(result.recipe.sourceId).toBe(source.id);
      expect(result.recipe.sourceUrl).toBe(url);
      expect(result.recipe.ingredients.length).toBeGreaterThan(0);
      expect(result.recipe.needsReview).toBe(true);
    }
    expect(createRecipeRepository(database).list({ limit: 100 })).toHaveLength(6);
    database.close();
  });
});
