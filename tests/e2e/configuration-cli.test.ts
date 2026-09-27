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
});
