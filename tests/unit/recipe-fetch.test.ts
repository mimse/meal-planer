import { describe, expect, test } from "bun:test";
import {
  createPinnedLookup,
  fetchPublicResource,
  fetchRecipePage,
} from "../../src/adapters/recipes/fetch";

describe("fetchPublicResource", () => {
  test("accepts allowlisted robots text with its own byte limit", async () => {
    const result = await fetchPublicResource(new URL("https://recipes.example/robots.txt"), {
      kind: "robots",
      limits: { robots: 64, sitemap: 128, recipe: 256, absolute: 512 },
    }, {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async () => new Response("Sitemap: /sitemap.xml\n", {
        headers: { "content-type": "text/plain; charset=utf-8" },
      }),
    });

    expect(result).toMatchObject({
      body: "Sitemap: /sitemap.xml\n",
      mediaType: "text/plain",
      url: new URL("https://recipes.example/robots.txt"),
    });
  });

  test("enforces robots and sitemap byte limits and cancels oversized streams", async () => {
    for (const kind of ["robots", "sitemap"] as const) {
      let cancelled = false;
      const body = new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(new TextEncoder().encode("123456"));
        },
        cancel() { cancelled = true; },
      });
      await expect(fetchPublicResource(new URL(`https://recipes.example/${kind}`), {
        kind,
        limits: { robots: 5, sitemap: 5, recipe: 5, absolute: 5 },
      }, {
        resolveHostname: async () => ["93.184.216.34"],
        allowTestTransport: true,
        fetchImpl: async () => new Response(body, {
          headers: { "content-type": kind === "robots" ? "text/plain" : "application/xml" },
        }),
      })).rejects.toThrow("exceeds the 5 byte limit");
      expect(cancelled).toBe(true);
    }
  });

  test("rejects cross-host sitemap redirects before sending the redirected request", async () => {
    const requests: string[] = [];
    await expect(fetchPublicResource(new URL("https://recipes.example/sitemap.xml"), {
      kind: "sitemap",
      sourceScope: new URL("https://recipes.example/"),
    }, {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async (url) => {
        requests.push(url.href);
        return new Response(null, {
          status: 302,
          headers: { location: "https://other.example/sitemap.xml" },
        });
      },
    })).rejects.toThrow("outside configured source host scope");
    expect(requests).toEqual(["https://recipes.example/sitemap.xml"]);
  });

  test("applies the request gate to every redirect hop", async () => {
    const gated: string[] = [];
    const requested: string[] = [];
    await fetchPublicResource(new URL("https://recipes.example/start"), {
      kind: "sitemap",
      sourceScope: new URL("https://recipes.example/"),
    }, {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      requestGate: async (url, operation) => {
        gated.push(url.href);
        return operation();
      },
      fetchImpl: async (url) => {
        requested.push(url.href);
        if (url.pathname === "/start") {
          return new Response(null, { status: 302, headers: { location: "/sitemap.xml" } });
        }
        return new Response("<urlset></urlset>", { headers: { "content-type": "application/xml" } });
      },
    });

    expect(gated).toEqual(requested);
    expect(gated).toHaveLength(2);
  });

  test("keeps only safe allowlisted headers on a cross-origin recipe redirect", async () => {
    const requests: Array<{ url: string; headers: Record<string, string> }> = [];

    const result = await fetchPublicResource(new URL("https://recipes.example/start"), {
      kind: "recipe",
    }, {
      requestInit: {
        headers: {
          accept: "text/html",
          "accept-language": "da-DK",
          authorization: "Bearer origin-secret",
          cookie: "session=origin-secret",
          "if-match": "\"origin-version\"",
          "if-range": "\"origin-range\"",
          "proxy-authorization": "Basic proxy-secret",
          referer: "https://recipes.example/start?token=origin-secret",
          "user-agent": "meal-planer/test",
          "x-api-key": "origin-api-key",
          "x-client-secret": "arbitrary-origin-secret",
        },
      },
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async (url, init) => {
        requests.push({ url: url.href, headers: Object.fromEntries(new Headers(init.headers).entries()) });
        if (url.hostname === "recipes.example") {
          return new Response(null, {
            status: 302,
            headers: { location: "https://cdn.example/recipe" },
          });
        }
        return new Response("<html></html>", { headers: { "content-type": "text/html" } });
      },
    });

    expect(result.url.href).toBe("https://cdn.example/recipe");
    expect(requests).toEqual([
      {
        url: "https://recipes.example/start",
        headers: {
          accept: "text/html",
          "accept-language": "da-DK",
          authorization: "Bearer origin-secret",
          cookie: "session=origin-secret",
          "if-match": "\"origin-version\"",
          "if-range": "\"origin-range\"",
          "proxy-authorization": "Basic proxy-secret",
          referer: "https://recipes.example/start?token=origin-secret",
          "user-agent": "meal-planer/test",
          "x-api-key": "origin-api-key",
          "x-client-secret": "arbitrary-origin-secret",
        },
      },
      {
        url: "https://cdn.example/recipe",
        headers: {
          accept: "text/html",
          "accept-language": "da-DK",
          "user-agent": "meal-planer/test",
        },
      },
    ]);
  });

  test("rejects HTTP 304 when no validated conditional header was sent", async () => {
    await expect(fetchPublicResource(new URL("https://recipes.example/sitemap.xml"), {
      kind: "sitemap",
      allowNotModified: true,
    }, {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async () => new Response(null, { status: 304 }),
    })).rejects.toThrow("without a validated conditional request");
  });
});

describe("fetchRecipePage", () => {
  test("pinned lookup supports all-address mode without another DNS query", async () => {
    const result = await new Promise<unknown>((resolve, reject) => {
      createPinnedLookup("93.184.216.34")("recipes.example", { all: true }, (error, addresses) => {
        if (error) reject(error);
        else resolve(addresses);
      });
    });

    expect(result).toEqual([{ address: "93.184.216.34", family: 4 }]);
  });

  test("rejects non-HTTP URL schemes before fetching", async () => {
    let fetchCalls = 0;

    await expect(fetchRecipePage(new URL("file:///etc/passwd"), {
      allowTestTransport: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    })).rejects.toThrow("Only HTTP and HTTPS recipe URLs are allowed");
    expect(fetchCalls).toBe(0);
  });

  test("rejects loopback, private, and link-local IP address literals", async () => {
    const blockedUrls = [
      "http://127.0.0.1/recipe",
      "http://10.0.0.1/recipe",
      "http://172.16.0.1/recipe",
      "http://192.168.0.1/recipe",
      "http://169.254.1.1/recipe",
      "http://[::1]/recipe",
      "http://[fe80::1]/recipe",
      "http://[fc00::1]/recipe",
      "http://[fec0::1]/recipe",
      "http://[64:ff9b:1::1]/recipe",
    ];
    let fetchCalls = 0;

    for (const value of blockedUrls) {
      await expect(fetchRecipePage(new URL(value), {
        allowTestTransport: true,
        fetchImpl: async () => {
          fetchCalls += 1;
          return new Response();
        },
      })).rejects.toThrow("not publicly routable");
    }
    expect(fetchCalls).toBe(0);
  });

  test("rejects IPv4 literals in deprecated 192.88.99.0/24", async () => {
    let requestCalls = 0;

    for (const address of ["192.88.99.0", "192.88.99.2", "192.88.99.255"]) {
      await expect(fetchRecipePage(new URL(`http://${address}/recipe`), {
        allowTestTransport: true,
        requestImpl: async () => {
          requestCalls += 1;
          return new Response("<html></html>", {
            headers: { "content-type": "text/html" },
          });
        },
      })).rejects.toThrow("not publicly routable");
    }
    expect(requestCalls).toBe(0);
  });

  test("rejects hostnames if any resolved address is not publicly routable", async () => {
    let fetchCalls = 0;

    await expect(fetchRecipePage(new URL("https://recipes.example/beans"), {
      resolveHostname: async () => ["93.184.216.34", "192.168.1.10"],
      allowTestTransport: true,
      fetchImpl: async () => {
        fetchCalls += 1;
        return new Response();
      },
    })).rejects.toThrow("not publicly routable");
    expect(fetchCalls).toBe(0);
  });

  test("rejects DNS answers in deprecated 192.88.99.0/24", async () => {
    let requestCalls = 0;

    await expect(fetchRecipePage(new URL("https://recipes.example/beans"), {
      resolveHostname: async () => ["192.88.99.2"],
      allowTestTransport: true,
      requestImpl: async () => {
        requestCalls += 1;
        return new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    })).rejects.toThrow("not publicly routable");
    expect(requestCalls).toBe(0);
  });

  test("rejects DNS answers in non-global IPv6 ranges", async () => {
    for (const address of ["fec0::1", "64:ff9b:1::1"]) {
      let requestCalls = 0;
      await expect(fetchRecipePage(new URL("https://recipes.example/beans"), {
        resolveHostname: async () => [address],
        allowTestTransport: true,
        requestImpl: async () => {
          requestCalls += 1;
          return new Response();
        },
      })).rejects.toThrow("not publicly routable");
      expect(requestCalls).toBe(0);
    }
  });

  test("uses manual redirects and revalidates each redirect target", async () => {
    const requests: Array<{ url: string; redirect: RequestRedirect | undefined }> = [];

    await expect(fetchRecipePage(new URL("https://recipes.example/start"), {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async (url, init) => {
        requests.push({ url: url.href, redirect: init.redirect });
        return new Response(null, {
          status: 302,
          headers: { location: "http://127.0.0.1/internal" },
        });
      },
    })).rejects.toThrow("not publicly routable");

    expect(requests).toEqual([
      { url: "https://recipes.example/start", redirect: "manual" },
    ]);
  });

  test("rejects successful responses that are not HTML", async () => {
    await expect(fetchRecipePage(new URL("https://recipes.example/data"), {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async () => new Response("{}", {
        headers: { "content-type": "application/json" },
      }),
    })).rejects.toThrow("unsupported Content-Type");
  });

  test("stops streaming HTML when the response exceeds the byte limit", async () => {
    let cancelled = false;
    const chunks = ["1234", "5678"];
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(chunks.shift() ?? "more"));
      },
      cancel() {
        cancelled = true;
      },
    });

    await expect(fetchRecipePage(new URL("https://recipes.example/large"), {
      maxBytes: 5,
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async () => new Response(body, {
        headers: { "content-type": "text/html; charset=utf-8" },
      }),
    })).rejects.toThrow("exceeds the 5 byte limit");
    expect(cancelled).toBe(true);
  });

  test("forwards request options while forcing manual redirect handling", async () => {
    let receivedInit: RequestInit | undefined;

    await fetchRecipePage(new URL("https://recipes.example/page"), {
      requestInit: { headers: { "user-agent": "meal-planer/test" } },
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      fetchImpl: async (_url, init) => {
        receivedInit = init;
        return new Response("<html></html>", {
          headers: { "content-type": "application/xhtml+xml" },
        });
      },
    });

    expect(receivedInit).toMatchObject({
      headers: { "user-agent": "meal-planer/test" },
      redirect: "manual",
    });
  });

  test("passes the validated DNS address to the request transport", async () => {
    const connections: Array<{ url: string; address: string }> = [];

    await fetchRecipePage(new URL("https://recipes.example/page"), {
      resolveHostname: async () => ["93.184.216.34"],
      allowTestTransport: true,
      requestImpl: async (url, address) => {
        connections.push({ url: url.href, address });
        return new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        });
      },
    });

    expect(connections).toEqual([{
      url: "https://recipes.example/page",
      address: "93.184.216.34",
    }]);
  });
});
