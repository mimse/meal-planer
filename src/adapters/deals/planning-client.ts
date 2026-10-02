import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TilbudstroldenClient } from "./tilbudstrolden-client";

export type PlanningClientFactoryOptions = {
  dataDirectory?: string;
  serverDirectory?: string;
  timeoutMs?: number;
};

function isPinnedRuntime(directory: string): boolean {
  if (!existsSync(join(directory, "dist/server.js")) || !existsSync(join(directory, "node_modules"))) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
      name?: unknown;
      version?: unknown;
    };
    return manifest.name === "tilbudstrolden-mcp" && manifest.version === "0.5.3";
  } catch {
    return false;
  }
}

/** Locate the pinned sidecar in configured, source, and Bun bundle layouts. */
export function resolvePlanningServerDirectory(
  moduleUrl: string = import.meta.url,
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const configured = environment.MEALPLAN_TILBUDSTROLDEN_DIR?.trim();
  if (configured) {
    const directory = resolve(configured);
    if (!isPinnedRuntime(directory)) {
      throw new Error("MEALPLAN_TILBUDSTROLDEN_DIR does not contain a built TilbudsTrolden 0.5.3 runtime");
    }
    return directory;
  }
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const candidate = join(directory, "vendor/tilbudstrolden-mcp");
    if (isPinnedRuntime(candidate)) return candidate;
    const parent = dirname(directory);
    if (parent === directory) {
      throw new Error("Pinned TilbudsTrolden 0.5.3 runtime is missing or unbuilt; run bun run setup:runtime from the project root");
    }
    directory = parent;
  }
}

/** A fresh private store prevents cross-process writes and stale recipe/pantry state. */
export async function createPlanningDealsClient(options: PlanningClientFactoryOptions = {}): Promise<TilbudstroldenClient> {
  const dataHome = process.env.XDG_DATA_HOME?.trim() || join(homedir(), ".local/share");
  const base = resolve(options.dataDirectory ?? join(dataHome, "mealplaner", "mcp-sessions"));
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, "planning-"));
  try {
    const serverDirectory = resolve(options.serverDirectory ?? resolvePlanningServerDirectory());
    class PrivatePlanningClient extends TilbudstroldenClient {
      override async close(): Promise<void> {
        try { await super.close(); }
        finally { await rm(directory, { recursive: true, force: true }); }
      }
    }
    return new PrivatePlanningClient({ command: "node", args: ["dist/server.js"], cwd: serverDirectory,
      dataPath: join(directory, "tilbudstrolden.json"), timeoutMs: options.timeoutMs ?? 10_000 });
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
