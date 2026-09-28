import { describe, expect, test } from "bun:test";
import { runSourceTest } from "../../src/application/test-source";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";

function fetched(url: URL, body: string, mediaType: string) {
  return {
    resource: { body, url, mediaType, status: 200 as const, etag: null, lastModified: null },
    cacheStatus: "miss" as const,
  };
}

describe("runSourceTest", () => {
  test("probes discovery with stable output without mutating sources or recipes", async () => {
    const database = openDatabase(":memory:");
    const repositories = createConfigurationRepositories(database);
    repositories.recipeSources.upsert({
      id: "example",
      name: "Example",
      baseUrl: "https://recipes.example/",
      adapter: "auto",
      enabled: true,
    });
    const sourcesBefore = repositories.recipeSources.list();

    const report = await runSourceTest(database, "example", {
      discoveryFetcher: {
        fetch: async (url, kind) => kind === "robots"
          ? fetched(url, "Sitemap: /sitemap.xml", "text/plain")
          : fetched(url, "<urlset><url><loc>https://recipes.example/r</loc></url></urlset>", "application/xml"),
      },
    });

    expect(report).toEqual({
      sourceId: "example",
      discoveryRoutes: [
        "https://recipes.example/robots.txt",
        "https://recipes.example/sitemap.xml",
      ],
      count: 1,
      capped: false,
      sampleRecipeUrls: ["https://recipes.example/r"],
      cache: { misses: 2, refreshed: 0, revalidated: 0 },
      warnings: [],
    });
    expect(repositories.recipeSources.list()).toEqual(sourcesBefore);
    expect(database.query("SELECT COUNT(*) AS count FROM recipes").get()).toEqual({ count: 0 });
    database.close();
  });

  test("does not use built-in discovery metadata for a reused id on a custom base URL", async () => {
    const database = openDatabase(":memory:");
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "spisbedre",
      name: "Custom source reusing an id",
      baseUrl: "https://recipes.example/",
      adapter: "auto",
      enabled: true,
    });
    const requested: string[] = [];

    const report = await runSourceTest(database, "spisbedre", {
      discoveryFetcher: {
        fetch: async (url, kind) => {
          requested.push(url.href);
          if (kind === "robots") return fetched(url, "", "text/plain");
          if (url.pathname !== "/sitemap.xml") throw new Error(`unexpected request ${url.href}`);
          return fetched(url, "<urlset><url><loc>https://recipes.example/r</loc></url></urlset>", "application/xml");
        },
      },
    });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/sitemap.xml",
    ]);
    expect(report.sampleRecipeUrls).toEqual(["https://recipes.example/r"]);
    database.close();
  });
});
