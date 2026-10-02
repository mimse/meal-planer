import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const projectRoot = new URL("../..", import.meta.url).pathname;
const temporaryDirectories: string[] = [];

type CliResult = { exitCode: number; stdout: string; stderr: string };

async function runCli(args: string[]): Promise<CliResult> {
  const child = Bun.spawn(["bun", "run", "src/cli.ts", ...args], {
    cwd: projectRoot,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("backup CLI creates and restores a verified bundle with stable JSON", async () => {
  const root = await mkdtemp(join(tmpdir(), "meal-planer-backup-cli-"));
  temporaryDirectories.push(root);
  const databasePath = join(root, "state", "mealplan.sqlite");
  const setup = await runCli([
    "--database", databasePath,
    "setup",
    "--member", JSON.stringify({ id: "family", name: "Family", kind: "adult", servings: 4 }),
  ]);
  expect(setup.exitCode, setup.stderr).toBe(0);

  const bundlePath = join(root, "backup");
  const created = await runCli([
    "--database", databasePath,
    "backup", "create", bundlePath,
    "--json",
  ]);
  expect(created.exitCode, created.stderr).toBe(0);
  expect(JSON.parse(created.stdout)).toMatchObject({
    bundlePath,
    manifest: {
      format: "mealplan-backup",
      version: 1,
      application: { file: "mealplan.sqlite" },
      mcp: { mode: "ephemeral-regenerated" },
    },
  });

  const destination = join(root, "recovered");
  const restored = await runCli([
    "backup", "restore", bundlePath,
    "--to", destination,
    "--json",
  ]);
  expect(restored.exitCode, restored.stderr).toBe(0);
  expect(JSON.parse(restored.stdout)).toMatchObject({
    databasePath: join(destination, "mealplan.sqlite"),
    mcpDataPath: null,
  });

  const shown = await runCli([
    "--database", join(destination, "mealplan.sqlite"),
    "family", "show", "--json",
  ]);
  expect(shown.exitCode, shown.stderr).toBe(0);
  expect(JSON.parse(shown.stdout).members).toEqual([
    { id: "family", name: "Family", kind: "adult", servings: 4 },
  ]);
});
