import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/infrastructure/database";
import { HttpCacheRepository } from "../../src/infrastructure/http-cache-repository";
import { HostRateLimiter } from "../../src/infrastructure/host-rate-limiter";
import { CachedResourceFetcher } from "../../src/application/cached-resource-fetcher";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("HttpCacheRepository", () => {
  test("persists and validates a bounded HTTP response", () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, {
      maxEntries: 2,
      maxBodyBytes: 64,
      now: () => "2026-01-02T03:04:05.000Z",
    });

    cache.put({
      url: "https://recipes.example/sitemap.xml",
      finalUrl: "https://www.recipes.example/sitemap.xml",
      mediaType: "application/xml",
      body: "<urlset></urlset>",
      etag: "\"v1\"",
      lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
    });

    expect(cache.get("https://recipes.example/sitemap.xml")).toEqual({
      url: "https://recipes.example/sitemap.xml",
      finalUrl: "https://www.recipes.example/sitemap.xml",
      mediaType: "application/xml",
      body: "<urlset></urlset>",
      fetchedAt: "2026-01-02T03:04:05.000Z",
      etag: "\"v1\"",
      lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
    });
    database.close();
  });

  test("atomically refreshes cached validators and timestamp after a valid conditional 304", async () => {
    const database = openDatabase(":memory:");
    let now = "2026-01-02T03:04:05.000Z";
    const cache = new HttpCacheRepository(database, {
      maxEntries: 2,
      maxBodyBytes: 128,
      now: () => now,
    });
    cache.put({
      url: "https://recipes.example/sitemap.xml",
      finalUrl: "https://recipes.example/sitemap.xml",
      mediaType: "application/xml",
      body: "<urlset><url><loc>https://recipes.example/r</loc></url></urlset>",
      etag: "\"v1\"",
      lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
    });
    now = "2026-01-03T03:04:05.000Z";
    let receivedHeaders = new Headers();
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 2,
    }), {
      fetchResource: async (url, options, dependencies) => {
        receivedHeaders = new Headers(dependencies.requestInit?.headers);
        expect(options.allowNotModified).toBe(true);
        return {
          body: "",
          url,
          mediaType: null,
          status: 304,
          etag: "\"v2\"",
          lastModified: null,
        };
      },
    });

    const result = await fetcher.fetch(new URL("https://recipes.example/sitemap.xml"), "sitemap");

    expect(receivedHeaders.get("if-none-match")).toBe("\"v1\"");
    expect(receivedHeaders.get("if-modified-since")).toBe("Thu, 01 Jan 2026 00:00:00 GMT");
    expect(result.cacheStatus).toBe("revalidated");
    expect(result.resource).toMatchObject({
      body: "<urlset><url><loc>https://recipes.example/r</loc></url></urlset>",
      mediaType: "application/xml",
      etag: "\"v2\"",
      lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
    });
    expect(cache.get("https://recipes.example/sitemap.xml")).toMatchObject({
      body: "<urlset><url><loc>https://recipes.example/r</loc></url></urlset>",
      mediaType: "application/xml",
      fetchedAt: "2026-01-03T03:04:05.000Z",
      etag: "\"v2\"",
      lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
    });
    database.close();
  });

  test("rejects a 304 when the cached entry has no validators", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, { maxEntries: 2, maxBodyBytes: 128 });
    cache.put({
      url: "https://recipes.example/sitemap.xml",
      finalUrl: "https://recipes.example/sitemap.xml",
      mediaType: "application/xml",
      body: "<urlset></urlset>",
      etag: null,
      lastModified: null,
    });
    let allowNotModified: boolean | undefined;
    let receivedHeaders = new Headers();
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 2,
    }), {
      fetchDependencies: {
        requestInit: { headers: { "if-none-match": "untrusted-caller-validator" } },
      },
      fetchResource: async (url, options, dependencies) => {
        allowNotModified = options.allowNotModified;
        receivedHeaders = new Headers(dependencies.requestInit?.headers);
        return {
          body: "",
          url,
          mediaType: null,
          status: 304,
          etag: null,
          lastModified: null,
        };
      },
    });

    await expect(fetcher.fetch(new URL("https://recipes.example/sitemap.xml"), "sitemap"))
      .rejects.toThrow("without a conditional request");
    expect(allowNotModified).toBe(false);
    expect(receivedHeaders.get("if-none-match")).toBeNull();
    database.close();
  });

  test("rejects a 304 whose final URL differs from the cached representation", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, {
      maxEntries: 2,
      maxBodyBytes: 128,
      now: () => "2026-01-02T03:04:05.000Z",
    });
    const requestUrl = "https://recipes.example/sitemap.xml";
    cache.put({
      url: requestUrl,
      finalUrl: "https://recipes.example/final.xml",
      mediaType: "application/xml",
      body: "<urlset></urlset>",
      etag: "\"v1\"",
      lastModified: null,
    });
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 2,
    }), {
      fetchResource: async () => ({
        body: "",
        url: new URL("https://recipes.example/different.xml"),
        mediaType: null,
        status: 304,
        etag: "\"v2\"",
        lastModified: null,
      }),
    });

    await expect(fetcher.fetch(new URL(requestUrl), "sitemap"))
      .rejects.toThrow("does not match the cached final URL");
    expect(cache.get(requestUrl)).toMatchObject({
      finalUrl: "https://recipes.example/final.xml",
      fetchedAt: "2026-01-02T03:04:05.000Z",
      etag: "\"v1\"",
    });
    database.close();
  });

  test("rejects invalid validators returned by a 304 without mutating the cache", async () => {
    const database = openDatabase(":memory:");
    let now = "2026-01-02T03:04:05.000Z";
    const cache = new HttpCacheRepository(database, {
      maxEntries: 2,
      maxBodyBytes: 128,
      now: () => now,
    });
    const requestUrl = "https://recipes.example/sitemap.xml";
    cache.put({
      url: requestUrl,
      finalUrl: requestUrl,
      mediaType: "application/xml",
      body: "<urlset></urlset>",
      etag: "\"v1\"",
      lastModified: null,
    });
    now = "2026-01-03T03:04:05.000Z";
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 2,
    }), {
      fetchResource: async (url) => ({
        body: "",
        url,
        mediaType: null,
        status: 304,
        etag: "not-an-entity-tag",
        lastModified: null,
      }),
    });

    await expect(fetcher.fetch(new URL(requestUrl), "sitemap"))
      .rejects.toThrow("HTTP cache ETag is invalid");
    expect(cache.get(requestUrl)).toMatchObject({
      fetchedAt: "2026-01-02T03:04:05.000Z",
      etag: "\"v1\"",
    });
    database.close();
  });

  test("serializes same-key cache updates so an older response cannot overwrite a newer one", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, { maxEntries: 4, maxBodyBytes: 128 });
    const requestUrl = "https://recipes.example/sitemap.xml";
    cache.put({
      url: requestUrl,
      finalUrl: requestUrl,
      mediaType: "application/xml",
      body: "<urlset>v1</urlset>",
      etag: "\"v1\"",
      lastModified: null,
    });
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let firstStarted!: () => void;
    const started = new Promise<void>((resolve) => { firstStarted = resolve; });
    const seenValidators: Array<string | null> = [];
    let calls = 0;
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 4,
    }), {
      fetchResource: async (url, _options, dependencies) => {
        calls += 1;
        const version = calls + 1;
        seenValidators.push(new Headers(dependencies.requestInit?.headers).get("if-none-match"));
        if (calls === 1) {
          firstStarted();
          await firstBlocked;
        }
        return {
          body: `<urlset>v${version}</urlset>`,
          url,
          mediaType: "application/xml",
          status: 200,
          etag: `\"v${version}\"`,
          lastModified: null,
        };
      },
    });

    const first = fetcher.fetch(new URL(requestUrl), "sitemap");
    await started;
    const second = fetcher.fetch(new URL(requestUrl), "sitemap");
    await Promise.resolve();
    await Promise.resolve();
    const callsBeforeRelease = calls;
    releaseFirst();
    await Promise.all([first, second]);

    expect(callsBeforeRelease).toBe(1);
    expect(seenValidators).toEqual(["\"v1\"", "\"v2\""]);
    expect(cache.get(requestUrl)).toMatchObject({ body: "<urlset>v3</urlset>", etag: "\"v3\"" });
    database.close();
  });

  test("cleans a failed same-key lock and still runs different keys concurrently", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, { maxEntries: 4, maxBodyBytes: 128 });
    let fail = true;
    const active = new Set<string>();
    let maximumActive = 0;
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 4,
    }), {
      fetchResource: async (url) => {
        if (fail) {
          fail = false;
          throw new Error("transient failure");
        }
        active.add(url.href);
        maximumActive = Math.max(maximumActive, active.size);
        await Promise.resolve();
        active.delete(url.href);
        return {
          body: "<urlset></urlset>",
          url,
          mediaType: "application/xml",
          status: 200,
          etag: null,
          lastModified: null,
        };
      },
    });

    await expect(fetcher.fetch(new URL("https://a.example/sitemap.xml"), "sitemap"))
      .rejects.toThrow("transient failure");
    await Promise.all([
      fetcher.fetch(new URL("https://a.example/sitemap.xml"), "sitemap"),
      fetcher.fetch(new URL("https://b.example/sitemap.xml"), "sitemap"),
    ]);

    expect(maximumActive).toBe(2);
    expect(cache.count()).toBe(2);
    database.close();
  });

  test("bounds active cache-key locks and releases the bound after completion", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, { maxEntries: 300, maxBodyBytes: 128 });
    let releaseRequests!: () => void;
    const blocked = new Promise<void>((resolve) => { releaseRequests = resolve; });
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 300,
    }), {
      fetchResource: async (url) => {
        await blocked;
        return {
          body: "<urlset></urlset>",
          url,
          mediaType: "application/xml",
          status: 200,
          etag: null,
          lastModified: null,
        };
      },
    });

    const active = Array.from({ length: 256 }, (_, index) =>
      fetcher.fetch(new URL(`https://host-${index}.example/sitemap.xml`), "sitemap"));
    const overflow = fetcher.fetch(new URL("https://overflow.example/sitemap.xml"), "sitemap");
    releaseRequests();

    await expect(overflow).rejects.toThrow("Too many concurrent HTTP cache keys; limit is 256");
    await Promise.all(active);
    await expect(fetcher.fetch(new URL("https://overflow.example/sitemap.xml"), "sitemap"))
      .resolves.toMatchObject({ cacheStatus: "miss" });
    database.close();
  });

  test("stores a redirected response under a fragmentless final URL", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, { maxEntries: 2, maxBodyBytes: 128 });
    const requested: string[] = [];
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 2,
    }), {
      fetchDependencies: {
        resolveHostname: async () => ["93.184.216.34"],
        allowTestTransport: true,
        fetchImpl: async (url) => {
          requested.push(url.href);
          if (url.pathname === "/start") {
            return new Response(null, { status: 302, headers: { location: "/final.xml#section" } });
          }
          return new Response("<urlset></urlset>", {
            headers: { "content-type": "application/xml" },
          });
        },
      },
    });

    const result = await fetcher.fetch(new URL("https://recipes.example/start"), "sitemap");

    expect(requested).toEqual([
      "https://recipes.example/start",
      "https://recipes.example/final.xml",
    ]);
    expect(result.resource.url.href).toBe("https://recipes.example/final.xml");
    expect(cache.get("https://recipes.example/start")).toMatchObject({
      finalUrl: "https://recipes.example/final.xml",
      body: "<urlset></urlset>",
    });
    database.close();
  });

  test("stores only a complete successful 200 response", async () => {
    const database = openDatabase(":memory:");
    const cache = new HttpCacheRepository(database, { maxEntries: 2, maxBodyBytes: 128 });
    const fetcher = new CachedResourceFetcher(cache, new HostRateLimiter({
      minimumSpacingMs: 0,
      maxHosts: 2,
    }), {
      fetchResource: async (url) => ({
        body: "<urlset></urlset>",
        url,
        mediaType: "application/xml",
        status: 200,
        etag: null,
        lastModified: null,
      }),
    });

    expect((await fetcher.fetch(new URL("https://recipes.example/sitemap.xml"), "sitemap")).cacheStatus)
      .toBe("miss");
    expect(cache.count()).toBe(1);
    database.close();
  });

  test("rejects corrupt oversized rows at runtime", () => {
    const database = openDatabase(":memory:");
    database.query(`
      INSERT INTO http_cache (
        url, final_url, media_type, body, fetched_at, etag, last_modified, access_sequence
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      "https://recipes.example/sitemap.xml",
      "https://recipes.example/sitemap.xml",
      "application/xml",
      "x".repeat(65),
      "2026-01-02T03:04:05.000Z",
      null,
      null,
      1,
    );
    const cache = new HttpCacheRepository(database, { maxEntries: 2, maxBodyBytes: 64 });

    expect(() => cache.get("https://recipes.example/sitemap.xml")).toThrow("exceeds 64 bytes");
    database.close();
  });

  test("evicts deterministic LRU entries and survives reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-http-cache-"));
    temporaryDirectories.push(directory);
    const path = join(directory, "mealplan.sqlite");
    let database = openDatabase(path);
    let cache = new HttpCacheRepository(database, { maxEntries: 2, maxBodyBytes: 64 });
    const put = (name: string) => cache.put({
      url: `https://recipes.example/${name}.xml`,
      finalUrl: `https://recipes.example/${name}.xml`,
      mediaType: "application/xml",
      body: `<${name}/>`,
      etag: null,
      lastModified: null,
    });
    put("a");
    put("b");
    expect(cache.get("https://recipes.example/a.xml")?.body).toBe("<a/>");
    put("c");
    database.close();

    database = openDatabase(path);
    cache = new HttpCacheRepository(database, { maxEntries: 2, maxBodyBytes: 64 });
    expect(cache.get("https://recipes.example/b.xml")).toBeNull();
    expect(cache.get("https://recipes.example/a.xml")?.body).toBe("<a/>");
    expect(cache.get("https://recipes.example/c.xml")?.body).toBe("<c/>");
    database.close();
  });
});
