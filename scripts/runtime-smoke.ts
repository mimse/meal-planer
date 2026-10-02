import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const directory = await mkdtemp(join(tmpdir(), "mealplaner-runtime-smoke-"));

try {
  const child = Bun.spawn([
    "bun",
    "run",
    join(projectRoot, "dist/cli.js"),
    "integrations",
    "verify-deals",
    "--data",
    join(directory, "tilbudstrolden.json"),
    "--json",
  ], {
    cwd: directory,
    env: {
      ...process.env,
      MEALPLAN_TILBUDSTROLDEN_DIR: join(projectRoot, "vendor/tilbudstrolden-mcp"),
    },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [exitCode, stdout, stderr] = await Promise.all([
    child.exited,
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
  ]);
  if (exitCode !== 0) throw new Error(stderr.trim() || `Runtime smoke check exited ${exitCode}`);
  const report = JSON.parse(stdout) as { compatible?: unknown; server?: { name?: unknown; version?: unknown } };
  if (report.compatible !== true
    || report.server?.name !== "tilbudstrolden"
    || report.server.version !== "0.5.3") {
    throw new Error("Runtime smoke check did not negotiate the pinned TilbudsTrolden 0.5.3 contract");
  }
  console.log("Runtime smoke check passed: bundled CLI + TilbudsTrolden 0.5.3.");
} finally {
  await rm(directory, { recursive: true, force: true });
}
