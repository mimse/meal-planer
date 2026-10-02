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

function runCli(args: string[]): Promise<CliResult> {
  return run("src/cli.ts", args);
}

function runFixtureCli(args: string[]): Promise<CliResult> {
  return run("tests/harness/source-cli.ts", args);
}

function expectSuccess(result: CliResult): void {
  expect(result.exitCode, result.stderr).toBe(0);
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(path => rm(path, { recursive: true, force: true })));
});

test("public source commands deterministically discover, sync, archive, and reactivate imported provenance", async () => {
  const root = await mkdtemp(join(tmpdir(), "meal-planer-source-ingestion-cli-"));
  temporaryDirectories.push(root);
  const databasePath = join(root, "mealplan.sqlite");
  const databaseArgs = ["--database", databasePath];

  expectSuccess(await runCli([
    ...databaseArgs,
    "setup",
    "--member", JSON.stringify({ id: "family", name: "Family", kind: "adult", servings: 4 }),
  ]));
  expectSuccess(await runCli([
    ...databaseArgs,
    "sources", "add", FIXTURE_SOURCE_BASE_URL,
    "--id", FIXTURE_SOURCE_ID,
    "--name", "Fixture Recipes",
    "--adapter", "jsonld",
  ]));

  const tested = await runFixtureCli([...databaseArgs, "sources", "test", FIXTURE_SOURCE_ID, "--json"]);
  expectSuccess(tested);
  expect(JSON.parse(tested.stdout)).toMatchObject({
    sourceId: FIXTURE_SOURCE_ID,
    count: FIXTURE_RECIPE_COUNT,
    capped: false,
  });

  const synced = await runFixtureCli([
    ...databaseArgs, "sources", "sync", FIXTURE_SOURCE_ID, "--limit", String(FIXTURE_RECIPE_COUNT), "--json",
  ]);
  expectSuccess(synced);
  expect(JSON.parse(synced.stdout)).toMatchObject({
    totals: { sources: 1, discovered: FIXTURE_RECIPE_COUNT, attempted: FIXTURE_RECIPE_COUNT, imported: FIXTURE_RECIPE_COUNT, failed: 0 },
  });

  const searched = await runCli([
    ...databaseArgs, "recipes", "search", "--source", FIXTURE_SOURCE_ID, "--limit", "20", "--json",
  ]);
  expectSuccess(searched);
  const recipes = JSON.parse(searched.stdout);
  expect(recipes).toHaveLength(FIXTURE_RECIPE_COUNT);
  expect(recipes[0]).toMatchObject({
    sourceId: FIXTURE_SOURCE_ID,
    title: "Fixture Recipe 1",
    sourceUrl: `${FIXTURE_SOURCE_BASE_URL}1`,
    servings: 4,
    totalMinutes: 25,
    dietaryTags: ["vegetarian"],
    ingredients: [
      { rawText: "100 g carrots", normalizedName: "carrots", quantity: 100, unit: "g", uncertain: false },
      { rawText: "1 tomatoes", normalizedName: null, quantity: null, unit: null, uncertain: true },
    ],
  });

  expectSuccess(await runCli([...databaseArgs, "sources", "disable", FIXTURE_SOURCE_ID]));
  const disabledSync = await runFixtureCli([...databaseArgs, "sources", "sync", FIXTURE_SOURCE_ID, "--json"]);
  expect(disabledSync.exitCode).not.toBe(0);
  expect(disabledSync.stderr).toContain(`Recipe source is disabled: ${FIXTURE_SOURCE_ID}`);
  expectSuccess(await runCli([...databaseArgs, "sources", "enable", FIXTURE_SOURCE_ID]));

  const removed = await runCli([...databaseArgs, "sources", "remove", FIXTURE_SOURCE_ID]);
  expectSuccess(removed);
  expect(removed.stdout).toContain(`Recipe source archived: ${FIXTURE_SOURCE_ID}.`);

  const listed = await runCli([...databaseArgs, "sources", "list", "--json"]);
  expectSuccess(listed);
  expect(JSON.parse(listed.stdout).some((source: { id: string }) => source.id === FIXTURE_SOURCE_ID)).toBe(false);

  const shown = await runCli([...databaseArgs, "recipes", "show", recipes[0].id, "--json"]);
  expectSuccess(shown);
  expect(JSON.parse(shown.stdout)).toMatchObject({ id: recipes[0].id, sourceId: FIXTURE_SOURCE_ID });

  const readded = await runCli([
    ...databaseArgs,
    "sources", "add", FIXTURE_SOURCE_BASE_URL,
    "--id", FIXTURE_SOURCE_ID,
    "--name", "Fixture Recipes",
    "--adapter", "jsonld",
  ]);
  expectSuccess(readded);
  const relisted = await runCli([...databaseArgs, "sources", "list", "--json"]);
  expectSuccess(relisted);
  expect(JSON.parse(relisted.stdout).some((source: { id: string; enabled: boolean }) =>
    source.id === FIXTURE_SOURCE_ID && source.enabled)).toBe(true);
}, 30_000);
