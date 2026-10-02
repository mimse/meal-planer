import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../../src/infrastructure/database";
import { shoppingFixture, shoppingRecipe } from "../helpers/shopping-fixture";
import { createRecipeRepository } from "../../src/infrastructure/recipe-repository";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const root = new URL("../..", import.meta.url).pathname;
async function cli(args: string[]) {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], { cwd: root, env: process.env, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}

test("shopping-list renders grouped accepted-plan groceries with clean JSON across processes", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mealplan-shopping-cli-"));
  directories.push(directory);
  const databasePath = join(directory, "mealplan.sqlite");
  const { database, repository, draft } = shoppingFixture(openDatabase(databasePath));
  const accepted = repository.accept(draft.id, "2026-10-02T11:00:00.000Z");
  const before = database.query("SELECT * FROM plan_meals ORDER BY id").all();
  database.close();
  const result = await cli(["--database", databasePath, "shopping-list", "--week", "2026-10-05", "--no-deals", "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const list = JSON.parse(result.stdout);
  expect(list.planId).toBe(accepted.id);
  expect(list.meals).toHaveLength(7);
  expect(list.items.find((item: { normalizedIngredient: string }) => item.normalizedIngredient === "carrots").purchaseQuantity).toBe(600);
  expect(result.stderr).toContain("Offline (--no-deals)");
  const human = await cli(["--database", databasePath, "shopping-list", "--week", "2026-10-05", "--no-deals"]);
  expect(human.exitCode, human.stderr).toBe(0);
  expect(human.stdout).toContain("Regular-price / unmatched");
  expect(human.stdout).toContain("600 g");
  expect(human.stdout).toContain("100 g carrots");
  expect(human.stdout).toContain("https://mummum.dk/shopping-0/");
  expect(human.stdout).toContain("not a checkout total");
  const reopened = openDatabase(databasePath);
  expect(reopened.query("SELECT * FROM plan_meals ORDER BY id").all()).toEqual(before);
  reopened.close();
}, 15_000);

test("shopping-list refuses drafts until acceptance then reflects one confirmed replacement", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mealplan-shopping-replace-"));
  directories.push(directory);
  const databasePath = join(directory, "mealplan.sqlite");
  const { database, draft, recipes } = shoppingFixture(openDatabase(databasePath));
  database.close();
  const beforeAcceptance = await cli(["--database", databasePath, "shopping-list", "--week", draft.weekStart, "--no-deals", "--json"]);
  expect(beforeAcceptance.exitCode).toBe(1);
  expect(beforeAcceptance.stdout).toBe("");
  expect(beforeAcceptance.stderr).toContain("No accepted plan");
  const accepted = await cli(["--database", databasePath, "plan", "accept", "--week", draft.weekStart, "--json"]);
  expect(accepted.exitCode, accepted.stderr).toBe(0);
  const replacement = await cli(["--database", databasePath, "plan", "replace", "tue", "--week", draft.weekStart,
    "--with", recipes[7]!.id, "--yes", "--no-deals", "--json"]);
  expect(replacement.exitCode, replacement.stderr).toBe(0);
  const groceries = await cli(["--database", databasePath, "shopping-list", "--week", draft.weekStart, "--no-deals", "--json"]);
  expect(groceries.exitCode, groceries.stderr).toBe(0);
  const list = JSON.parse(groceries.stdout);
  expect(list.items.find((item: { normalizedIngredient: string }) => item.normalizedIngredient === "carrots").purchaseQuantity).toBe(500);
  expect(list.items.find((item: { normalizedIngredient: string }) => item.normalizedIngredient === "beans").purchaseQuantity).toBe(100);
  expect(list.meals.find((meal: { day: string }) => meal.day === "tue").recipeId).toBe(recipes[7]!.id);
  expect(JSON.parse(replacement.stdout).meals.filter((meal: { day: string }) => meal.day !== "tue"))
    .toEqual(JSON.parse(accepted.stdout).meals.filter((meal: { day: string }) => meal.day !== "tue"));
}, 15_000);

test("shopping-list invalid date, repeated week and contradictory refresh flags fail before SQLite opens", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mealplan-shopping-invalid-"));
  directories.push(directory);
  const databasePath = join(directory, "absent", "mealplan.sqlite");
  for (const args of [["--week", "2026-02-30"], ["--week", "2026-10-05", "--week", "2026-10-12"], ["--no-deals", "--refresh-deals"]]) {
    const result = await cli(["--database", databasePath, "shopping-list", ...args]);
    expect(result.exitCode).toBe(1);
    expect(result.stdout).toBe("");
    await expect(stat(join(directory, "absent"))).rejects.toThrow();
  }
}, 15_000);

test("shopping provider input rejection preserves unquantified ingredients and clean offline JSON", async () => {
  const directory = await mkdtemp(join(tmpdir(), "mealplan-shopping-fallback-"));
  directories.push(directory);
  const databasePath = join(directory, "mealplan.sqlite");
  const { database, repository, draft } = shoppingFixture(openDatabase(databasePath));
  repository.accept(draft.id, "2026-10-02T11:00:00.000Z");
  createRecipeRepository(database).import({ ...shoppingRecipe(0), ingredients: [{ rawText: "salt to taste", normalizedName: null, quantity: null, unit: null, uncertain: true },
    { rawText: "100000000 g carrots", normalizedName: "carrots", quantity: 100_000_000, unit: "g", uncertain: false } ] });
  database.close();
  const result = await cli(["--database", databasePath, "shopping-list", "--week", draft.weekStart, "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const list = JSON.parse(result.stdout);
  expect(list.items.some((item: { purchaseQuantity: number | null }) => item.purchaseQuantity === null)).toBe(true);
  expect(list.warnings.join(" ")).toContain("offline");
  expect(result.stderr).toContain("offline");
}, 15_000);
