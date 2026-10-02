import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FIXTURE_RECIPE_COUNT,
  FIXTURE_SOURCE_BASE_URL,
  FIXTURE_SOURCE_ID,
} from "./support/fixture-recipe-transport";

const projectRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];
type CliResult = { exitCode: number; stdout: string; stderr: string };

async function run(entrypoint: string, args: string[]): Promise<CliResult> {
  const child = Bun.spawn(["bun", "run", entrypoint, ...args], {
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

const cli = (args: string[]) => run("src/cli.ts", args);
const fixtureCli = (args: string[]) => run("tests/harness/source-cli.ts", args);
function expectSuccess(result: CliResult): void {
  expect(result.exitCode, result.stderr).toBe(0);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("fresh public CLI workflow ingests recipes, plans, accepts, replaces Tuesday, and builds groceries", async () => {
  const root = await mkdtemp(join(tmpdir(), "meal-planer-public-acceptance-"));
  temporaryDirectories.push(root);
  const databasePath = join(root, "mealplan.sqlite");
  const db = ["--database", databasePath];

  expectSuccess(await cli([
    ...db, "setup",
    "--member", JSON.stringify({ id: "family", name: "Family", kind: "adult", servings: 4 }),
    "--pantry-item", JSON.stringify({ name: "Carrots", quantity: "100 g" }),
  ]));
  expectSuccess(await cli([
    ...db, "sources", "add", FIXTURE_SOURCE_BASE_URL,
    "--id", FIXTURE_SOURCE_ID, "--name", "Fixture Recipes", "--adapter", "jsonld",
  ]));

  const sourceTest = await fixtureCli([...db, "sources", "test", FIXTURE_SOURCE_ID, "--json"]);
  expectSuccess(sourceTest);
  expect(JSON.parse(sourceTest.stdout).count).toBe(FIXTURE_RECIPE_COUNT);

  const sourceSync = await fixtureCli([
    ...db, "sources", "sync", FIXTURE_SOURCE_ID, "--limit", String(FIXTURE_RECIPE_COUNT), "--json",
  ]);
  expectSuccess(sourceSync);
  expect(JSON.parse(sourceSync.stdout).totals).toEqual({
    sources: 1,
    discovered: FIXTURE_RECIPE_COUNT,
    attempted: FIXTURE_RECIPE_COUNT,
    imported: FIXTURE_RECIPE_COUNT,
    failed: 0,
  });

  const search = await cli([...db, "recipes", "search", "--source", FIXTURE_SOURCE_ID, "--limit", "20", "--json"]);
  expectSuccess(search);
  const importedRecipes = JSON.parse(search.stdout) as Array<{ id: string; title: string; sourceUrl: string }>;
  expect(importedRecipes).toHaveLength(FIXTURE_RECIPE_COUNT);

  const inspected = await cli([...db, "recipes", "show", importedRecipes[0]!.id, "--json"]);
  expectSuccess(inspected);
  expect(JSON.parse(inspected.stdout)).toMatchObject({
    id: importedRecipes[0]!.id,
    sourceId: FIXTURE_SOURCE_ID,
    sourceUrl: `${FIXTURE_SOURCE_BASE_URL}1`,
    rawSourcePayload: { "@type": "Recipe", name: "Fixture Recipe 1" },
  });

  for (const recipe of importedRecipes) {
    const reviewed = await cli([
      ...db, "recipes", "review", recipe.id,
      "--suitability-tag", "quick",
      "--suitability-tag", "keepWarm",
      "--suitability-tag", "reheatFriendly",
      "--suitability-tag", "batchCook",
      "--extra-meal-servings", "4",
      "--mark-reviewed",
      "--json",
    ]);
    expectSuccess(reviewed);
    expect(JSON.parse(reviewed.stdout)).toMatchObject({
      id: recipe.id,
      suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook"],
      extraMealServings: 4,
      needsReview: false,
    });
  }

  const created = await cli([
    ...db, "plan", "create", "--week", "2026-10-05", "--seed", "phase-7-acceptance", "--no-deals", "--json",
  ]);
  expectSuccess(created);
  const draft = JSON.parse(created.stdout);
  expect(draft).toMatchObject({ weekStart: "2026-10-05", shoppingDate: "2026-10-03", status: "draft" });
  expect(draft.meals).toHaveLength(7);
  expect(draft.meals.every((meal: { recipeId: string }) => importedRecipes.some(recipe => recipe.id === meal.recipeId))).toBe(true);

  const acceptedResult = await cli([...db, "plan", "accept", "--week", "2026-10-05", "--json"]);
  expectSuccess(acceptedResult);
  const accepted = JSON.parse(acceptedResult.stdout);
  expect(accepted.status).toBe("accepted");

  const unassigned = importedRecipes.find(recipe =>
    !accepted.meals.some((meal: { recipeId: string }) => meal.recipeId === recipe.id));
  expect(unassigned).toBeDefined();
  const replacedResult = await cli([
    ...db, "plan", "replace", "tue", "--week", "2026-10-05",
    "--with", unassigned!.id, "--yes", "--rejection", "not-this-week", "--no-deals", "--json",
  ]);
  expectSuccess(replacedResult);
  const replaced = JSON.parse(replacedResult.stdout);
  expect(replaced.meals.find((meal: { day: string }) => meal.day === "tue").recipeId).toBe(unassigned!.id);
  expect(replaced.meals.filter((meal: { day: string }) => meal.day !== "tue"))
    .toEqual(accepted.meals.filter((meal: { day: string }) => meal.day !== "tue"));

  const shoppingResult = await cli([
    ...db, "shopping-list", "--week", "2026-10-05", "--no-deals", "--json",
  ]);
  expectSuccess(shoppingResult);
  const shopping = JSON.parse(shoppingResult.stdout);
  expect(shopping.planId).toBe(replaced.id);
  expect(shopping.meals).toHaveLength(7);
  expect(shopping.meals.find((meal: { day: string }) => meal.day === "tue").recipeId).toBe(unassigned!.id);
  const contributions = shopping.items.flatMap((item: { contributions: Array<{
    kind: string;
    mealId: string;
    sourceUrl: string;
    rawText: string;
  }> }) => item.contributions).filter((contribution: { kind: string }) => contribution.kind === "recipe");
  expect(contributions).toHaveLength(14);
  for (const meal of shopping.meals as Array<{ id: string; sourceUrl: string }>) {
    const recipeNumber = Number(new URL(meal.sourceUrl).pathname.split("/").at(-1));
    expect(contributions
      .filter((contribution: { mealId: string }) => contribution.mealId === meal.id)
      .map((contribution: { rawText: string }) => contribution.rawText)
      .sort()).toEqual([`${recipeNumber} tomatoes`, "100 g carrots"].sort());
  }
  expect(shopping.warnings.join("\n")).toContain("Offline (--no-deals)");
}, 45_000);
