import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { TilbudstroldenClient } from "./tilbudstrolden-client";

export type PlanningClientFactoryOptions = {
  dataDirectory?: string;
  serverDirectory?: string;
  timeoutMs?: number;
};

/** Locate the sibling vendor checkout in source and Bun bundle layouts. */
export function resolvePlanningServerDirectory(moduleUrl: string = import.meta.url): string {
  let directory = dirname(fileURLToPath(moduleUrl));
  while (true) {
    const candidate = join(directory, "vendor/tilbudstrolden-mcp");
    if (existsSync(join(candidate, "dist/server.js"))) return candidate;
    const parent = dirname(directory);
    if (parent === directory) throw new Error("Pinned deal server is not built; run bun run vendor:install from the project root");
    directory = parent;
  }
}

/** A fresh private store prevents cross-process writes and stale recipe/pantry state. */
export async function createPlanningDealsClient(options: PlanningClientFactoryOptions = {}): Promise<TilbudstroldenClient> {
  const base = resolve(options.dataDirectory ?? join(process.env.XDG_DATA_HOME ?? join(homedir(), ".local/share"), "meal-planer", "mcp-sessions"));
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
