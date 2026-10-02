import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dir, "../..");
const temporaryDirectories: string[] = [];

type ProcessResult = { exitCode: number; stdout: string; stderr: string };

async function run(command: string[], cwd: string, environment: Record<string, string> = {}): Promise<ProcessResult> {
  const child = Bun.spawn(command, {
    cwd,
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

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("a relocated Bun bundle runs from another working directory and verifies the configured sidecar", async () => {
  const root = await mkdtemp(join(tmpdir(), "meal-planer-distribution-"));
  temporaryDirectories.push(root);
  const releaseDirectory = join(root, "release");
  const unrelatedDirectory = join(root, "cwd");
  await mkdir(join(releaseDirectory, "dist"), { recursive: true });
  await mkdir(unrelatedDirectory);
  const bundlePath = join(releaseDirectory, "dist", "cli.js");
  const built = await run([
    "bun", "build", join(projectRoot, "src/cli.ts"),
    "--outfile", bundlePath,
    "--target", "bun",
  ], projectRoot);
  expect(built.exitCode, built.stderr).toBe(0);

  const help = await run(["bun", bundlePath, "--help"], unrelatedDirectory);
  expect(help.exitCode, help.stderr).toBe(0);
  expect(help.stdout).toContain("backup");

  const databasePath = join(root, "state", "mealplan.sqlite");
  const setup = await run([
    "bun", bundlePath,
    "--database", databasePath,
    "setup",
    "--member", JSON.stringify({ id: "family", name: "Family", kind: "adult", servings: 4 }),
  ], unrelatedDirectory);
  expect(setup.exitCode, setup.stderr).toBe(0);

  const verified = await run([
    "bun", bundlePath,
    "integrations", "verify-deals",
    "--data", join(root, "mcp.json"),
    "--json",
  ], unrelatedDirectory, {
    MEALPLAN_TILBUDSTROLDEN_DIR: join(projectRoot, "vendor/tilbudstrolden-mcp"),
  });
  expect(verified.exitCode, verified.stderr).toBe(0);
  expect(JSON.parse(verified.stdout)).toMatchObject({
    compatible: true,
    server: { name: "tilbudstrolden", version: "0.5.3" },
  });
});
