import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { DAYS, scoreWeeklyRecipes } from "../../src/domain/planner";
import { openDatabase } from "../../src/infrastructure/database";
import { createPlanRepository } from "../../src/infrastructure/plan-repository";
import { createRecipeRepository, type RecipeImport } from "../../src/infrastructure/recipe-repository";

const root = new URL("../..", import.meta.url).pathname;
const directories: string[] = [];
async function runCli(path: string, args: string[]) {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", "--database", path, "plan", ...args], {
    cwd: root, env: process.env, stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  return { exitCode, stdout, stderr };
}
function input(index: number): RecipeImport {
  return {
    sourceId: "mummum", sourceUrl: `https://mummum.dk/edit-cli-${index}/`, canonicalUrl: `https://mummum.dk/edit-cli-${index}/`,
    title: `Edit recipe ${index}`, author: null, servings: 4, prepMinutes: 10, cookMinutes: 15, totalMinutes: 25,
    cuisineTags: ["danish"], proteinTag: "legume", dietaryTags: ["vegetarian", "low-salt"],
    suitabilityTags: ["quick", "keepWarm", "reheatFriendly", "batchCook"], extraMealServings: 4,
    preference: "neutral", needsReview: false, parserVersion: "test@1", fetchedAt: "2026-10-01T10:00:00.000Z",
    rawSourcePayload: { index }, sourceEvidence: {},
    ingredients: [{ rawText: `100 g ${index === 7 ? "beans" : "carrots"}`, normalizedName: index === 7 ? "beans" : "carrots", quantity: 100, unit: "g", uncertain: false }], instructions: ["Cook"],
  };
}
async function fixture() {
  const directory = await mkdtemp(join(tmpdir(), "mealplan-edit-cli-"));
  directories.push(directory);
  const path = join(directory, "mealplan.sqlite");
  const db = openDatabase(path);
  applySetup(db, createSetupConfiguration({ members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }] }));
  const recipes = Array.from({ length: 10 }, (_, index) => createRecipeRepository(db).import(input(index)));
  const score = scoreWeeklyRecipes(recipes.slice(0, 7), { householdServings: 4, pantryItems: [], packageEstimates: [], dealSignals: [], preferredStoreIds: new Set(), shoppingDate: "2026-10-03", recentRecipeIds: new Set() });
  const plan = createPlanRepository(db).saveDraft({ weekStart: "2026-10-05", shoppingDate: "2026-10-03", plannedAt: "2026-10-01T12:00:00.000Z", seed: "edit-cli", score,
    meals: DAYS.map((day, index) => ({ day, date: `2026-10-${String(5 + index).padStart(2, "0")}`, recipeId: recipes[index]!.id, servings: day === "sun" ? 8 : 4, rationale: [`fits ${day}`], prepLinks: [] })),
  });
  db.close();
  return { path, plan, recipes };
}
function snapshot(path: string) {
  const db = openDatabase(path);
  try { return {
    plan: createPlanRepository(db).getForWeek("2026-10-05"),
    meals: db.query<Record<string, unknown>, []>("SELECT * FROM plan_meals ORDER BY id").all(),
    revisions: db.query("SELECT * FROM plan_meal_revisions").all(),
    rejections: db.query("SELECT * FROM weekly_recipe_rejections").all(),
    recipes: db.query("SELECT * FROM recipes ORDER BY id").all(),
  }; } finally { db.close(); }
}
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true }))); });

// A real pseudo-terminal exercises Clack cancellation rather than mocking prompts.
async function runInteractive(path: string, mode: string) {
  const driver = `import os, pty, select, subprocess, sys, time, json, fcntl, termios, struct
master, slave = pty.openpty()
fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
child = subprocess.Popen(['bun', 'run', 'src/cli.ts', '--database', sys.argv[1], 'plan', 'replace', 'tue', '--week', '2026-10-05', '--no-deals'], stdin=slave, stdout=slave, stderr=slave, start_new_session=True)
os.close(slave)
output = b''
step = 0
mode = sys.argv[2]
markers = [b'Choose replacement', b'Rejected meal', b'Confirm replacement']
deadline = time.monotonic() + 6
while child.poll() is None and time.monotonic() < deadline:
    readable, _, _ = select.select([master], [], [], 0.1)
    if readable:
        try: output += os.read(master, 65536)
        except OSError: break
    if step < len(markers) and markers[step] in output:
        if mode == 'cancel-' + str(step): key = b'\\x03'
        elif step == 2 and mode == 'decline': key = b'n'
        elif step == 2: key = b'y'
        else: key = b'\\r'
        os.write(master, key)
        step += 1
if child.poll() is None:
    child.kill()
    child.wait()
    output += b'\\nPTY TIMEOUT'
while select.select([master], [], [], 0.05)[0]:
    try: output += os.read(master, 65536)
    except OSError: break
os.close(master)
print(json.dumps({'exitCode': child.wait(), 'stdout': output.decode(errors='replace')}))`;
  const child = Bun.spawn(["python3", "-c", driver, path, mode], { cwd: root, env: { ...process.env, TERM: "xterm", NO_COLOR: "1" }, stdout: "pipe", stderr: "pipe" });
  const [exitCode, stdout, stderr] = await Promise.all([child.exited, new Response(child.stdout).text(), new Response(child.stderr).text()]);
  if (exitCode !== 0) throw new Error(stderr);
  return JSON.parse(stdout) as { exitCode: number; stdout: string };
}

for (const mode of ["cancel-0", "cancel-1", "cancel-2", "decline"]) {
  test(`interactive ${mode} never writes meal, rejection, or preference`, async () => {
    const { path } = await fixture();
    const before = snapshot(path);
    const result = await runInteractive(path, mode);
    expect(result.stdout).not.toContain("PTY TIMEOUT");
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain(["Choose replacement", "Rejected meal", "Confirm replacement"][mode.startsWith("cancel-") ? Number(mode.slice(-1)) : 2]!);
    expect(result.stdout).toContain("no changes saved");
    expect(snapshot(path)).toEqual(before);
  }, 10_000);
}

test("interactive choice previews all deltas before confirmation and saves one meal", async () => {
  const { path, plan } = await fixture();
  const result = await runInteractive(path, "accept");
  expect(result.stdout).not.toContain("PTY TIMEOUT");
  expect(result.exitCode, result.stdout).toBe(0);
  for (const label of ["Ingredient changes", "Deal changes", "Waste delta"]) {
    expect(result.stdout.indexOf(label)).toBeGreaterThan(result.stdout.indexOf("Choose replacement"));
    expect(result.stdout.indexOf(label)).toBeLessThan(result.stdout.indexOf("Confirm replacement"));
  }
  const saved = snapshot(path).plan!;
  expect(saved.meals[1]!.recipeId).not.toBe(plan.meals[1]!.recipeId);
  expect(saved.meals.filter(meal => meal.day !== "tue")).toEqual(plan.meals.filter(meal => meal.day !== "tue"));
}, 10_000);

test("provider input rejection falls back to a warned read-only replacement preview", async () => {
  const { path, recipes } = await fixture();
  const db = openDatabase(path);
  try {
    createRecipeRepository(db).import({ ...input(0), ingredients: Array.from({ length: 201 }, () => input(0).ingredients[0]!) });
  } finally { db.close(); }
  const before = snapshot(path);
  const result = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--with", recipes[7]!.id, "--json"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const preview = JSON.parse(result.stdout);
  expect(preview.beforeScore.warnings.join("\n")).toContain("without deals");
  expect(snapshot(path)).toEqual(before);
});

test("JSON preview reports ingredient/deal/waste deltas without changing saved rows", async () => {
  const { path, plan, recipes } = await fixture();
  const before = snapshot(path);
  const result = await runCli(path, ["replace", "tuesday", "--week", "2026-10-05", "--with", recipes[7]!.id, "--preview", "--json", "--no-deals"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const preview = JSON.parse(result.stdout);
  expect(preview.original).toEqual(plan);
  const candidate = preview.candidates.find((candidate: { recipeId: string }) => candidate.recipeId === recipes[7]!.id);
  expect(candidate.ingredientDelta.additions).toEqual([{ normalizedIngredient: "beans", unit: "g", quantity: 100 }]);
  expect(candidate.ingredientDelta.removals).toEqual([{ normalizedIngredient: "carrots", unit: "g", quantity: 100 }]);
  expect(candidate.dealDelta).toEqual({ additions: [], removals: [], value: 0 });
  expect(candidate.scoreDelta.wastePenalty).toBeNumber();
  expect(candidate.score.warnings.join("\n")).toContain("Offline (--no-deals)");
  expect(snapshot(path)).toEqual(before);
});

test("JSON --yes replaces only one stable meal and records weekly rejection", async () => {
  const { path, plan, recipes } = await fixture();
  const before = snapshot(path);
  const result = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--recipe", recipes[7]!.id, "--yes", "--json", "--no-deals"]);
  expect(result.exitCode, result.stderr).toBe(0);
  const saved = JSON.parse(result.stdout);
  expect(saved.id).toBe(plan.id);
  expect(saved.score.warnings.join("\n")).toContain("Offline (--no-deals)");
  expect(saved.meals[1].id).toBe(plan.meals[1]!.id);
  expect(saved.meals[1].recipeId).toBe(recipes[7]!.id);
  expect(saved.meals[1].contentHash).not.toBe(plan.meals[1]!.contentHash);
  expect(saved.meals.filter((meal: { day: string }) => meal.day !== "tue")).toEqual(plan.meals.filter(meal => meal.day !== "tue"));
  const after = snapshot(path);
  expect(after.plan).toEqual(saved);
  expect(after.meals.filter(meal => meal.day !== "tue")).toEqual(before.meals.filter(meal => meal.day !== "tue"));
  expect(after.rejections).toHaveLength(1);
  const next = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--json", "--no-deals"]);
  expect(JSON.parse(next.stdout).candidates.some((candidate: { recipeId: string }) => candidate.recipeId === recipes[1]!.id)).toBe(false);
});

test("lock refuses replacement until unlock restores the current hash", async () => {
  const { path, plan, recipes } = await fixture();
  const locked = await runCli(path, ["lock", "tuesday", "--week", "2026-10-05", "--json"]);
  expect(locked.exitCode, locked.stderr).toBe(0);
  const lockedPlan = JSON.parse(locked.stdout);
  expect(lockedPlan.meals[1].locked).toBe(true);
  expect(lockedPlan.meals[1].contentHash).not.toBe(plan.meals[1]!.contentHash);
  expect(lockedPlan.meals.filter((meal: { day: string }) => meal.day !== "tue")).toEqual(plan.meals.filter(meal => meal.day !== "tue"));
  expect(snapshot(path).plan).toEqual(lockedPlan);
  const before = snapshot(path);
  const refused = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--with", recipes[7]!.id, "--yes", "--json", "--no-deals"]);
  expect(refused.exitCode).not.toBe(0);
  expect(refused.stderr).toContain("locked");
  expect(snapshot(path)).toEqual(before);
  const unlocked = await runCli(path, ["unlock", "tue", "--week", "2026-10-05", "--json"]);
  expect(unlocked.exitCode, unlocked.stderr).toBe(0);
  expect(JSON.parse(unlocked.stdout)).toEqual(plan);
  expect(snapshot(path).plan).toEqual(plan);
  const replaced = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--with", recipes[7]!.id, "--yes", "--json", "--no-deals"]);
  expect(replaced.exitCode, replaced.stderr).toBe(0);
});

for (const rejection of ["disliked", "none"] as const) {
  test(`explicit ${rejection} rejection has the appropriate persistent effect`, async () => {
    const { path, recipes } = await fixture();
    const replaced = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--with", recipes[7]!.id, "--yes", "--rejection", rejection, "--json", "--no-deals"]);
    expect(replaced.exitCode, replaced.stderr).toBe(0);
    const db = openDatabase(path);
    try {
      const rejected = createRecipeRepository(db).get(recipes[1]!.id)!;
      expect(rejected.preference).toBe(rejection === "disliked" ? "disliked" : "neutral");
      if (rejection === "disliked") expect((rejected.sourceEvidence as { reviewOverrides: string[] }).reviewOverrides).toContain("preference");
      expect(createPlanRepository(db).listRejectedRecipeIds("2026-10-05")).toEqual([]);
    } finally { db.close(); }
  });
}

for (const flags of [["--json"], [], ["--preview"], ["--json", "--preview"]]) {
  test(`noninteractive ${flags.join(" ") || "default"} returns preview without writes`, async () => {
    const { path, recipes } = await fixture();
    const before = snapshot(path);
    const result = await runCli(path, ["replace", "tue", "--week", "2026-10-05", "--with", recipes[7]!.id, "--rejection", "disliked", "--no-deals", ...flags]);
    expect(result.exitCode, result.stderr).toBe(0);
    expect(result.stderr).toContain("Offline (--no-deals)");
    if (!flags.includes("--json")) {
      expect(result.stdout).toContain("Ingredient changes");
      expect(result.stdout).toContain("Deal changes");
      expect(result.stdout).toContain("Waste delta");
      expect(result.stdout).toContain("no changes saved");
    }
    expect(snapshot(path)).toEqual(before);
  });
}

for (const [day, options, message] of [
  ["funday", [], "Invalid day"],
  ["tue", ["--week", "2026-02-30"], "Date is invalid"],
  ["tue", ["--with", "recipe:BAD"], "Invalid recipe id"],
  ["tue", ["--rejection", "bad"], "Invalid rejection"],
  ["tue", ["--json", "--json"], "Duplicate option"],
  ["tue", ["--week", "2026-10-05", "--week", "2026-10-12"], "Duplicate option"],
  ["tue", ["--with", `recipe:${"a".repeat(64)}`, "--recipe", `recipe:${"b".repeat(64)}`], "Use only one"],
  ["tue", ["--yes"], "requires --with"],
  ["tue", ["--preview", "--yes"], "cannot be combined"],
] as const) {
  test(`validates ${message} before accessing nonexistent database`, async () => {
    const directory = await mkdtemp(join(tmpdir(), "mealplan-edit-invalid-"));
    directories.push(directory);
    const path = join(directory, "does-not-exist.sqlite");
    const result = await runCli(path, ["replace", day, ...options, "--no-deals"]);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain(message);
    expect(await Bun.file(path).exists()).toBe(false);
  });
}
