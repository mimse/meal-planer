import { describe, expect, test } from "bun:test";
import {
  createPinnedLookup,
  fetchRecipePage,
} from "../../src/adapters/recipes/fetch";

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
