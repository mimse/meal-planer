import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { chmod, lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { z } from "zod";
import packageJson from "../../package.json";
import { assertDatabaseIntegrity } from "./database";
import { readValidatedMigrationLedger } from "./migrations";

const DATABASE_FILE = "mealplan.sqlite";
const MANIFEST_FILE = "manifest.json";
const MCP_FILE = "tilbudstrolden.json";
const MAX_MCP_BYTES = 10 * 1024 * 1024;

type BackupFile = {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
};

export type BackupManifest = {
  readonly format: "mealplan-backup";
  readonly version: 1;
  readonly createdAt: string;
  readonly appVersion: string;
  readonly application: BackupFile & {
    readonly migrations: readonly { version: number; name: string }[];
  };
  readonly mcp:
    | { readonly mode: "ephemeral-regenerated" }
    | (BackupFile & { readonly mode: "persistent-included"; readonly capturedAt: string });
};

type CreateBackupOptions = {
  readonly databasePath: string;
  readonly bundlePath: string;
  readonly mcpDataPath?: string;
  readonly createdAt?: string;
};

type RestoreBackupOptions = {
  readonly bundlePath: string;
  readonly destinationDirectory: string;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const boundedString = z.string().max(10_000);
const McpDataSchema = z.object({
  household: z.object({
    people: z.array(z.object({
      name: boundedString,
      dietaryRestrictions: z.array(boundedString).max(1_000),
      defaultSchedule: z.record(z.string().max(100), z.boolean()),
    }).strict()).max(1_000),
    stores: z.array(z.object({
      name: boundedString,
      dealerId: boundedString,
      priority: z.number().finite(),
    }).strict()).max(1_000),
    defaultServings: z.number().finite(),
    country: boundedString,
  }).strict(),
  pantry: z.array(boundedString).max(10_000),
  recipes: z.array(z.object({
    name: boundedString,
    ingredients: z.array(z.object({
      name: boundedString,
      quantity: boundedString,
      searchTerms: z.array(boundedString).max(1_000),
      category: boundedString,
    }).strict()).max(10_000),
    servings: z.number().finite(),
    complexity: z.enum(["quick", "medium", "slow"]),
    cuisineType: boundedString,
    proteinType: boundedString,
  }).strict()).max(10_000),
  mealHistory: z.array(z.object({
    date: boundedString,
    recipe: boundedString,
    people: z.array(boundedString).max(1_000),
  }).strict()).max(100_000),
  spendLog: z.array(z.object({
    date: boundedString,
    store: boundedString,
    estimatedTotal: z.number().finite(),
    items: z.number().finite(),
    notes: boundedString,
  }).strict()).max(100_000),
}).strict();

function validateMcpData(bytes: Buffer): void {
  if (bytes.byteLength > MAX_MCP_BYTES) throw new Error("TilbudsTrolden data exceeds the 10 MiB backup limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new Error("TilbudsTrolden data is not valid JSON");
  }
  if (!McpDataSchema.safeParse(parsed).success) {
    throw new Error("TilbudsTrolden data does not match the pinned 0.5.3 store schema");
  }
}

async function fileMetadata(path: string, file: string): Promise<BackupFile> {
  const bytes = await readFile(path);
  return { file, bytes: bytes.byteLength, sha256: sha256(bytes) };
}

function stagingPath(target: string): string {
  return join(dirname(target), `.${basename(target)}.tmp-${randomUUID()}`);
}

function openValidatedReadOnlyDatabase(path: string): Database {
  if (!existsSync(path)) throw new Error(`Application database does not exist: ${path}`);
  const database = new Database(path, { readonly: true, strict: true });
  try {
    assertDatabaseIntegrity(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function createBackupBundle(options: CreateBackupOptions): Promise<BackupManifest> {
  const databasePath = resolve(options.databasePath);
  const bundlePath = resolve(options.bundlePath);
  if (existsSync(bundlePath)) throw new Error(`Backup destination already exists: ${bundlePath}`);
  await mkdir(dirname(bundlePath), { recursive: true });
  const stage = stagingPath(bundlePath);
  await mkdir(stage, { mode: 0o700 });

  try {
    const source = openValidatedReadOnlyDatabase(databasePath);
    let migrations: readonly { version: number; name: string }[];
    try {
      migrations = readValidatedMigrationLedger(source);
      source.query("VACUUM INTO ?").run(join(stage, DATABASE_FILE));
    } finally {
      source.close();
    }

    const snapshot = openValidatedReadOnlyDatabase(join(stage, DATABASE_FILE));
    snapshot.close();
    await chmod(join(stage, DATABASE_FILE), 0o600);
    const application = await fileMetadata(join(stage, DATABASE_FILE), DATABASE_FILE);
    const capturedAt = options.createdAt ?? new Date().toISOString();
    let mcp: BackupManifest["mcp"] = { mode: "ephemeral-regenerated" };
    if (options.mcpDataPath !== undefined) {
      const mcpSource = resolve(options.mcpDataPath);
      const entry = await lstat(mcpSource);
      if (!entry.isFile() || entry.isSymbolicLink()) {
        throw new Error("TilbudsTrolden data must be a regular file, not a symlink");
      }
      const bytes = await readFile(mcpSource);
      validateMcpData(bytes);
      await writeFile(join(stage, MCP_FILE), bytes, { mode: 0o600, flag: "wx" });
      mcp = {
        mode: "persistent-included",
        capturedAt,
        ...(await fileMetadata(join(stage, MCP_FILE), MCP_FILE)),
      };
    }
    const manifest: BackupManifest = {
      format: "mealplan-backup",
      version: 1,
      createdAt: capturedAt,
      appVersion: packageJson.version,
      application: { ...application, migrations },
      mcp,
    };
    await writeFile(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(stage, bundlePath);
    return manifest;
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
}

function parseManifest(value: unknown): BackupManifest {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Backup manifest must be an object");
  }
  const manifest = value as Partial<BackupManifest>;
  if (manifest.format !== "mealplan-backup" || manifest.version !== 1) {
    throw new Error("Unsupported backup manifest format or version");
  }
  if (typeof manifest.createdAt !== "string" || typeof manifest.appVersion !== "string") {
    throw new Error("Backup manifest metadata is invalid");
  }
  if (manifest.application?.file !== DATABASE_FILE
    || !Number.isSafeInteger(manifest.application.bytes)
    || manifest.application.bytes <= 0
    || !/^[a-f0-9]{64}$/.test(manifest.application.sha256 ?? "")
    || !Array.isArray(manifest.application.migrations)) {
    throw new Error("Backup manifest contents are invalid");
  }
  if (manifest.mcp?.mode === "persistent-included") {
    if (manifest.mcp.file !== MCP_FILE
      || typeof manifest.mcp.capturedAt !== "string"
      || !Number.isSafeInteger(manifest.mcp.bytes)
      || manifest.mcp.bytes <= 0
      || manifest.mcp.bytes > MAX_MCP_BYTES
      || !/^[a-f0-9]{64}$/.test(manifest.mcp.sha256 ?? "")) {
      throw new Error("Backup MCP manifest contents are invalid");
    }
  } else if (manifest.mcp?.mode !== "ephemeral-regenerated") {
    throw new Error("Backup MCP manifest contents are invalid");
  }
  return manifest as BackupManifest;
}

async function readManifest(bundlePath: string): Promise<BackupManifest> {
  const manifestPath = join(bundlePath, MANIFEST_FILE);
  const entry = await lstat(manifestPath);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Backup manifest is not a regular file");
  try {
    return parseManifest(JSON.parse(await readFile(manifestPath, "utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Backup manifest is not valid JSON");
    throw error;
  }
}

export async function restoreBackupBundle(options: RestoreBackupOptions): Promise<{
  readonly databasePath: string;
  readonly mcpDataPath: string | null;
  readonly manifest: BackupManifest;
}> {
  const bundlePath = resolve(options.bundlePath);
  const destination = resolve(options.destinationDirectory);
  if (existsSync(destination)) throw new Error(`Restore destination already exists: ${destination}`);
  const manifest = await readManifest(bundlePath);
  const expectedFiles = new Set([
    MANIFEST_FILE,
    DATABASE_FILE,
    ...(manifest.mcp.mode === "persistent-included" ? [MCP_FILE] : []),
  ]);
  const bundleFiles = await readdir(bundlePath);
  const unexpectedFile = bundleFiles.find((file) => !expectedFiles.has(file));
  if (unexpectedFile !== undefined) throw new Error(`Backup bundle contains unexpected file: ${unexpectedFile}`);
  const missingFile = [...expectedFiles].find((file) => !bundleFiles.includes(file));
  if (missingFile !== undefined) throw new Error(`Backup bundle is missing required file: ${missingFile}`);
  const sourceDatabase = join(bundlePath, manifest.application.file);
  const databaseEntry = await lstat(sourceDatabase);
  if (!databaseEntry.isFile() || databaseEntry.isSymbolicLink()) {
    throw new Error("Backup application database is not a regular file");
  }
  const sourceMetadata = await fileMetadata(sourceDatabase, DATABASE_FILE);
  if (sourceMetadata.bytes !== manifest.application.bytes || sourceMetadata.sha256 !== manifest.application.sha256) {
    throw new Error("Backup application database checksum does not match the manifest");
  }
  const source = openValidatedReadOnlyDatabase(sourceDatabase);
  const actualMigrations = readValidatedMigrationLedger(source);
  source.close();
  if (JSON.stringify(actualMigrations) !== JSON.stringify(manifest.application.migrations)) {
    throw new Error("Backup application migration ledger does not match the manifest");
  }
  let mcpBytes: Buffer | null = null;
  if (manifest.mcp.mode === "persistent-included") {
    const sourceMcp = join(bundlePath, manifest.mcp.file);
    const mcpEntry = await lstat(sourceMcp);
    if (!mcpEntry.isFile() || mcpEntry.isSymbolicLink()) {
      throw new Error("Backup TilbudsTrolden data is not a regular file");
    }
    mcpBytes = await readFile(sourceMcp);
    validateMcpData(mcpBytes);
    if (mcpBytes.byteLength !== manifest.mcp.bytes || sha256(mcpBytes) !== manifest.mcp.sha256) {
      throw new Error("Backup TilbudsTrolden data checksum does not match the manifest");
    }
  }

  await mkdir(dirname(destination), { recursive: true });
  const stage = stagingPath(destination);
  await mkdir(stage, { mode: 0o700 });
  try {
    const restoredDatabase = join(stage, DATABASE_FILE);
    await writeFile(restoredDatabase, await readFile(sourceDatabase), { mode: 0o600, flag: "wx" });
    const staged = openValidatedReadOnlyDatabase(restoredDatabase);
    staged.close();
    if (mcpBytes !== null) {
      await writeFile(join(stage, MCP_FILE), mcpBytes, { mode: 0o600, flag: "wx" });
    }
    await writeFile(join(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(stage, destination);
  } catch (error) {
    await rm(stage, { recursive: true, force: true });
    throw error;
  }
  return {
    databasePath: join(destination, DATABASE_FILE),
    mcpDataPath: manifest.mcp.mode === "persistent-included" ? join(destination, MCP_FILE) : null,
    manifest,
  };
}
