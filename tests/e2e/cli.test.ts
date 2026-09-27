import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectRecipeUrl } from "../../src/commands/inspect-recipe";

const projectRoot = new URL("../..", import.meta.url).pathname;

test("CLI exposes the phase-zero recipe and integration commands", async () => {
  const process = Bun.spawn(["bun", "run", "src/cli.ts", "--help"], {
    cwd: projectRoot,
    stdout: "pipe",
    stderr: "pipe",
  });

  const [exitCode, stdout, stderr] = await Promise.all([
    process.exited,
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]);

  expect(stderr).toBe("");
  expect(exitCode).toBe(0);
  expect(stdout).toContain("recipes");
  expect(stdout).toContain("integrations");
});

test("recipe inspection follows safe redirects and resolves evidence against the response URL", async () => {
  const requestedUrls: string[] = [];
  const recipe = await inspectRecipeUrl(new URL("https://recipes.example/start"), {
    resolveHostname: async () => ["93.184.216.34"],
    allowTestTransport: true,
    fetchImpl: async (url) => {
      requestedUrls.push(url.href);
      if (url.pathname === "/start") {
        return new Response(null, {
          status: 302,
          headers: { location: "https://cdn.example/redirected/page" },
        });
      }

      return new Response(`
        <link rel="canonical" href="../canonical/beans/">
        <script type="application/ld+json">
          {
            "@context": "https://schema.org",
            "@type": "Recipe",
            "name": "Beans",
            "url": "details",
            "recipeYield": "4 servings",
            "totalTime": "PT20M",
            "recipeIngredient": ["400 g beans"]
          }
        </script>
      `, { headers: { "content-type": "text/html" } });
    },
  });

  expect(requestedUrls).toEqual([
    "https://recipes.example/start",
    "https://cdn.example/redirected/page",
  ]);
  expect(recipe).toMatchObject({
    title: "Beans",
    sourceUrl: "https://cdn.example/redirected/details",
    canonicalUrl: "https://cdn.example/canonical/beans/",
    servings: 4,
    totalMinutes: 20,
    rawIngredients: ["400 g beans"],
  });
});

test("recipes inspect rejects private network targets", async () => {
  const process = Bun.spawn(
    ["bun", "run", "src/cli.ts", "recipes", "inspect", "http://127.0.0.1:1/recipe"],
    { cwd: projectRoot, stdout: "pipe", stderr: "pipe" },
  );

  const [exitCode, stderr] = await Promise.all([
    process.exited,
    new Response(process.stderr).text(),
  ]);

  expect(exitCode).not.toBe(0);
  expect(stderr).toContain("not publicly routable");
});

test("integrations verify-deals reports output-schema compatibility in human-readable output", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "meal-planer-cli-mcp-"));

  try {
    const process = Bun.spawn([
      "bun",
      "run",
      "src/cli.ts",
      "integrations",
      "verify-deals",
      "--server",
      "vendor/tilbudstrolden-mcp/dist/server.js",
      "--data",
      join(dataDirectory, "tilbudstrolden.json"),
    ], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(stdout).toContain("All required tool output schemas are compatible.");
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});

test("integrations verify-deals reports pinned-server compatibility", async () => {
  const dataDirectory = await mkdtemp(join(tmpdir(), "meal-planer-cli-mcp-"));

  try {
    const process = Bun.spawn([
      "bun",
      "run",
      "src/cli.ts",
      "integrations",
      "verify-deals",
      "--server",
      "vendor/tilbudstrolden-mcp/dist/server.js",
      "--data",
      join(dataDirectory, "tilbudstrolden.json"),
      "--json",
    ], {
      cwd: projectRoot,
      stdout: "pipe",
      stderr: "pipe",
    });

    const [exitCode, stdout, stderr] = await Promise.all([
      process.exited,
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
    ]);

    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({
      compatible: true,
      server: { name: "tilbudstrolden", version: "0.5.3" },
      expectedServer: { name: "tilbudstrolden", version: "0.5.3" },
      serverCompatible: true,
      toolCount: 18,
      missingRequiredTools: [],
      incompatibleToolSchemas: [],
      missingRequiredToolOutputSchemas: [],
      incompatibleToolOutputSchemas: [],
    });
  } finally {
    await rm(dataDirectory, { recursive: true, force: true });
  }
});
