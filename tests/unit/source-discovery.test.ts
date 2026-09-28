import { describe, expect, test } from "bun:test";
import { discoverRecipeUrls, parseSitemapXml } from "../../src/application/source-discovery";

function resource(url: string, body: string, mediaType: string) {
  return {
    resource: {
      body,
      url: new URL(url),
      mediaType,
      status: 200 as const,
      etag: null,
      lastModified: null,
    },
    cacheStatus: "miss" as const,
  };
}

describe("parseSitemapXml", () => {
  test("accepts only exact sitemap-namespace location chains", () => {
    const parsed = parseSitemapXml([
      '<sm:urlset xmlns:sm="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      "<image:url><image:loc>https://recipes.example/media/root.jpg</image:loc></image:url>",
      "<sm:sitemap><sm:loc>https://recipes.example/wrong-parent.xml</sm:loc></sm:sitemap>",
      "<sm:wrapper><sm:url><sm:loc>https://recipes.example/recipe/nested</sm:loc></sm:url></sm:wrapper>",
      "<sm:url><sm:loc><sm:lastmod>https://recipes.example/recipe/not-text</sm:lastmod></sm:loc></sm:url>",
      "<sm:url><image:loc>https://recipes.example/media/direct.jpg</image:loc>",
      "<sm:loc>https://recipes.example/recipe/good</sm:loc></sm:url>",
      "</sm:urlset>",
    ].join(""));

    expect(parsed).toEqual({
      kind: "urlset",
      locations: ["https://recipes.example/recipe/good"],
    });
    expect(() => parseSitemapXml([
      '<image:urlset xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">',
      "<image:url><image:loc>https://recipes.example/media.jpg</image:loc></image:url>",
      "</image:urlset>",
    ].join(""))).toThrow("root must use the standard sitemap namespace");
  });

  test("rejects an unescaped named entity in loc text", () => {
    expect(() => parseSitemapXml(
      "<urlset><url><loc>https://recipes.example/recipe/a?x=&bogus</loc></url></urlset>",
    )).toThrow("Sitemap XML");
  });

  test("rejects malformed attributes on sitemap elements", () => {
    expect(() => parseSitemapXml(
      "<urlset><url broken><loc>https://recipes.example/recipe/a</loc></url></urlset>",
    )).toThrow("Sitemap XML");
  });

  test("rejects CDATA outside the document element", () => {
    expect(() => parseSitemapXml(
      "<![CDATA[outside]]><urlset></urlset>",
    )).toThrow("Sitemap XML");
  });

  test("rejects forbidden XML character references", () => {
    expect(() => parseSitemapXml(
      "<urlset><url><loc>https://recipes.example/recipe/&#0;</loc></url></urlset>",
    )).toThrow("Sitemap XML");
  });

  test("rejects undeclared prefixes despite xmlns-like attribute text", () => {
    expect(() => parseSitemapXml([
      "<sm:urlset note=\"ordinary text xmlns:sm='http://www.sitemaps.org/schemas/sitemap/0.9'\">",
      "<sm:url><sm:loc>https://recipes.example/recipe/spoofed</sm:loc></sm:url>",
      "</sm:urlset>",
    ].join(""))).toThrow("Sitemap XML");
  });
});

describe("discoverRecipeUrls", () => {
  test("uses only robots Sitemap directives and follows a sitemap index", async () => {
    const requested: string[] = [];
    const responses = new Map([
      ["https://recipes.example/robots.txt", resource(
        "https://recipes.example/robots.txt",
        "User-agent: *\nDisallow: /private\nSitemap: https://recipes.example/index.xml\n",
        "text/plain",
      )],
      ["https://recipes.example/index.xml", resource(
        "https://recipes.example/index.xml",
        "<sitemapindex><sitemap><loc>https://recipes.example/posts.xml</loc></sitemap></sitemapindex>",
        "application/xml",
      )],
      ["https://recipes.example/posts.xml", resource(
        "https://recipes.example/posts.xml",
        "<urlset><url><loc>https://recipes.example/recipe/a</loc></url></urlset>",
        "application/xml",
      )],
    ]);

    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url) => {
        requested.push(url.href);
        const response = responses.get(url.href);
        if (!response) throw new Error(`unexpected request ${url.href}`);
        return response;
      },
    });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/index.xml",
      "https://recipes.example/posts.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/a"]);
    expect(result.routes).toEqual(requested);
    expect(result.capped).toBe(false);
  });

  test("aggregates recipes from every robots-advertised sitemap", async () => {
    const requested: string[] = [];
    const responses = new Map([
      ["https://recipes.example/first.xml", "<urlset><url><loc>https://recipes.example/recipe/first</loc></url></urlset>"],
      ["https://recipes.example/second.xml", "<urlset><url><loc>https://recipes.example/recipe/second</loc></url></urlset>"],
    ]);

    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/configured.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") {
          return resource(url.href, "Sitemap: /first.xml\nSitemap: /second.xml\n", "text/plain");
        }
        const body = responses.get(url.href);
        if (body === undefined) throw new Error(`fallback must not be fetched: ${url.href}`);
        return resource(url.href, body, "application/xml");
      },
    });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/first.xml",
      "https://recipes.example/second.xml",
    ]);
    expect(result.recipeUrls).toEqual([
      "https://recipes.example/recipe/first",
      "https://recipes.example/recipe/second",
    ]);
    expect(result.capped).toBe(false);
  });

  test("caps when a later robots-advertised sitemap contains an omitted unique recipe", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") {
          return resource(url.href, "Sitemap: /first.xml\nSitemap: /second.xml\n", "text/plain");
        }
        const recipe = url.pathname === "/first.xml" ? "first" : "omitted";
        return resource(
          url.href,
          `<urlset><url><loc>https://recipes.example/recipe/${recipe}</loc></url></urlset>`,
          "application/xml",
        );
      },
    }, { maxRecipeUrls: 1 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/first.xml",
      "https://recipes.example/second.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/first"]);
    expect(result.capped).toBe(true);
  });

  test("does not cap when a later robots-advertised sitemap adds only duplicate or invalid recipes", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") {
          return resource(url.href, "Sitemap: /first.xml\nSitemap: /second.xml\n", "text/plain");
        }
        const body = url.pathname === "/first.xml"
          ? "<urlset><url><loc>https://recipes.example/recipe/only</loc></url></urlset>"
          : [
            "<urlset>",
            "<url><loc>https://www.recipes.example/recipe/only#duplicate</loc></url>",
            "<url><loc>http://[invalid</loc></url>",
            "<url><loc>https://evil.example/recipe/out-of-scope</loc></url>",
            "</urlset>",
          ].join("");
        return resource(url.href, body, "application/xml");
      },
    }, { maxRecipeUrls: 1 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/first.xml",
      "https://recipes.example/second.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/only"]);
    expect(result.capped).toBe(false);
    expect(result.warnings).toEqual([
      "https://recipes.example/second.xml: Recipe URL is not a valid URL",
      "https://recipes.example/second.xml: Recipe URL is outside configured source host scope",
    ]);
  });

  test("does not cap when locations beyond the result count add no unique valid recipe", async () => {
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/feed.xml",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "", "text/plain")
        : resource(url.href, [
          "<urlset>",
          "<url><loc>https://recipes.example/recipe/only</loc></url>",
          "<url><loc>https://www.recipes.example/recipe/only#duplicate</loc></url>",
          "<url><loc> </loc></url>",
          "<url><loc>https://evil.example/recipe/out-of-scope</loc></url>",
          "</urlset>",
        ].join(""), "application/xml"),
    }, { maxRecipeUrls: 1 });

    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/only"]);
    expect(result.capped).toBe(false);
    expect(result.warnings).toEqual([
      "https://recipes.example/feed.xml: Sitemap loc must be a non-empty bounded URL",
      "https://recipes.example/feed.xml: Recipe URL is outside configured source host scope",
    ]);
  });

  test("caps only when an additional unique valid recipe is omitted", async () => {
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/feed.xml",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "", "text/plain")
        : resource(url.href, [
          "<urlset>",
          "<url><loc>https://recipes.example/recipe/first</loc></url>",
          "<url><loc>https://www.recipes.example/recipe/first#duplicate</loc></url>",
          "<url><loc>http://[invalid</loc></url>",
          "<url><loc>https://evil.example/recipe/out-of-scope</loc></url>",
          "<url><loc>https://recipes.example/recipe/omitted</loc></url>",
          "</urlset>",
        ].join(""), "application/xml"),
    }, { maxRecipeUrls: 1 });

    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/first"]);
    expect(result.capped).toBe(true);
    expect(result.warnings).toEqual([
      "https://recipes.example/feed.xml: Recipe URL is not a valid URL",
      "https://recipes.example/feed.xml: Recipe URL is outside configured source host scope",
    ]);
  });

  test("keeps only direct url children, canonicalizes, and deduplicates results", async () => {
    const sitemap = [
      "<urlset xmlns:image=\"urn:image\">",
      "<url><loc>https://www.recipes.example/recipe/a#step</loc>",
      "<image:image><image:loc>https://recipes.example/media/photo.jpg</image:loc></image:image></url>",
      "<url><loc>https://recipes.example/recipe/a</loc></url>",
      "<url><loc>https://recipes.example/recipe/b</loc></url>",
      "</urlset>",
    ].join("");
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/feed.xml",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "", "text/plain")
        : resource(url.href, sitemap, "application/xml"),
    }, { maxRecipeUrls: 2 });

    expect(result.recipeUrls).toEqual([
      "https://www.recipes.example/recipe/a",
      "https://recipes.example/recipe/b",
    ]);
    expect(result.recipeUrls).not.toContain("https://recipes.example/media/photo.jpg");
    expect(result.capped).toBe(false);
  });

  test("uses a sitemap redirect target as the fetched sitemap identity", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/fallback.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "Sitemap: /a.xml", "text/plain");
        if (url.pathname === "/a.xml") {
          return resource(
            url.href,
            "<sitemapindex><sitemap><loc>https://recipes.example/hop.xml</loc></sitemap></sitemapindex>",
            "application/xml",
          );
        }
        if (url.pathname === "/hop.xml") {
          return resource(
            "https://recipes.example/canonical.xml",
            "<sitemapindex><sitemap><loc>https://recipes.example/canonical.xml</loc></sitemap></sitemapindex>",
            "application/xml",
          );
        }
        if (url.pathname === "/fallback.xml") {
          return resource(
            url.href,
            "<urlset><url><loc>https://recipes.example/recipe/fallback</loc></url></urlset>",
            "application/xml",
          );
        }
        throw new Error(`unexpected request ${url.href}`);
      },
    }, { maxDepth: 1 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/a.xml",
      "https://recipes.example/hop.xml",
      "https://recipes.example/fallback.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/fallback"]);
    expect(result.capped).toBe(false);
  });

  test("does not charge a redirect target as another sitemap candidate", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") {
          return resource(url.href, "Sitemap: /alias.xml\nSitemap: /other.xml\n", "text/plain");
        }
        if (url.pathname === "/alias.xml") {
          return resource("https://recipes.example/canonical.xml", "<urlset></urlset>", "application/xml");
        }
        return resource(
          url.href,
          "<urlset><url><loc>https://recipes.example/recipe/other</loc></url></urlset>",
          "application/xml",
        );
      },
    }, { maxSitemaps: 2 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/alias.xml",
      "https://recipes.example/other.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/other"]);
    expect(result.capped).toBe(false);
  });

  test("skips a queued sitemap whose canonical identity was already fetched through a redirect", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "Sitemap: /index.xml", "text/plain");
        if (url.pathname === "/index.xml") {
          return resource(url.href, [
            "<sitemapindex>",
            "<sitemap><loc>https://recipes.example/alias.xml</loc></sitemap>",
            "<sitemap><loc>https://recipes.example/canonical.xml</loc></sitemap>",
            "</sitemapindex>",
          ].join(""), "application/xml");
        }
        if (url.pathname === "/alias.xml") {
          return resource(
            "https://recipes.example/canonical.xml",
            "<urlset><url><loc>https://recipes.example/recipe/redirected</loc></url></urlset>",
            "application/xml",
          );
        }
        throw new Error(`redirect target must not be fetched twice: ${url.href}`);
      },
    }, { maxSitemaps: 3 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/index.xml",
      "https://recipes.example/alias.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/redirected"]);
    expect(result.capped).toBe(false);
  });

  test("falls back when the depth limit omits no new sitemap work", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/fallback.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "Sitemap: /a.xml", "text/plain");
        if (url.pathname === "/a.xml") {
          return resource(
            url.href,
            "<sitemapindex><sitemap><loc>https://recipes.example/b.xml</loc></sitemap></sitemapindex>",
            "application/xml",
          );
        }
        if (url.pathname === "/b.xml") {
          return resource(url.href, [
            "<sitemapindex>",
            "<sitemap><loc>https://recipes.example/a.xml</loc></sitemap>",
            "<sitemap><loc>https://www.recipes.example/a.xml#duplicate</loc></sitemap>",
            "<sitemap><loc>https://recipes.example/b.xml</loc></sitemap>",
            "<sitemap><loc>http://[invalid</loc></sitemap>",
            "<sitemap><loc>https://evil.example/out-of-scope.xml</loc></sitemap>",
            "</sitemapindex>",
          ].join(""), "application/xml");
        }
        if (url.pathname === "/fallback.xml") {
          return resource(
            url.href,
            "<urlset><url><loc>https://recipes.example/recipe/fallback</loc></url></urlset>",
            "application/xml",
          );
        }
        throw new Error(`unexpected request ${url.href}`);
      },
    }, { maxDepth: 1 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/a.xml",
      "https://recipes.example/b.xml",
      "https://recipes.example/fallback.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/fallback"]);
    expect(result.capped).toBe(false);
    expect(result.warnings).toEqual([
      "https://recipes.example/b.xml: Nested sitemap URL is not a valid URL",
      "https://recipes.example/b.xml: Nested sitemap URL is outside configured source host scope",
    ]);
  });

  test("caps at the depth limit only for unique new sitemap work", async () => {
    const requested: string[] = [];
    await expect(discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/fallback.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "Sitemap: /a.xml", "text/plain");
        if (url.pathname === "/a.xml") {
          return resource(
            url.href,
            "<sitemapindex><sitemap><loc>https://recipes.example/b.xml</loc></sitemap></sitemapindex>",
            "application/xml",
          );
        }
        if (url.pathname === "/b.xml") {
          return resource(
            url.href,
            "<sitemapindex><sitemap><loc>https://recipes.example/new.xml</loc></sitemap></sitemapindex>",
            "application/xml",
          );
        }
        throw new Error(`fallback must not be fetched: ${url.href}`);
      },
    }, { maxDepth: 1 })).rejects.toThrow(
      "discovery limit reached before any recipe URL was found",
    );

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/a.xml",
      "https://recipes.example/b.xml",
    ]);
  });

  test("bounds nested cyclic sitemap traversal", async () => {
    const responses = new Map([
      ["https://recipes.example/a.xml", "<sitemapindex><sitemap><loc>https://recipes.example/b.xml</loc></sitemap></sitemapindex>"],
      ["https://recipes.example/b.xml", "<sitemapindex><sitemap><loc>https://recipes.example/a.xml</loc></sitemap><sitemap><loc>https://recipes.example/c.xml</loc></sitemap></sitemapindex>"],
      ["https://recipes.example/c.xml", "<urlset><url><loc>https://recipes.example/recipe/c</loc></url></urlset>"],
    ]);
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "Sitemap: /a.xml", "text/plain");
        const body = responses.get(url.href);
        if (!body) throw new Error("not found");
        return resource(url.href, body, "application/xml");
      },
    }, { maxDepth: 2, maxSitemaps: 3 });

    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/c"]);
    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/a.xml",
      "https://recipes.example/b.xml",
      "https://recipes.example/c.xml",
    ]);
  });

  test("caps and deduplicates sitemap candidates while enqueueing a huge index", async () => {
    const nested = Array.from({ length: 49_000 }, (_, index) =>
      `<sitemap><loc>https://recipes.example/nested-${index}.xml</loc></sitemap>`).join("");
    const requested: string[] = [];

    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/index.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "", "text/plain");
        if (url.pathname === "/index.xml") {
          return resource(url.href, `<sitemapindex>${nested}</sitemapindex>`, "application/xml");
        }
        return resource(url.href, "<urlset><url><loc>https://recipes.example/recipe/first</loc></url></urlset>", "application/xml");
      },
    }, { maxSitemaps: 2 });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/index.xml",
      "https://recipes.example/nested-0.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/first"]);
    expect(result.capped).toBe(true);
    expect(result.warnings).toContain("Sitemap candidate limit reached; additional sitemap URLs were ignored");
  });

  test("rejects cross-host recipe locations instead of scanning them", async () => {
    await expect(discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/sitemap.xml",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "", "text/plain")
        : resource(url.href, "<urlset><url><loc>https://evil.example/recipe</loc></url></urlset>", "application/xml"),
    })).rejects.toThrow("No usable sitemap found for source example");
  });

  test("keeps valid recipe locations after malformed and cross-host siblings", async () => {
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/sitemap.xml",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "", "text/plain")
        : resource(url.href, [
          "<urlset>",
          "<url><loc> </loc></url>",
          "<url><loc>https://evil.example/recipe</loc></url>",
          "<url><loc>http://[invalid</loc></url>",
          "<url><loc>https://recipes.example/recipe/good</loc></url>",
          "</urlset>",
        ].join(""), "application/xml"),
    });

    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/good"]);
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings[0]).toContain("Sitemap loc must be a non-empty bounded URL");
    expect(result.warnings[1]).toContain("Recipe URL is outside configured source host scope");
    expect(result.warnings[2]).toContain("Recipe URL is not a valid URL");
  });

  test("continues after one nested sitemap fails", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/index.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "", "text/plain");
        if (url.pathname === "/index.xml") {
          return resource(url.href, [
            "<sitemapindex>",
            "<sitemap><loc>https://recipes.example/broken.xml</loc></sitemap>",
            "<sitemap><loc>https://recipes.example/good.xml</loc></sitemap>",
            "</sitemapindex>",
          ].join(""), "application/xml");
        }
        if (url.pathname === "/broken.xml") throw new Error("blocked");
        return resource(url.href, "<urlset><url><loc>https://recipes.example/recipe/good</loc></url></urlset>", "application/xml");
      },
    });

    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/good"]);
    expect(result.warnings).toEqual(["https://recipes.example/broken.xml: blocked"]);
  });

  test("keeps valid nested sitemap locations after malformed and cross-host siblings", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/index.xml",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "", "text/plain");
        if (url.pathname === "/index.xml") {
          return resource(url.href, [
            "<sitemapindex>",
            "<sitemap><loc>https://evil.example/cross-host.xml</loc></sitemap>",
            "<sitemap><loc>http://[invalid</loc></sitemap>",
            "<sitemap><loc>https://recipes.example/good.xml</loc></sitemap>",
            "</sitemapindex>",
          ].join(""), "application/xml");
        }
        return resource(url.href, "<urlset><url><loc>https://recipes.example/recipe/good</loc></url></urlset>", "application/xml");
      },
    });

    expect(requested).toContain("https://recipes.example/good.xml");
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/good"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("Nested sitemap URL is outside configured source host scope");
    expect(result.warnings[1]).toContain("Nested sitemap URL is not a valid URL");
  });

  test("keeps valid robots sitemap directives after malformed and cross-host siblings", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") {
          return resource(url.href, [
            "Sitemap: https://evil.example/cross-host.xml",
            "Sitemap: http://[invalid",
            "Sitemap: https://recipes.example/good.xml",
          ].join("\n"), "text/plain");
        }
        if (url.pathname !== "/good.xml") throw new Error("fallback must not be used");
        return resource(url.href, "<urlset><url><loc>https://recipes.example/recipe/good</loc></url></urlset>", "application/xml");
      },
    });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/good.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipe/good"]);
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("Robots sitemap URL is outside configured source host scope");
    expect(result.warnings[1]).toContain("Robots sitemap URL is not a valid URL");
  });

  test("fetches root metadata for a custom path source but omits out-of-path recipe candidates", async () => {
    const requested: string[] = [];
    const result = await discoverRecipeUrls({
      id: "custom",
      baseUrl: "https://recipes.example/recipes/",
      discoveryUrl: null,
      recipeScope: "path",
    }, {
      fetch: async (url, kind) => {
        requested.push(url.href);
        if (kind === "robots") return resource(url.href, "Sitemap: /sitemap.xml", "text/plain");
        return resource(url.href, [
          "<urlset>",
          "<url><loc>https://recipes.example/blog/not-a-recipe</loc></url>",
          "<url><loc>https://recipes.example/recipes/valid</loc></url>",
          "</urlset>",
        ].join(""), "application/xml");
      },
    });

    expect(requested).toEqual([
      "https://recipes.example/robots.txt",
      "https://recipes.example/sitemap.xml",
    ]);
    expect(result.recipeUrls).toEqual(["https://recipes.example/recipes/valid"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("Recipe URL is outside configured source path scope");
  });

  test("rejects encoded traversal candidates but keeps encoded Unicode within a custom path", async () => {
    const result = await discoverRecipeUrls({
      id: "custom",
      baseUrl: "https://recipes.example/recipes/",
      discoveryUrl: null,
      recipeScope: "path",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "Sitemap: /sitemap.xml", "text/plain")
        : resource(url.href, [
          "<urlset>",
          "<url><loc>https://recipes.example/recipes/%2e%2e%2foutside</loc></url>",
          "<url><loc>https://recipes.example/recipes/%2e%2e%5coutside</loc></url>",
          "<url><loc>https://recipes.example/recipes/%252e%252e%252foutside</loc></url>",
          "<url><loc>https://recipes.example/recipes/caf%C3%A9%20soup</loc></url>",
          "</urlset>",
        ].join(""), "application/xml"),
    });

    expect(result.recipeUrls).toEqual(["https://recipes.example/recipes/caf%C3%A9%20soup"]);
    expect(result.warnings).toHaveLength(3);
    for (const warning of result.warnings) expect(warning).toContain("unsafe source path");
  });

  test("rejects an encoded dot segment even when URL parsing would normalize it inside a root scope", async () => {
    const result = await discoverRecipeUrls({
      id: "custom-root",
      baseUrl: "https://recipes.example/",
      discoveryUrl: null,
      recipeScope: "path",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "Sitemap: /sitemap.xml", "text/plain")
        : resource(url.href, [
          "<urlset>",
          "<url><loc>https://recipes.example/%2e%2e/outside</loc></url>",
          "<url><loc>https://recipes.example/caf%C3%A9%20soup</loc></url>",
          "</urlset>",
        ].join(""), "application/xml"),
    });

    expect(result.recipeUrls).toEqual(["https://recipes.example/caf%C3%A9%20soup"]);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0]).toContain("unsafe source path traversal");
  });

  test("reports malformed sitemap XML as unusable", async () => {
    await expect(discoverRecipeUrls({
      id: "example",
      baseUrl: "https://recipes.example/",
      discoveryUrl: "https://recipes.example/broken.xml",
    }, {
      fetch: async (url, kind) => kind === "robots"
        ? resource(url.href, "", "text/plain")
        : resource(url.href, "<urlset><url><loc>https://recipes.example/r</url></urlset>", "application/xml"),
    })).rejects.toThrow("Sitemap XML is malformed");
  });
});
