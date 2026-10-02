import { afterEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { chmod, copyFile, cp, exists, mkdir, mkdtemp, readFile, readdir, rename, rm, symlink, writeFile } from "node:fs/promises";
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

test("accepts a pinned MCP store that relies on TilbudsTrolden defaults", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  database.close();
  const mcpDataPath = join(root, "tilbudstrolden.json");
  await writeFile(mcpDataPath, "{}\n");

  const manifest = await createBackupBundle({
    databasePath,
    bundlePath: join(root, "backup"),
    mcpDataPath,
  });

  expect(manifest.mcp.mode).toBe("persistent-included");
});

test("accepts unknown MCP fields that the pinned non-strict store schema preserves compatibly", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const mcpDataPath = join(root, "tilbudstrolden.json");
  await writeFile(mcpDataPath, JSON.stringify({
    recipes: [{
      name: "Soup",
      ingredients: [{ name: "salt", quantity: "1 tsp", searchTerms: ["salt"], category: "pantry", futureField: true }],
      servings: 2,
      complexity: "quick",
      cuisineType: "danish",
      proteinType: "vegetarian",
    }],
  }));

  const manifest = await createBackupBundle({ databasePath, bundlePath: join(root, "backup"), mcpDataPath });

  expect(manifest.mcp.mode).toBe("persistent-included");
});

test("accepts pinned-schema MCP strings without undocumented field limits", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const mcpDataPath = join(root, "tilbudstrolden.json");
  await writeFile(mcpDataPath, JSON.stringify({ pantry: ["x".repeat(10_001)] }));

  const manifest = await createBackupBundle({ databasePath, bundlePath: join(root, "backup"), mcpDataPath });

  expect(manifest.mcp.mode).toBe("persistent-included");
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

test("refuses to restore inside the source backup bundle", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  applySetup(database, createSetupConfiguration({
    members: [{ id: "family", name: "Family", kind: "adult", servings: 4 }],
  }));
  database.close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });

  await expect(restoreBackupBundle({
    bundlePath,
    destinationDirectory: join(bundlePath, "restored"),
  })).rejects.toThrow("outside the backup bundle");
  expect(await exists(join(bundlePath, "restored"))).toBe(false);
});

test("refuses to restore through a symlink alias into the source bundle", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const alias = join(root, "backup-alias");
  await symlink(bundlePath, alias, "dir");

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory: join(alias, "restored") }))
    .rejects.toThrow("outside the backup bundle");
  expect(await exists(join(bundlePath, "restored"))).toBe(false);
});

test("refuses a bundle symlink retargeted during restore", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const firstBundle = join(root, "backup-a");
  const secondBundle = join(root, "backup-b");
  await createBackupBundle({ databasePath, bundlePath: firstBundle });
  await cp(firstBundle, secondBundle, { recursive: true });
  const bundleAlias = join(root, "backup-current");
  await symlink(firstBundle, bundleAlias, "dir");
  const destinationDirectory = join(secondBundle, "restored");

  await expect(restoreBackupBundle({ bundlePath: bundleAlias, destinationDirectory }, {
    beforeDatabaseCopy: async () => {
      await rm(bundleAlias);
      await symlink(secondBundle, bundleAlias, "dir");
    },
  })).rejects.toThrow("source changed during restore");
  expect(await exists(destinationDirectory)).toBe(false);
});

test("refuses a destination parent redirected into the source bundle during publication", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const destinationParent = join(root, "recovery");
  const movedParent = join(root, "moved-recovery");
  await mkdir(destinationParent);
  const destinationDirectory = join(destinationParent, "restored");

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory }, {
    beforePublish: async () => {
      await rename(destinationParent, movedParent);
      await symlink(bundlePath, destinationParent, "dir");
      const stageName = (await readdir(movedParent)).find(name => name.startsWith(".restored.tmp-"));
      if (stageName === undefined) throw new Error("missing restore stage");
      await symlink(join(movedParent, stageName), join(bundlePath, stageName), "dir");
    },
  })).rejects.toThrow("destination changed during publication");
  expect(await exists(join(bundlePath, "restored"))).toBe(false);
});

test("refuses publication inside a source bundle moved during restore", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const movedBundle = join(root, "backup-moved");
  const destinationParent = join(root, "destination");
  await mkdir(destinationParent);
  const destinationDirectory = join(destinationParent, "restored");

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory }, {
    beforePublish: async () => {
      await rename(bundlePath, movedBundle);
      await rename(destinationParent, join(movedBundle, "destination"));
      await symlink(join(movedBundle, "destination"), destinationParent, "dir");
    },
  })).rejects.toThrow("outside the backup bundle");

  expect(await exists(join(movedBundle, "destination", "restored"))).toBe(false);
});

test("does not write through a restore destination replaced after it is claimed", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const destinationDirectory = join(root, "restored");
  const unrelatedDirectory = join(root, "unrelated");
  await mkdir(unrelatedDirectory);
  await writeFile(join(unrelatedDirectory, "sentinel.txt"), "preserve me");
  const restoreWithHooks = restoreBackupBundle as unknown as (
    options: Parameters<typeof restoreBackupBundle>[0],
    hooks: { atPublicationBoundary(): Promise<void> },
  ) => ReturnType<typeof restoreBackupBundle>;

  await expect(restoreWithHooks({ bundlePath, destinationDirectory }, {
    atPublicationBoundary: async () => {
      await symlink(unrelatedDirectory, destinationDirectory, "dir");
    },
  })).rejects.toThrow("destination");
  expect(await readFile(join(unrelatedDirectory, "sentinel.txt"), "utf8")).toBe("preserve me");
  expect(await exists(join(unrelatedDirectory, "mealplan.sqlite"))).toBe(false);
  expect(await exists(join(unrelatedDirectory, "manifest.json"))).toBe(false);
});

test("refuses a backup parent redirected during publication", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const destinationParent = join(root, "destination");
  const movedParent = join(root, "destination-original");
  const redirectedParent = join(root, "redirected");
  await mkdir(destinationParent);
  await mkdir(redirectedParent);
  const bundlePath = join(destinationParent, "backup");

  await expect(createBackupBundle({ databasePath, bundlePath }, {
    beforePublish: async () => {
      await rename(destinationParent, movedParent);
      await symlink(redirectedParent, destinationParent, "dir");
    },
  })).rejects.toThrow("Backup destination changed during publication");

  expect(await exists(join(redirectedParent, "backup"))).toBe(false);
  expect(await exists(join(movedParent, "backup"))).toBe(false);
});

test("refuses to publish a substituted staging directory or delete it during cleanup", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  let attackerStage = "";

  await expect(createBackupBundle({ databasePath, bundlePath }, {
    atPublicationBoundary: async () => {
      const stageName = (await readdir(root)).find(name => name.startsWith(".backup.tmp-"));
      expect(stageName).toBeDefined();
      attackerStage = join(root, stageName!);
      await rename(attackerStage, `${attackerStage}-validated`);
      await mkdir(attackerStage);
      await writeFile(join(attackerStage, "attacker.txt"), "preserve me");
    },
  })).rejects.toThrow("staging directory changed during publication");

  expect(await readFile(join(attackerStage, "attacker.txt"), "utf8")).toBe("preserve me");
  expect(await exists(join(bundlePath, "manifest.json"))).toBe(false);
});

test("rejects an oversized manifest before attempting to read its contents", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const manifestPath = join(bundlePath, "manifest.json");
  await writeFile(manifestPath, Buffer.alloc(1024 * 1024 + 1));
  await chmod(manifestPath, 0o000);

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory: join(root, "restored") }))
    .rejects.toThrow("manifest exceeds the 1 MiB limit");
});

test("rejects oversized MCP data before attempting to read its contents", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const mcpDataPath = join(root, "tilbudstrolden.json");
  await writeFile(mcpDataPath, "{}\n");
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath, mcpDataPath });
  const bundledMcpPath = join(bundlePath, "tilbudstrolden.json");
  await writeFile(bundledMcpPath, Buffer.alloc(10 * 1024 * 1024 + 1));
  await chmod(bundledMcpPath, 0o000);

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory: join(root, "restored") }))
    .rejects.toThrow("data exceeds the 10 MiB limit");
});

test("rejects oversized source MCP data before creating a bundle", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const mcpDataPath = join(root, "tilbudstrolden.json");
  await writeFile(mcpDataPath, Buffer.alloc(10 * 1024 * 1024 + 1));
  await chmod(mcpDataPath, 0o000);

  await expect(createBackupBundle({ databasePath, bundlePath: join(root, "backup"), mcpDataPath }))
    .rejects.toThrow("data exceeds the 10 MiB limit");
  expect(await exists(join(root, "backup"))).toBe(false);
});

test("validates the exact database bytes copied into the restore stage", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  applySetup(database, createSetupConfiguration({
    members: [{ id: "original", name: "Original", kind: "adult", servings: 1 }],
  }));
  database.close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });

  const replacementPath = join(root, "replacement.sqlite");
  const replacement = openDatabase(replacementPath);
  applySetup(replacement, createSetupConfiguration({
    members: [{ id: "replacement", name: "Replacement", kind: "adult", servings: 2 }],
  }));
  replacement.close();
  const restoreWithHooks = restoreBackupBundle as unknown as (
    options: Parameters<typeof restoreBackupBundle>[0],
    hooks: { beforeDatabaseCopy(): Promise<void> },
  ) => ReturnType<typeof restoreBackupBundle>;

  await expect(restoreWithHooks({ bundlePath, destinationDirectory: join(root, "restored") }, {
    beforeDatabaseCopy: () => copyFile(replacementPath, join(bundlePath, "mealplan.sqlite")),
  })).rejects.toThrow("checksum does not match");
  expect(await exists(join(root, "restored"))).toBe(false);
});

test("rejects a snapshot whose applied schema and migration ledger disagree", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  const createWithHooks = createBackupBundle as unknown as (
    options: Parameters<typeof createBackupBundle>[0],
    hooks: { beforeSnapshot(): void },
  ) => ReturnType<typeof createBackupBundle>;

  await expect(createWithHooks({ databasePath, bundlePath }, {
    beforeSnapshot: () => {
      const concurrent = openExistingDatabase(databasePath);
      concurrent.run("DELETE FROM schema_migrations WHERE version = (SELECT MAX(version) FROM schema_migrations)");
      concurrent.close();
    },
  })).rejects.toThrow("schema does not match its migration ledger");
  expect(await exists(bundlePath)).toBe(false);
});

test("rejects a snapshot whose migration ledger is ahead of its schema", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  database.exec("DROP INDEX recipe_sources_archived");
  database.exec("ALTER TABLE recipe_sources DROP COLUMN archived");
  database.close();
  const bundlePath = join(root, "backup");

  await expect(createBackupBundle({ databasePath, bundlePath }))
    .rejects.toThrow("schema does not match its migration ledger");
  expect(await exists(bundlePath)).toBe(false);
});

test("rejects a snapshot with a malformed migration tracking table", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  database.exec("ALTER TABLE schema_migrations DROP COLUMN applied_at");
  database.close();
  await expect(createBackupBundle({ databasePath, bundlePath: join(root, "backup") }))
    .rejects.toThrow("schema does not match its migration ledger");
});

test("rejects a user trigger whose name resembles a SQLite internal prefix", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  const database = openDatabase(databasePath);
  database.exec(`CREATE TRIGGER sqliteXunexpected AFTER INSERT ON household_members
    BEGIN UPDATE household_members SET name = 'tampered' WHERE id = NEW.id; END`);
  database.close();
  await expect(createBackupBundle({ databasePath, bundlePath: join(root, "backup") }))
    .rejects.toThrow("schema does not match its migration ledger");
});

test("restore rejects a checksummed user trigger resembling a SQLite internal prefix", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const bundledDatabasePath = join(bundlePath, "mealplan.sqlite");
  const database = openDatabase(bundledDatabasePath);
  database.exec(`CREATE TRIGGER sqliteXunexpected AFTER INSERT ON household_members
    BEGIN UPDATE household_members SET name = 'tampered' WHERE id = NEW.id; END`);
  database.close();
  const bytes = await readFile(bundledDatabasePath);
  const manifestPath = join(bundlePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.application.bytes = bytes.byteLength;
  manifest.application.sha256 = createHash("sha256").update(bytes).digest("hex");
  await writeFile(manifestPath, JSON.stringify(manifest));
  await expect(restoreBackupBundle({ bundlePath, destinationDirectory: join(root, "restored") }))
    .rejects.toThrow("schema does not match its migration ledger");
  expect(await exists(join(root, "restored"))).toBe(false);
});

test("does not replace a backup destination created during publication", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  const createWithHooks = createBackupBundle as unknown as (
    options: Parameters<typeof createBackupBundle>[0],
    hooks: { beforePublish(): Promise<void> },
  ) => ReturnType<typeof createBackupBundle>;

  await expect(createWithHooks({ databasePath, bundlePath }, {
    beforePublish: () => mkdir(bundlePath),
  })).rejects.toThrow("destination already exists");
  expect(await exists(join(bundlePath, "mealplan.sqlite"))).toBe(false);
});

test("does not replace a restore destination created during publication", async () => {
  const root = await temporaryDirectory();
  const databasePath = join(root, "mealplan.sqlite");
  openDatabase(databasePath).close();
  const bundlePath = join(root, "backup");
  await createBackupBundle({ databasePath, bundlePath });
  const destinationDirectory = join(root, "restored");

  await expect(restoreBackupBundle({ bundlePath, destinationDirectory }, {
    beforePublish: () => mkdir(destinationDirectory),
  })).rejects.toThrow("destination already exists");
  expect(await exists(join(destinationDirectory, "mealplan.sqlite"))).toBe(false);
});
