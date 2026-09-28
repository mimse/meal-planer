import { describe, expect, test } from "bun:test";
import { runSourceSync } from "../../src/application/source-sync";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository } from "../../src/infrastructure/recipe-repository";

function recipeHtml(title: string, path: string): string {
  return `<script type="application/ld+json">${JSON.stringify({
    "@type": "Recipe",
    name: title,
    url: path,
    recipeYield: "4 personer",
    totalTime: "PT20M",
    suitableForDiet: "https://schema.org/VegetarianDiet",
    recipeIngredient: ["1 ingredient"],
    recipeInstructions: ["Cook."],
  })}</script>`;
}

function discovery(sourceId: string, recipeUrls: string[], capped = false, warnings: string[] = []) {
  return {
    sourceId,
    routes: [`https://${sourceId}.example/robots.txt`, `https://${sourceId}.example/sitemap.xml`],
    recipeUrls,
    sampleRecipeUrls: recipeUrls.slice(0, 10),
    capped,
    cache: { misses: 2, refreshed: 0, revalidated: 0 },
    warnings,
  };
}

describe("runSourceSync", () => {
  test("keeps recipe attempt counters at zero when discovery alone fails", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "broken", name: "Broken", baseUrl: "https://broken.example/", adapter: "jsonld", enabled: true,
    });

    const report = await runSourceSync(database, { sourceId: "broken" }, {
      discover: async () => { throw new Error("sitemap unavailable"); },
    });

    expect(report.sources).toEqual([{
      sourceId: "broken",
      status: "failed",
      discovered: 0,
      attempted: 0,
      imported: 0,
      failed: 0,
      capped: false,
      cache: { misses: 0, refreshed: 0, revalidated: 0 },
      warnings: [],
      failures: [{ url: null, error: "sitemap unavailable" }],
    }]);
    expect(report.totals).toEqual({ sources: 1, discovered: 0, attempted: 0, imported: 0, failed: 0 });
    database.close();
  });

  test("aggregates recipe attempts independently from mixed discovery failures", async () => {
    const database = openDatabase(":memory:");
    const sources = createConfigurationRepositories(database).recipeSources;
    sources.upsert({ id: "good", name: "Good", baseUrl: "https://good.example/", adapter: "jsonld", enabled: true });
    sources.upsert({ id: "broken", name: "Broken", baseUrl: "https://broken.example/", adapter: "jsonld", enabled: true });

    const report = await runSourceSync(database, {}, {
      discover: async (source) => {
        if (source.id === "broken") throw new Error("discovery failed");
        return discovery("good", ["https://good.example/one"]);
      },
      resourceFetcher: {
        fetch: async (url) => ({
          resource: {
            body: recipeHtml("Good recipe", "/one"),
            url,
            mediaType: "text/html",
            status: 200 as const,
            etag: null,
            lastModified: null,
          },
          cacheStatus: "miss" as const,
        }),
      },
    });

    expect(report.sources.map(({ sourceId, status, attempted, imported, failed }) => ({
      sourceId, status, attempted, imported, failed,
    }))).toEqual([
      { sourceId: "broken", status: "failed", attempted: 0, imported: 0, failed: 0 },
      { sourceId: "good", status: "completed", attempted: 1, imported: 1, failed: 0 },
    ]);
    expect(report.sources[0]?.failures).toEqual([{ url: null, error: "discovery failed" }]);
    expect(report.totals).toEqual({ sources: 2, discovered: 1, attempted: 1, imported: 1, failed: 0 });
    database.close();
  });

  test("continues deterministically across recipe and discovery failures with an exact per-source limit", async () => {
    const database = openDatabase(":memory:");
    const sources = createConfigurationRepositories(database).recipeSources;
    for (const id of ["a", "b", "c"]) {
      sources.upsert({ id, name: id.toUpperCase(), baseUrl: `https://${id}.example/`, adapter: "jsonld", enabled: true });
    }
    sources.upsert({ id: "disabled", name: "Disabled", baseUrl: "https://disabled.example/", adapter: "jsonld", enabled: false });
    const fetched: string[] = [];
    const observedLimits: number[] = [];

    const report = await runSourceSync(database, { limit: 2 }, {
      discover: async (source, _fetcher, limits) => {
        observedLimits.push(limits.maxRecipeUrls!);
        if (source.id === "a") return discovery("a", [
          "https://a.example/one",
          "https://a.example/bad",
          "https://a.example/must-not-fetch",
        ], true, ["discovery capped"]);
        if (source.id === "b") throw new Error("sitemap unavailable");
        return discovery("c", ["https://c.example/one"]);
      },
      resourceFetcher: {
        fetch: async (url) => {
          fetched.push(url.href);
          if (url.pathname === "/bad") throw new Error("broken page");
          return {
            resource: {
              body: recipeHtml(url.hostname, url.pathname),
              url,
              mediaType: "text/html",
              status: 200 as const,
              etag: null,
              lastModified: null,
            },
            cacheStatus: "miss" as const,
          };
        },
      },
      now: () => "2026-09-28T12:00:00.000Z",
    });

    expect(observedLimits).toEqual([2, 2, 2]);
    expect(fetched).toEqual([
      "https://a.example/one",
      "https://a.example/bad",
      "https://c.example/one",
    ]);
    expect(report).toEqual({
      limitPerSource: 2,
      sources: [
        {
          sourceId: "a",
          status: "partial",
          discovered: 2,
          attempted: 2,
          imported: 1,
          failed: 1,
          capped: true,
          cache: { misses: 2, refreshed: 0, revalidated: 0 },
          warnings: ["discovery capped"],
          failures: [{ url: "https://a.example/bad", error: "broken page" }],
        },
        {
          sourceId: "b",
          status: "failed",
          discovered: 0,
          attempted: 0,
          imported: 0,
          failed: 0,
          capped: false,
          cache: { misses: 0, refreshed: 0, revalidated: 0 },
          warnings: [],
          failures: [{ url: null, error: "sitemap unavailable" }],
        },
        {
          sourceId: "c",
          status: "completed",
          discovered: 1,
          attempted: 1,
          imported: 1,
          failed: 0,
          capped: false,
          cache: { misses: 2, refreshed: 0, revalidated: 0 },
          warnings: [],
          failures: [],
        },
      ],
      totals: { sources: 3, discovered: 3, attempted: 3, imported: 2, failed: 1 },
    });
    expect(createRecipeRepository(database).list({ limit: 100 })).toHaveLength(2);
    database.close();
  });

  test("counts distinct persisted recipes when query aliases resolve to one canonical recipe", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "aliases", name: "Aliases", baseUrl: "https://aliases.example/", adapter: "jsonld", enabled: true,
    });

    const report = await runSourceSync(database, { sourceId: "aliases", limit: 2 }, {
      discover: async () => discovery("aliases", [
        "https://aliases.example/recipe?alias=one",
        "https://aliases.example/recipe?alias=two",
      ]),
      resourceFetcher: {
        fetch: async (url) => ({
          resource: {
            body: recipeHtml("Canonical", "/canonical"),
            url,
            mediaType: "text/html",
            status: 200 as const,
            etag: null,
            lastModified: null,
          },
          cacheStatus: "miss" as const,
        }),
      },
    });

    expect(report.sources[0]).toMatchObject({
      status: "completed",
      attempted: 2,
      imported: 1,
      failed: 0,
    });
    expect(report.totals).toEqual({ sources: 1, discovered: 2, attempted: 2, imported: 1, failed: 0 });
    expect(createRecipeRepository(database).list()).toHaveLength(1);
    database.close();
  });

  test("reports failed when every discovered recipe import fails", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "all-bad", name: "All bad", baseUrl: "https://all-bad.example/", adapter: "jsonld", enabled: true,
    });

    const report = await runSourceSync(database, { sourceId: "all-bad", limit: 2 }, {
      discover: async () => discovery("all-bad", [
        "https://all-bad.example/one",
        "https://all-bad.example/two",
      ]),
      resourceFetcher: { fetch: async () => { throw new Error("invalid recipe page"); } },
    });

    expect(report.sources[0]).toMatchObject({
      sourceId: "all-bad",
      status: "failed",
      attempted: 2,
      imported: 0,
      failed: 2,
    });
    expect(report.sources[0]?.failures).toHaveLength(2);
    expect(report.totals).toEqual({ sources: 1, discovered: 2, attempted: 2, imported: 0, failed: 2 });
    database.close();
  });

  test("never hands an out-of-path custom sitemap candidate to recipe import", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "custom", name: "Custom", baseUrl: "https://custom.example/recipes/", adapter: "jsonld", enabled: true,
    });
    const fetched: Array<{ url: string; kind: string }> = [];
    const report = await runSourceSync(database, { sourceId: "custom", limit: 5 }, {
      resourceFetcher: {
        fetch: async (url, kind) => {
          fetched.push({ url: url.href, kind });
          if (kind === "robots") return {
            resource: { body: "Sitemap: /sitemap.xml", url, mediaType: "text/plain", status: 200 as const, etag: null, lastModified: null },
            cacheStatus: "miss" as const,
          };
          if (kind === "sitemap") return {
            resource: {
              body: "<urlset><url><loc>https://custom.example/blog/outside</loc></url><url><loc>https://custom.example/recipes/inside</loc></url></urlset>",
              url,
              mediaType: "application/xml",
              status: 200 as const,
              etag: null,
              lastModified: null,
            },
            cacheStatus: "miss" as const,
          };
          return {
            resource: { body: recipeHtml("Inside", "/recipes/inside"), url, mediaType: "text/html", status: 200 as const, etag: null, lastModified: null },
            cacheStatus: "miss" as const,
          };
        },
      },
      now: () => "2026-09-28T12:00:00.000Z",
    });

    expect(fetched).toEqual([
      { url: "https://custom.example/robots.txt", kind: "robots" },
      { url: "https://custom.example/sitemap.xml", kind: "sitemap" },
      { url: "https://custom.example/recipes/inside", kind: "recipe" },
    ]);
    expect(report.sources[0]).toMatchObject({ status: "completed", attempted: 1, imported: 1, failed: 0 });
    expect(report.sources[0]?.warnings[0]).toContain("outside configured source path scope");
    database.close();
  });

  test("fails an explicit unknown or disabled source but skips disabled sources in all mode", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "off",
      name: "Off",
      baseUrl: "https://off.example/",
      adapter: "jsonld",
      enabled: false,
    });
    const never = { discover: async () => { throw new Error("must not discover"); } };

    await expect(runSourceSync(database, { sourceId: "missing" }, never))
      .rejects.toThrow("Recipe source does not exist: missing");
    await expect(runSourceSync(database, { sourceId: "off" }, never))
      .rejects.toThrow("Recipe source is disabled: off");
    expect(await runSourceSync(database, {}, never)).toEqual({
      limitPerSource: 50,
      sources: [],
      totals: { sources: 0, discovered: 0, attempted: 0, imported: 0, failed: 0 },
    });
    database.close();
  });
});
