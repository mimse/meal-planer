import { afterEach, expect, test } from "bun:test";
import { exists, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBackupBundle, restoreBackupBundle } from "../../src/infrastructure/backup";
import { readFamilyConfiguration } from "../../src/commands/family";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { openDatabase, openExistingDatabase } from "../../src/infrastructure/database";

const temporaryDirectories: string[] = [];

async function temporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meal-planer-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

test("creates a coherent bundle and restores application state into a new directory", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "state", "mealplan.sqlite");
  await mkdir(join(root, "state"));
  const database = openDatabase(databasePath);
  applySetup(database, createSetupConfiguration({
    members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }],
  }));
  database.close();
  const sourceBefore = await readFile(databasePath);

  const manifest = await createBackupBundle({
    databasePath,
    bundlePath: join(root, "backup"),
    createdAt: "2026-10-02T10:00:00.000Z",
  });

  expect(manifest).toMatchObject({
    format: "mealplan-backup",
    version: 1,
    createdAt: "2026-10-02T10:00:00.000Z",
    application: { file: "mealplan.sqlite" },
    mcp: { mode: "ephemeral-regenerated" },
  });
  expect(await readFile(databasePath)).toEqual(sourceBefore);

  const restored = await restoreBackupBundle({
    bundlePath: join(root, "backup"),
    destinationDirectory: join(root, "restored"),
  });
  expect(restored.databasePath).toBe(join(root, "restored", "mealplan.sqlite"));
  expect(restored.mcpDataPath).toBeNull();

  const reopened = openExistingDatabase(restored.databasePath);
  expect(readFamilyConfiguration(reopened).members).toEqual([
    { id: "family", name: "Family", kind: "adult", servings: 4 },
  ]);
  reopened.close();
});

test("includes an explicitly selected persistent MCP store and restores it byte-for-byte", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  applySetup(database, createSetupConfiguration({
    members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }],
  }));
  database.close();
  const mcpDataPath = join(root, "tilbudstrolden.json");
  const mcpBytes = Buffer.from(`${JSON.stringify({
    household: {
      people: [{ name: "Family", dietaryRestrictions: [], defaultSchedule: { monday: true } }],
      stores: [{ name: "Netto", dealerId: "netto", priority: 1 }],
      defaultServings: 4,
      country: "DK",
    },
    pantry: ["rice"],
    recipes: [],
    mealHistory: [],
    spendLog: [],
  }, null, 2)}\n`);
  await Bun.write(mcpDataPath, mcpBytes);

  const manifest = await createBackupBundle({
    databasePath,
    bundlePath: join(root, "backup"),
    mcpDataPath,
    createdAt: "2026-10-02T10:00:00.000Z",
  });
  expect(manifest.mcp).toMatchObject({
    mode: "persistent-included",
    file: "tilbudstrolden.json",
  });

  const restored = await restoreBackupBundle({
    bundlePath: join(root, "backup"),
    destinationDirectory: join(root, "restored"),
  });
  expect(restored.mcpDataPath).toBe(join(root, "restored", "tilbudstrolden.json"));
  expect(await readFile(restored.mcpDataPath!)).toEqual(mcpBytes);
});

test("refuses a bundle with unexpected files without publishing a restore directory", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  applySetup(database, createSetupConfiguration({
    members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }],
  }));
  database.close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  await writeFile(join(bundlePath, "unexpected.txt"), "not part of the bundle");
  const destinationDirectory = join(root, "restored");

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory }))
    .rejects.toThrow("unexpected file");
  expect(await exists(destinationDirectory)).toBe(false);
});
