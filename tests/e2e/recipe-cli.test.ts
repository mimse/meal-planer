import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { exists, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";
import { migrations, runMigrations } from "../../src/infrastructure/migrations";

const projectRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: projectRoot,
    env: process.env,
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

function recipeInput(): RecipeImport {
  return {
    sourceId: "example",
    sourceUrl: "https://recipes.example/soup",
    canonicalUrl: "https://recipes.example/soup",
    title: "Tomato Soup",
    author: "Test Author",
    servings: null,
    prepMinutes: null,
    cookMinutes: null,
    totalMinutes: null,
    cuisineTags: [],
    proteinTag: null,
    dietaryTags: ["vegetarian"],
    suitabilityTags: [],
    extraMealServings: 0,
    preference: "neutral",
    needsReview: true,
    parserVersion: "jsonld@1",
    fetchedAt: "2026-09-28T12:00:00.000Z",
    rawSourcePayload: { name: "Tomato Soup" },
    sourceEvidence: { adapter: "jsonld" },
    ingredients: [{ rawText: "2 tomatoes", normalizedName: "2 tomatoes", quantity: null, unit: null, uncertain: true }],
    instructions: ["Chop.", "Cook."],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recipe CLI", () => {
  test("searches, shows, and reviews a persisted recipe across separate processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-recipe-cli-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "mealplan.sqlite");
    const database = openDatabase(databasePath);
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "example", name: "Example", baseUrl: "https://recipes.example/", adapter: "jsonld", enabled: true,
    });
    const original = createRecipeRepository(database).import(recipeInput());
    database.close();

    const searched = await runCli([
      "--database", databasePath, "recipes", "search", "tomato",
      "--source", "example", "--tag", "vegetarian", "--needs-review", "--limit", "10", "--json",
    ]);
    expect(searched.exitCode, searched.stderr).toBe(0);
    expect(JSON.parse(searched.stdout)).toEqual([original]);

    const shown = await runCli(["--database", databasePath, "recipes", "show", original.id, "--json"]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(original);
    expect(JSON.parse(shown.stdout).instructions).toEqual(["Chop.", "Cook."]);

    const reviewed = await runCli([
      "--database", databasePath, "recipes", "review", original.id,
      "--dietary-tag", "vegetarian",
      "--suitability-tag", "quick",
      "--cuisine-tag", "Danish",
      "--protein-tag", "legume",
      "--preference", "favorite",
      "--servings", "4",
      "--prep-minutes", "10",
      "--cook-minutes", "20",
      "--total-minutes", "30",
      "--mark-reviewed", "--json",
    ]);
    expect(reviewed.exitCode, reviewed.stderr).toBe(0);
    expect(JSON.parse(reviewed.stdout)).toMatchObject({
      id: original.id,
      dietaryTags: ["vegetarian"],
      suitabilityTags: ["quick"],
      cuisineTags: ["danish"],
      proteinTag: "legume",
      preference: "favorite",
      servings: 4,
      prepMinutes: 10,
      cookMinutes: 20,
      totalMinutes: 30,
      needsReview: false,
    });

    const pending = await runCli([
      "--database", databasePath, "recipes", "search", "--needs-review", "--json",
    ]);
    expect(pending.exitCode, pending.stderr).toBe(0);
    expect(JSON.parse(pending.stdout)).toEqual([]);

    const cleared = await runCli([
      "--database", databasePath, "recipes", "review", original.id,
      "--clear-dietary-tags",
      "--clear-suitability-tags",
      "--clear-cuisine-tags",
      "--clear-protein-tag",
      "--clear-servings",
      "--clear-prep-minutes",
      "--clear-cook-minutes",
      "--clear-total-minutes",
      "--json",
    ]);
    expect(cleared.exitCode, cleared.stderr).toBe(0);
    expect(JSON.parse(cleared.stdout)).toMatchObject({
      dietaryTags: [],
      suitabilityTags: [],
      cuisineTags: [],
      proteinTag: null,
      servings: null,
      prepMinutes: null,
      cookMinutes: null,
      totalMinutes: null,
      preference: "favorite",
      needsReview: true,
    });
  });

  test("validates every recipe command syntax before a version-one database can be migrated", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-preopen-cli-"));
    temporaryDirectories.push(root);
    const recipeId = `recipe:${"0".repeat(64)}`;
    const invalidCommands: string[][] = [
      ["recipes", "import", "not-a-url"],
      ["recipes", "import", "ftp://recipes.example/recipe"],
      ["recipes", "import", "https://user:secret@recipes.example/recipe"],
      ["recipes", "import", "https://recipes.example/recipe#step"],
      ["recipes", "import", "https://recipes.example/%zz"],
      ["recipes", "show", "not-a-recipe-id"],
      ["recipes", "review", "not-a-recipe-id", "--preference", "favorite"],
      ["recipes", "search", "x".repeat(501)],
      ["recipes", "search", "--source", "bad id"],
      ["recipes", "search", "--tag", "imaginary"],
      ["recipes", "search", "--limit", "0"],
      ["recipes", "review", recipeId, "--dietary-tag", "vegetarian", "--dietary-tag", "vegetarian"],
      ["recipes", "review", recipeId, "--suitability-tag", "quick", "--suitability-tag", "quick"],
      ["recipes", "review", recipeId, "--cuisine-tag", "Danish Food", "--cuisine-tag", "danish-food"],
      ["recipes", "review", recipeId, "--cuisine-tag", "!!!"],
      ["recipes", "review", recipeId, "--protein-tag", "!!!"],
      ["recipes", "review", recipeId, "--preference", "unknown"],
      ["recipes", "review", recipeId, "--servings", "0"],
      ["recipes", "review", recipeId, "--prep-minutes", "-1"],
      ["recipes", "review", recipeId, "--servings", "4", "--servings", "5"],
      ["recipes", "review", recipeId, "--preference", "favorite", "--preference", "disliked"],
      ["recipes", "review", recipeId, "--protein-tag", "pork", "--protein-tag", "fish"],
      ["recipes", "review", recipeId, "--prep-minutes", "10", "--prep-minutes", "20"],
      ["recipes", "review", recipeId, "--cook-minutes", "10", "--cook-minutes", "20"],
      ["recipes", "review", recipeId, "--total-minutes", "10", "--total-minutes", "20"],
      ["recipes", "review", recipeId, "--clear-servings", "--mark-reviewed"],
      ["recipes", "review", recipeId, "--clear-dietary-tags", "--mark-reviewed"],
      [
        "recipes", "review", recipeId, "--clear-prep-minutes", "--clear-cook-minutes",
        "--clear-total-minutes", "--mark-reviewed",
      ],
      ["recipes", "review", recipeId, "--dietary-tag", "vegetarian", "--clear-dietary-tags"],
      ["recipes", "review", recipeId, "--suitability-tag", "quick", "--clear-suitability-tags"],
      ["recipes", "review", recipeId, "--cuisine-tag", "danish", "--clear-cuisine-tags"],
      ["recipes", "review", recipeId, "--protein-tag", "pork", "--clear-protein-tag"],
      ["recipes", "review", recipeId, "--servings", "4", "--clear-servings"],
      ["recipes", "review", recipeId, "--prep-minutes", "10", "--clear-prep-minutes"],
      ["recipes", "review", recipeId, "--cook-minutes", "10", "--clear-cook-minutes"],
      ["recipes", "review", recipeId, "--total-minutes", "10", "--clear-total-minutes"],
    ];

    for (const [index, command] of invalidCommands.entries()) {
      const databasePath = join(root, `version-one-${index}.sqlite`);
      const versionOne = new Database(databasePath, { create: true, strict: true });
      versionOne.exec("PRAGMA foreign_keys = ON");
      runMigrations(versionOne, [migrations[0]!]);
      versionOne.close();
      const before = await readFile(databasePath);

      const result = await runCli(["--database", databasePath, ...command]);

      expect(result.exitCode, `${command.join(" ")}\n${result.stderr}`).not.toBe(0);
      expect(await readFile(databasePath), command.join(" ")).toEqual(before);
      const unchanged = new Database(databasePath, { create: false, strict: true });
      expect(unchanged.query("SELECT version, name FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1, name: "initial configuration" }]);
      expect(unchanged.query("SELECT name FROM sqlite_master WHERE name IN ('recipes', 'http_cache')").all())
        .toEqual([]);
      unchanged.close();
    }
  }, 30_000);

  test("rejects lossy raw import URL paths before opening a version-one database", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-raw-url-cli-"));
    temporaryDirectories.push(root);
    const unsafeUrls = [
      "https://custom.example/recipes/a/%2e%2e/safe",
      "https://custom.example/recipes\\safe",
    ];

    for (const [index, url] of unsafeUrls.entries()) {
      const databasePath = join(root, `version-one-${index}.sqlite`);
      const versionOne = new Database(databasePath, { create: true, strict: true });
      versionOne.exec("PRAGMA foreign_keys = ON");
      runMigrations(versionOne, [migrations[0]!]);
      versionOne.close();
      const before = await readFile(databasePath);

      const result = await runCli([
        "--database", databasePath, "recipes", "import", url, "--source", "custom",
      ]);

      expect(result.exitCode, result.stderr).not.toBe(0);
      expect(await readFile(databasePath), url).toEqual(before);
      const unchanged = new Database(databasePath, { create: false, strict: true });
      expect(unchanged.query("SELECT version, name FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1, name: "initial configuration" }]);
      expect(unchanged.query("SELECT name FROM sqlite_master WHERE name IN ('recipes', 'http_cache')").all())
        .toEqual([]);
      unchanged.close();
    }
  });

  test("rejects duplicate singleton recipe options before opening a version-one database", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-duplicate-option-cli-"));
    temporaryDirectories.push(root);
    const duplicateCommands = [
      ["sources", "sync", "--limit", "1", "--limit", "2"],
      ["recipes", "search", "--source", "one", "--source", "two"],
      ["recipes", "search", "--tag", "vegan", "--tag", "vegetarian"],
      ["recipes", "search", "--limit", "1", "--limit", "2"],
      [
        "recipes", "import", "https://recipes.example/recipe",
        "--source", "one", "--source", "two",
      ],
    ];

    for (const [index, command] of duplicateCommands.entries()) {
      const databasePath = join(root, `version-one-${index}.sqlite`);
      const versionOne = new Database(databasePath, { create: true, strict: true });
      versionOne.exec("PRAGMA foreign_keys = ON");
      runMigrations(versionOne, [migrations[0]!]);
      versionOne.close();
      const before = await readFile(databasePath);

      const result = await runCli(["--database", databasePath, ...command]);

      expect(result.exitCode, `${command.join(" ")}\n${result.stderr}`).not.toBe(0);
      expect(result.stderr).toContain("may be specified only once");
      expect(await readFile(databasePath), command.join(" ")).toEqual(before);
      const unchanged = new Database(databasePath, { create: false, strict: true });
      expect(unchanged.query("SELECT version, name FROM schema_migrations ORDER BY version").all())
        .toEqual([{ version: 1, name: "initial configuration" }]);
      expect(unchanged.query("SELECT name FROM sqlite_master WHERE name IN ('recipes', 'http_cache')").all())
        .toEqual([]);
      unchanged.close();
    }
  });

  test("validates source, tag, limit, exact IDs, and read-only missing database behavior", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-recipe-cli-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "missing", "mealplan.sqlite");
    const missing = await runCli(["--database", databasePath, "recipes", "search", "--json"]);
    expect(missing.exitCode).not.toBe(0);
    expect(missing.stderr).toContain("Run mealplan setup first");
    expect(await exists(join(root, "missing"))).toBe(false);

    const initialized = openDatabase(join(root, "mealplan.sqlite"));
    initialized.close();
    const path = join(root, "mealplan.sqlite");
    const badTag = await runCli(["--database", path, "recipes", "search", "--tag", "imaginary"]);
    expect(badTag.exitCode).not.toBe(0);
    expect(badTag.stderr).toContain("Unsupported dietary tag: imaginary");
    const badLimit = await runCli(["--database", path, "recipes", "search", "--limit", "0"]);
    expect(badLimit.exitCode).not.toBe(0);
    expect(badLimit.stderr).toContain("positive integer between 1 and 100");
    const missingRecipe = await runCli([
      "--database", path, "recipes", "show", `recipe:${"0".repeat(64)}`, "--json",
    ]);
    expect(missingRecipe.exitCode).not.toBe(0);
    expect(missingRecipe.stderr).toContain(`Recipe does not exist: recipe:${"0".repeat(64)}`);
  });

  test("import and sync keep production URL safety and return nonzero without partial false success", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-recipe-cli-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "mealplan.sqlite");
    const database = openDatabase(databasePath);
    createConfigurationRepositories(database).recipeSources.upsert({
      id: "private",
      name: "Private",
      baseUrl: "http://127.0.0.1/",
      adapter: "jsonld",
      enabled: true,
    });
    database.close();

    const imported = await runCli([
      "--database", databasePath, "recipes", "import", "http://127.0.0.1/recipe",
      "--source", "private", "--json",
    ]);
    expect(imported.exitCode).not.toBe(0);
    expect(imported.stderr).toContain("not publicly routable");

    const synced = await runCli([
      "--database", databasePath, "sources", "sync", "private", "--limit", "1", "--json",
    ]);
    expect(synced.exitCode).not.toBe(0);
    const report = JSON.parse(synced.stdout);
    expect(report.totals).toEqual({ sources: 1, discovered: 0, attempted: 0, imported: 0, failed: 0 });
    expect(report.sources[0].status).toBe("failed");
    expect(report.sources[0].failures[0].error).toContain("not publicly routable");

    const reopened = openDatabase(databasePath);
    expect(createRecipeRepository(reopened).list()).toEqual([]);
    reopened.close();
  });

  test("help exposes import, search, show, review, and sync without database side effects", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-recipe-cli-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "unused", "mealplan.sqlite");
    const recipesHelp = await runCli(["--database", databasePath, "recipes", "--help"]);
    const sourcesHelp = await runCli(["--database", databasePath, "sources", "--help"]);
    expect(recipesHelp.exitCode, recipesHelp.stderr).toBe(0);
    for (const command of ["search", "show", "import", "review"]) expect(recipesHelp.stdout).toContain(command);
    expect(sourcesHelp.exitCode, sourcesHelp.stderr).toBe(0);
    expect(sourcesHelp.stdout).toContain("sync");
    expect(await exists(join(root, "unused"))).toBe(false);
  });
});
