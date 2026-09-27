import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { exists, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function runCli(args: string[], environment: Record<string, string> = {}): Promise<CliResult> {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: projectRoot,
    env: { ...process.env, ...environment },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  return { exitCode, stdout, stderr };
}

function memberArguments(count: number): string[] {
  return Array.from({ length: count }, (_, index) => [
    "--member",
    JSON.stringify({ id: `member-${index + 1}`, name: `Member ${index + 1}`, kind: "adult", servings: 1 }),
  ]).flat();
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("setup and family CLI", () => {
  test("adds pantry items and shows stable JSON across CLI processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    const setup = await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ]);
    expect(setup.exitCode, setup.stderr).toBe(0);

    const added = await runCli([
      "--database", databasePath, "pantry", "add",
      "--item", JSON.stringify({ name: " Rice ", quantity: "ca. 500 g" }),
      "--item", JSON.stringify({ name: "Chickpeas", quantity: "2 cans" }),
    ]);
    expect(added.exitCode, added.stderr).toBe(0);

    const shown = await runCli(["--database", databasePath, "pantry", "show", "--json"]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(shown.stdout).toBe(`${JSON.stringify([
      { normalizedName: "chickpeas", name: "Chickpeas", quantity: "2 cans" },
      { normalizedName: "rice", name: "Rice", quantity: "ca. 500 g" },
    ], null, 2)}\n`);
  });

  test("pantry removal normalizes Unicode names and rolls back when any name is unknown", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    expect((await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ])).exitCode).toBe(0);
    expect((await runCli([
      "--database", databasePath, "pantry", "add",
      "--item", JSON.stringify({ name: "Café salt", quantity: "1 bag" }),
      "--item", JSON.stringify({ name: "Rice", quantity: "500 g" }),
    ])).exitCode).toBe(0);

    const failed = await runCli([
      "--database", databasePath, "pantry", "remove", "Ｃａｆé   salt", "missing",
    ]);
    expect(failed.exitCode).not.toBe(0);
    expect(failed.stderr).toContain("Pantry item does not exist: missing");
    expect(JSON.parse((await runCli([
      "--database", databasePath, "pantry", "show", "--json",
    ])).stdout)).toHaveLength(2);

    const removed = await runCli([
      "--database", databasePath, "pantry", "remove", " Ｃａｆé   salt ",
    ]);
    expect(removed.exitCode, removed.stderr).toBe(0);
    expect(JSON.parse((await runCli([
      "--database", databasePath, "pantry", "show", "--json",
    ])).stdout)).toEqual([
      { normalizedName: "rice", name: "Rice", quantity: "500 g" },
    ]);
  });

  test("invalid multi-item pantry input is rejected before any mutation", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    expect((await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ])).exitCode).toBe(0);

    const result = await runCli([
      "--database", databasePath, "pantry", "add",
      "--item", JSON.stringify({ name: "Must not persist", quantity: "1 bag" }),
      "--item", JSON.stringify({ name: "Invalid", quantity: "   " }),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(JSON.parse((await runCli([
      "--database", databasePath, "pantry", "show", "--json",
    ])).stdout)).toEqual([]);
  });

  test("pantry show does not create a missing database or parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "missing", "family.sqlite");

    const result = await runCli(["--database", databasePath, "pantry", "show", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run mealplan setup first");
    expect(await exists(join(root, "missing"))).toBe(false);
  });

  test("adds a validated recipe source and lists stable JSON across processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    expect((await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ])).exitCode).toBe(0);

    const added = await runCli([
      "--database", databasePath, "sources", "add", "https://recipes.example/path",
      "--id", "example-recipes", "--name", "Example Recipes", "--adapter", "auto",
    ]);
    expect(added.exitCode, added.stderr).toBe(0);

    const listed = await runCli(["--database", databasePath, "sources", "list", "--json"]);
    expect(listed.exitCode, listed.stderr).toBe(0);
    const sources = JSON.parse(listed.stdout);
    expect(sources.find((source: { id: string }) => source.id === "example-recipes")).toEqual({
      id: "example-recipes",
      name: "Example Recipes",
      baseUrl: "https://recipes.example/path",
      adapter: "auto",
      enabled: true,
    });
    expect(listed.stdout).toBe(`${JSON.stringify(sources, null, 2)}\n`);
  });

  test("disables, enables, and removes a recipe source persistently", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    expect((await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ])).exitCode).toBe(0);

    expect((await runCli(["--database", databasePath, "sources", "disable", "mummum"])).exitCode).toBe(0);
    let listed = JSON.parse((await runCli([
      "--database", databasePath, "sources", "list", "--json",
    ])).stdout);
    expect(listed.find((source: { id: string }) => source.id === "mummum").enabled).toBe(false);

    expect((await runCli(["--database", databasePath, "sources", "enable", "mummum"])).exitCode).toBe(0);
    listed = JSON.parse((await runCli([
      "--database", databasePath, "sources", "list", "--json",
    ])).stdout);
    expect(listed.find((source: { id: string }) => source.id === "mummum").enabled).toBe(true);

    expect((await runCli(["--database", databasePath, "sources", "remove", "mummum"])).exitCode).toBe(0);
    listed = JSON.parse((await runCli([
      "--database", databasePath, "sources", "list", "--json",
    ])).stdout);
    expect(listed.some((source: { id: string }) => source.id === "mummum")).toBe(false);
  });

  test("source validation and identity conflicts leave configuration unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    expect((await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ])).exitCode).toBe(0);
    expect((await runCli([
      "--database", databasePath, "sources", "add", "https://recipes.example", "--id", "recipes",
    ])).exitCode).toBe(0);
    const before = (await runCli(["--database", databasePath, "sources", "list", "--json"])).stdout;

    const duplicateUrl = await runCli([
      "--database", databasePath, "sources", "add", "https://recipes.example/", "--id", "other",
    ]);
    expect(duplicateUrl.exitCode).not.toBe(0);
    expect(duplicateUrl.stderr).toContain("Recipe source URL already exists as recipes");
    expect((await runCli(["--database", databasePath, "sources", "list", "--json"])).stdout).toBe(before);

    const unknown = await runCli(["--database", databasePath, "sources", "disable", "missing"]);
    expect(unknown.exitCode).not.toBe(0);
    expect(unknown.stderr).toContain("Recipe source does not exist: missing");
    expect((await runCli(["--database", databasePath, "sources", "list", "--json"])).stdout).toBe(before);
  });

  test("source reads and invalid adds do not initialize a missing database", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "missing", "family.sqlite");

    const listed = await runCli(["--database", databasePath, "sources", "list", "--json"]);
    expect(listed.exitCode).not.toBe(0);
    expect(await exists(join(root, "missing"))).toBe(false);

    const invalid = await runCli([
      "--database", databasePath, "sources", "add", "file:///etc/passwd", "--adapter", "imaginary",
    ]);
    expect(invalid.exitCode).not.toBe(0);
    expect(await exists(join(root, "missing"))).toBe(false);
  });

  test("setup rejects 51 members before creating database state", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "must-not-exist", "family.sqlite");

    const result = await runCli(["--database", databasePath, "setup", ...memberArguments(51)]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Too big: expected array to have <=50 items");
    expect(await exists(join(root, "must-not-exist"))).toBe(false);
  });

  test("setup rejects 51 members without replacing existing state", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    const initial = await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ]);
    expect(initial.exitCode, initial.stderr).toBe(0);
    const before = await runCli(["--database", databasePath, "family", "show", "--json"]);

    const result = await runCli(["--database", databasePath, "setup", ...memberArguments(51)]);

    expect(result.exitCode).not.toBe(0);
    const after = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(after.stdout).toBe(before.stdout);
  });

  test("family edit rejects a 51st member and preserves all 50 members", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    const setup = await runCli(["--database", databasePath, "setup", ...memberArguments(50)]);
    expect(setup.exitCode, setup.stderr).toBe(0);
    const before = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(JSON.parse(before.stdout).members).toHaveLength(50);

    const result = await runCli([
      "--database", databasePath, "family", "edit",
      "--upsert-member", JSON.stringify({ id: "member-51", name: "Member 51", kind: "adult", servings: 1 }),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Family cannot contain more than 50 members");
    const after = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(after.stdout).toBe(before.stdout);
  });

  test("persists a complete flag-based setup and returns stable JSON in a separate process", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "nested", "family.sqlite");

    const setup = await runCli([
      "--database", databasePath,
      "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
      "--member", JSON.stringify({ id: "sam", name: "Sam, Jr.", kind: "child", servings: 0.75 }),
      "--household-dietary-restriction", "No peanuts, tree nuts; sesame",
      "--household-disliked-ingredient", "Olives, capers; anchovies",
      "--pantry-item", JSON.stringify({ name: "Rice", quantity: "500 g" }),
    ]);
    expect(setup.exitCode, setup.stderr).toBe(0);
    expect(await exists(databasePath)).toBe(true);

    const shown = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    const family = JSON.parse(shown.stdout);
    expect(family.members).toEqual([
      { id: "alex", name: "Alex", kind: "adult", servings: 1 },
      { id: "sam", name: "Sam, Jr.", kind: "child", servings: 0.75 },
    ]);
    expect(family.rules.map(({ id: _, ...rule }: Record<string, unknown>) => rule)).toEqual([
      { memberId: null, kind: "dietary_restriction", value: "No peanuts, tree nuts; sesame" },
      { memberId: null, kind: "disliked_ingredient", value: "Olives, capers; anchovies" },
    ]);
    expect(family.dayProfiles).toHaveLength(7);
    expect(family.preferredStores.map(({ name, dealerId }: { name: string; dealerId: string | null }) => ({ name, dealerId }))).toEqual([
      { name: "REMA 1000", dealerId: null },
      { name: "Netto", dealerId: null },
      { name: "SuperBrugsen", dealerId: null },
    ]);
    expect(shown.stdout).toBe(`${JSON.stringify(family, null, 2)}\n`);

    const human = await runCli(["--database", databasePath, "family", "show"]);
    expect(human.exitCode, human.stderr).toBe(0);
    expect(human.stdout).toContain("Members (2)");
    expect(human.stdout).toContain("Sam, Jr. [sam] · child · 0.75 serving(s)");
    expect(human.stdout).toContain("Preferred stores: REMA 1000, Netto, SuperBrugsen");
    const pantry = await runCli(["--database", databasePath, "pantry", "show", "--json"]);
    expect(JSON.parse(pantry.stdout)).toEqual([
      { normalizedName: "rice", name: "Rice", quantity: "500 g" },
    ]);
  });

  test("edits members and household/member rules atomically across CLI processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    const initial = await runCli([
      "--database", databasePath,
      "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
      "--member", JSON.stringify({ id: "sam", name: "Sam", kind: "child", servings: 0.75 }),
      "--household-dietary-restriction", "Gluten-free",
      "--household-disliked-ingredient", "Fennel",
    ]);
    expect(initial.exitCode, initial.stderr).toBe(0);
    const beforeResult = await runCli(["--database", databasePath, "family", "show", "--json"]);
    const before = JSON.parse(beforeResult.stdout);
    const dietaryRuleId = before.rules.find((rule: { kind: string }) => rule.kind === "dietary_restriction").id;
    const dislikedRuleId = before.rules.find((rule: { kind: string }) => rule.kind === "disliked_ingredient").id;

    const edited = await runCli([
      "--database", databasePath,
      "family", "edit",
      "--upsert-member", JSON.stringify({ id: "alex", name: "Alexandra", kind: "adult", servings: 1.25 }),
      "--upsert-member", JSON.stringify({ id: "jordan", name: "Jordan, Sr.", kind: "adult", servings: 1 }),
      "--remove-member", "sam",
      "--update-rule", JSON.stringify({ id: dietaryRuleId, memberId: null, kind: "dietary_restriction", value: "Gluten and wheat" }),
      "--upsert-rule", JSON.stringify({ memberId: "jordan", kind: "disliked_ingredient", value: "Olives, capers; anchovies" }),
      "--remove-rule", dislikedRuleId,
    ]);
    expect(edited.exitCode, edited.stderr).toBe(0);

    const shown = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    const family = JSON.parse(shown.stdout);
    expect(family.members).toEqual([
      { id: "alex", name: "Alexandra", kind: "adult", servings: 1.25 },
      { id: "jordan", name: "Jordan, Sr.", kind: "adult", servings: 1 },
    ]);
    expect(family.rules.map(({ id: _, ...rule }: Record<string, unknown>) => rule)).toEqual([
      { memberId: null, kind: "dietary_restriction", value: "Gluten and wheat" },
      { memberId: "jordan", kind: "disliked_ingredient", value: "Olives, capers; anchovies" },
    ]);

    const invalid = await runCli([
      "--database", databasePath,
      "family", "edit",
      "--upsert-member", JSON.stringify({ id: "partial", name: "Must Roll Back", kind: "adult", servings: 1 }),
      "--upsert-rule", JSON.stringify({ memberId: "missing", kind: "dietary_restriction", value: "Peanuts" }),
    ]);
    expect(invalid.exitCode).not.toBe(0);
    const afterInvalid = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(afterInvalid.stdout).toBe(shown.stdout);
  });

  test("help does not create a database from the environment override", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "unused", "family.sqlite");

    const result = await runCli(["--help"], { MEALPLAN_DATABASE: databasePath });

    expect(result.exitCode, result.stderr).toBe(0);
    expect(await exists(join(root, "unused"))).toBe(false);
  });

  test("family show on an uninitialized path fails without creating database state", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "uninitialized", "family.sqlite");

    const result = await runCli(["--database", databasePath, "family", "show", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run mealplan setup first");
    expect(await exists(join(root, "uninitialized"))).toBe(false);
  });

  test("family show rejects an existing empty file without modifying it", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "empty.sqlite");
    await writeFile(databasePath, new Uint8Array());
    const before = await readFile(databasePath);

    const result = await runCli(["--database", databasePath, "family", "show", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run mealplan setup first");
    expect(await readFile(databasePath)).toEqual(before);
  });

  test("family show rejects an unrelated SQLite database without modifying its bytes or schema", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "unrelated.sqlite");
    const unrelated = new Database(databasePath, { create: true, strict: true });
    unrelated.exec("CREATE TABLE unrelated_records (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT");
    unrelated.query("INSERT INTO unrelated_records (value) VALUES (?)").run("preserve me");
    unrelated.close();
    const before = await readFile(databasePath);

    const result = await runCli(["--database", databasePath, "family", "show", "--json"]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("Run mealplan setup first");
    expect(await readFile(databasePath)).toEqual(before);
    const reopened = new Database(databasePath, { create: false, strict: true });
    expect(reopened.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all())
      .toEqual([{ name: "unrelated_records" }]);
    expect(reopened.query("SELECT id, value FROM unrelated_records").all())
      .toEqual([{ id: 1, value: "preserve me" }]);
    reopened.close();
  });

  test("invalid flag-based setup exits nonzero and preserves the previous setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "family.sqlite");
    const initial = await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
    ]);
    expect(initial.exitCode, initial.stderr).toBe(0);
    const before = await runCli(["--database", databasePath, "family", "show", "--json"]);

    const invalid = await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "broken", name: "Broken", kind: "adult", servings: 0 }),
    ]);

    expect(invalid.exitCode).not.toBe(0);
    const after = await runCli(["--database", databasePath, "family", "show", "--json"]);
    expect(after.stdout).toBe(before.stdout);
  });

  test("invalid setup validates before creating a database or its parent directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "must-not-exist", "family.sqlite");

    const invalid = await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "broken", name: "Broken", kind: "adult", servings: -1 }),
    ]);

    expect(invalid.exitCode).not.toBe(0);
    expect(await exists(join(root, "must-not-exist"))).toBe(false);
  });

  test("setup validates normalized pantry names before creating database state", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-cli-configuration-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "must-not-exist", "family.sqlite");

    const invalid = await runCli([
      "--database", databasePath, "setup",
      "--member", JSON.stringify({ id: "alex", name: "Alex", kind: "adult", servings: 1 }),
      "--pantry-item", JSON.stringify({ name: "ﬃ".repeat(200), quantity: "1 bag" }),
    ]);

    expect(invalid.exitCode).not.toBe(0);
    expect(await exists(join(root, "must-not-exist"))).toBe(false);
  });
});
