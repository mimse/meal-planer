import { expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { TilbudstroldenClient } from "../../src/adapters/deals/tilbudstrolden-client";
import { resolvePlanningServerDirectory } from "../../src/adapters/deals/planning-client";

test("finds the pinned server from source and bundled CLI layouts", () => {
  const root = resolve(import.meta.dir, "../..");
  expect(resolvePlanningServerDirectory(new URL("../../src/adapters/deals/planning-client.ts", import.meta.url).href))
    .toBe(join(root, "vendor/tilbudstrolden-mcp"));
  expect(resolvePlanningServerDirectory(new URL("../../dist/cli.js", import.meta.url).href))
    .toBe(join(root, "vendor/tilbudstrolden-mcp"));
});

test("an explicit pinned-server directory override wins over source-layout discovery", async () => {
  const directory = await mkdtemp(join(tmpdir(), "planning-server-override-"));
  try {
    await Bun.write(join(directory, "package.json"), JSON.stringify({ name: "tilbudstrolden-mcp", version: "0.5.3" }));
    await Bun.write(join(directory, "dist", "server.js"), "// built server");
    await Bun.write(join(directory, "node_modules", ".runtime-ready"), "ready");

    expect(resolvePlanningServerDirectory(
      new URL("file:///unrelated/dist/cli.js").href,
      { MEALPLAN_TILBUDSTROLDEN_DIR: directory },
    )).toBe(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("an invalid explicit pinned-server directory fails without falling back", async () => {
  const directory = await mkdtemp(join(tmpdir(), "planning-server-invalid-"));
  try {
    expect(() => resolvePlanningServerDirectory(
      import.meta.url,
      { MEALPLAN_TILBUDSTROLDEN_DIR: directory },
    )).toThrow("MEALPLAN_TILBUDSTROLDEN_DIR does not contain a built TilbudsTrolden 0.5.3 runtime");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("production factory isolates concurrent sessions and removes their private MCP files", async () => {
  const { createPlanningDealsClient } = await import("../../src/adapters/deals/planning-client");
  const dir = await mkdtemp(join(tmpdir(), "planning-factory-"));
  const clients = await Promise.all([createPlanningDealsClient({ dataDirectory: dir }), createPlanningDealsClient({ dataDirectory: dir })]);
  try {
    expect((await readdir(dir)).length).toBe(2);
    await Promise.all(clients.map(client => client.checkCompatibility()));
    await Promise.all(clients.map(client => client.updatePantry({ add: ["salt"], remove: [] })));
  } finally {
    await Promise.all(clients.map(client => client.close()));
    expect(await readdir(dir)).toEqual([]);
    await rm(dir, { recursive: true, force: true });
  }
});
const root = resolve(import.meta.dir, "../..");
test("real pinned MCP synchronizes planning metadata without touching shared data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "planning-mcp-"));
  const dataPath = join(dir, "data.json");
  const client = new TilbudstroldenClient({ command: "node", args: ["dist/server.js"], cwd: join(root, "vendor/tilbudstrolden-mcp"), dataPath, timeoutMs: 1000 });
  try {
    expect((await client.checkCompatibility()).compatible).toBe(true);
    const directory = await client.listStores({ all: false });
    expect(directory.some(store => store.name.toLowerCase().includes("netto"))).toBe(true);
    await client.updateHousehold({ country: "DK", people: [], defaultServings: 4, stores: [] });
    await client.updatePantry({ add: ["salt"], remove: [] });
    await client.addRecipe({ name: "mealplan:test", servings: 4, complexity: "quick", cuisineType: "danish", proteinType: "vegetarian", ingredients: [{ name: "carrots", quantity: "200 g", searchTerms: ["carrots"] }] });
    const stored = JSON.parse(await readFile(dataPath, "utf8"));
    expect(stored.household).toMatchObject({ country: "DK", people: [], stores: [], defaultServings: 4 });
    expect(stored.pantry).toEqual(["salt"]);
    expect(stored.recipes[0]).toMatchObject({ name: "mealplan:test", servings: 4, ingredients: [{ name: "carrots", quantity: "200 g" }] });
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});

test("closing interrupts a server that never finishes MCP initialization", async () => {
  const dir = await mkdtemp(join(tmpdir(), "planning-mcp-hung-"));
  await writeFile(join(dir, "server.cjs"), "process.stdin.resume(); setInterval(() => {}, 1000);");
  const client = new TilbudstroldenClient({ command: "node", args: ["server.cjs"], cwd: dir, dataPath: join(dir, "data.json"), timeoutMs: 1000 });
  const pending = client.checkCompatibility().catch(error => error);
  try {
    await new Promise(resolve => setTimeout(resolve, 30));
    const started = performance.now();
    await client.close();
    expect(performance.now() - started).toBeLessThan(600);
    expect(await pending).toBeInstanceOf(Error);
  } finally { await client.close(); await rm(dir, { recursive: true, force: true }); }
});
