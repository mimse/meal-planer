import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { openDatabase } from "../../src/infrastructure/database";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";
import { createPlanDraft } from "../../src/application/create-plan";

const projectRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

async function runCli(args: string[]) {
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

function input(index: number): RecipeImport {
  return {
    sourceId: "mummum",
    sourceUrl: `https://mummum.dk/cli-${index}/`,
    canonicalUrl: `https://mummum.dk/cli-${index}/`,
    title: `CLI recipe ${index}`,
    author: "Test",
    servings: 4,
    prepMinutes: 10,
    cookMinutes: 15,
    totalMinutes: 25,
    cuisineTags: ["danish"],
    proteinTag: index % 2 === 0 ? "legume" : "chicken",
    dietaryTags: index === 0 ? ["vegetarian"] : ["low-salt"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook"],
    extraMealServings: 4,
    preference: "neutral",
    needsReview: false,
    parserVersion: "test@1",
    fetchedAt: "2026-10-01T10:00:00.000Z",
    rawSourcePayload: { index },
    sourceEvidence: { adapter: "test" },
    ingredients: [{ rawText: "100 g carrots", normalizedName: "carrots", quantity: 100, unit: "g", uncertain: false }],
    instructions: ["Cook."],
  };
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("plan CLI", () => {
  test("creates explicit future prep links through the CLI", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-prep-cli-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "mealplan.sqlite");
    const database = openDatabase(databasePath);
    applySetup(database, createSetupConfiguration({ members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }] }));
    const repository = createRecipeRepository(database);
    const recipes = Array.from({ length: 8 }, (_, index) => repository.import(input(index)));
    const future = createPlanDraft(database, { week: "2026-10-12", seed: "future", plannedAt: "2026-10-01T12:00:00.000Z" });
    for (let index = 0; index < 8; index += 1) repository.import({ ...input(index), extraMealServings: 0, suitabilityTags: index === 7 ? ["prepAhead"] : ["quick", "keepWarm", "reheatFriendly"] });
    database.close();
    const linked = await runCli(["--database", databasePath, "recipes", "prep-link", recipes[7]!.id, "--target-meal", future.meals[0]!.id, "--ingredient", "carrots", "--quantity", "50", "--unit", "g", "--note", "Prep carrots", "--json"]);
    expect(linked.exitCode, linked.stderr).toBe(0);
    const link = JSON.parse(linked.stdout);
    const created = await runCli(["--database", databasePath, "plan", "create", "--week", "2026-10-05", "--seed", "prep", "--no-deals", "--json"]);
    expect(created.exitCode, created.stderr).toBe(0);
    expect(JSON.parse(created.stdout).meals[6].prepLinks).toEqual([link.id]);
  }, 15_000);

  test("creates, shows, and accepts a deterministic weekly plan across processes", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-plan-cli-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "mealplan.sqlite");
    const database = openDatabase(databasePath);
    applySetup(database, createSetupConfiguration({
      members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }],
    }));
    const recipes = createRecipeRepository(database);
    Array.from({ length: 8 }, (_, index) => recipes.import(input(index)));
    database.close();

    const created = await runCli([
      "--database", databasePath, "plan", "create",
      "--week", "2026-10-07", "--seed", "cli-seed", "--no-deals", "--json",
    ]);
    expect(created.exitCode, created.stderr).toBe(0);
    const draft = JSON.parse(created.stdout);
    expect(draft.weekStart).toBe("2026-10-05");
    expect(draft.status).toBe("draft");
    expect(draft.meals).toHaveLength(7);
    expect(draft.score.warnings.join("\n")).toContain("Deal lookup disabled");

    const shown = await runCli([
      "--database", databasePath, "plan", "show", "--week", "2026-10-05", "--json",
    ]);
    expect(shown.exitCode, shown.stderr).toBe(0);
    expect(JSON.parse(shown.stdout)).toEqual(draft);

    const accepted = await runCli([
      "--database", databasePath, "plan", "accept", "--week", "2026-10-05", "--json",
    ]);
    expect(accepted.exitCode, accepted.stderr).toBe(0);
    expect(JSON.parse(accepted.stdout)).toEqual({ ...draft, status: "accepted" });
  });

  test("help exposes create, show, and accept without creating a database", async () => {
    const directory = await mkdtemp(join(tmpdir(), "meal-planer-plan-help-"));
    temporaryDirectories.push(directory);
    const databasePath = join(directory, "missing", "mealplan.sqlite");
    const result = await runCli(["--database", databasePath, "plan", "--help"]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stdout).toContain("create");
    expect(result.stdout).toContain("show");
    expect(result.stdout).toContain("accept");
    expect(result.stdout).toContain("replace");
    expect(result.stdout).toContain("lock");
    expect(result.stdout).toContain("unlock");
  });
});
