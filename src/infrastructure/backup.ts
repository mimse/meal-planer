import { Database } from "bun:sqlite";
import { createHash, randomUUID } from "node:crypto";
import { constants, createReadStream, existsSync } from "node:fs";
import { chmod, copyFile, lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile, type FileHandle } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import packageJson from "../../package.json";
import { assertDatabaseIntegrity, openDatabase } from "./database";
import { migrations, readValidatedMigrationLedger, runMigrations } from "./migrations";

const DATABASE_FILE = "mealplan.sqlite";
const MANIFEST_FILE = "manifest.json";
const MCP_FILE = "tilbudstrolden.json";
const RESTORE_MARKER_FILE = ".mealplan-restore-token";
const MAX_MANIFEST_BYTES = 1024 * 1024;
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

type CreateBackupHooks = {
  readonly beforeSnapshot?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
  readonly atPublicationBoundary?: () => void | Promise<void>;
};

type RestoreBackupOptions = {
  readonly bundlePath: string;
  readonly destinationDirectory: string;
};

type RestoreBackupHooks = {
  readonly beforeDatabaseCopy?: () => void | Promise<void>;
  readonly beforePublish?: () => void | Promise<void>;
  readonly atPublicationBoundary?: () => void | Promise<void>;
};

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

const storeString = z.string();
const McpDataSchema = z.object({
  household: z.object({
    people: z.array(z.object({
      name: storeString,
      dietaryRestrictions: z.array(storeString).optional(),
      defaultSchedule: z.record(z.string(), z.boolean()).optional(),
    })).optional(),
    stores: z.array(z.object({
      name: storeString,
      dealerId: storeString,
      priority: z.number().finite(),
    })).optional(),
    defaultServings: z.number().finite().optional(),
    country: storeString.optional(),
  }).optional(),
  pantry: z.array(storeString).optional(),
  recipes: z.array(z.object({
    name: storeString,
    ingredients: z.array(z.object({
      name: storeString,
      quantity: storeString,
      searchTerms: z.array(storeString),
      category: storeString,
    })),
    servings: z.number().finite(),
    complexity: z.enum(["quick", "medium", "slow"]),
    cuisineType: storeString,
    proteinType: storeString,
  })).optional(),
  mealHistory: z.array(z.object({
    date: storeString,
    recipe: storeString,
    people: z.array(storeString),
  })).optional(),
  spendLog: z.array(z.object({
    date: storeString,
    store: storeString,
    estimatedTotal: z.number().finite(),
    items: z.number().finite(),
    notes: storeString.optional(),
  })).optional(),
});

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

async function readBoundedRegularFile(path: string, maxBytes: number, label: string): Promise<Buffer> {
  const sizeLabel = maxBytes === MAX_MANIFEST_BYTES ? "1 MiB" : "10 MiB";
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`${label} is not a regular file`);
  if (entry.size > maxBytes) throw new Error(`${label} exceeds the ${sizeLabel} limit`);
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.size > maxBytes) throw new Error(`${label} exceeds the ${sizeLabel} limit`);
    const buffer = Buffer.alloc(before.size + 1);
    let offset = 0;
    while (offset < buffer.byteLength) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.byteLength - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat();
    if (after.size !== before.size || offset > maxBytes) throw new Error(`${label} changed while it was being read`);
    return buffer.subarray(0, offset);
  } finally {
    await handle.close();
  }
}

async function fileMetadata(path: string, file: string): Promise<BackupFile> {
  const before = await lstat(path);
  if (!before.isFile() || before.isSymbolicLink()) throw new Error(`${file} is not a regular file`);
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of createReadStream(path, { flags: "r" })) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    hash.update(buffer);
  }
  const after = await lstat(path);
  if (after.size !== before.size || bytes !== before.size) throw new Error(`${file} changed while it was being hashed`);
  return { file, bytes, sha256: hash.digest("hex") };
}

type StagedDirectory = {
  readonly parent: FileHandle;
  readonly directory: FileHandle;
  readonly name: string;
  publishedName: string | null;
};

function descriptorPath(handle: FileHandle): string {
  return `/proc/self/fd/${handle.fd}`;
}

function stagedFile(stage: StagedDirectory, file: string): string {
  return join(descriptorPath(stage.directory), file);
}

async function pathMatchesDirectory(path: string, directory: FileHandle): Promise<boolean> {
  try {
    const [entry, opened] = await Promise.all([
      lstat(path, { bigint: true }),
      directory.stat({ bigint: true }),
    ]);
    return entry.isDirectory() && entry.dev === opened.dev && entry.ino === opened.ino;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function createStagedDirectory(target: string): Promise<StagedDirectory> {
  const parent = await open(dirname(target), constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  const name = `.${basename(target)}.tmp-${randomUUID()}`;
  try {
    await mkdir(join(descriptorPath(parent), name), { mode: 0o700 });
    const directory = await open(
      join(descriptorPath(parent), name),
      constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
    );
    return { parent, directory, name, publishedName: null };
  } catch (error) {
    await parent.close();
    throw error;
  }
}

async function cleanupStagedDirectory(stage: StagedDirectory): Promise<void> {
  for (const file of await readdir(descriptorPath(stage.directory))) {
    await rm(join(descriptorPath(stage.directory), file), { force: true });
  }
  // There is no inode-conditional rmdir: leave the empty directory rather
  // than risk removing a concurrently substituted parent/name entry.
}

async function closeStagedDirectory(stage: StagedDirectory): Promise<void> {
  try {
    await stage.directory.close();
  } finally {
    await stage.parent.close();
  }
}

async function canonicalPotentialPath(path: string): Promise<string> {
  let existing = resolve(path);
  const missing: string[] = [];
  while (true) {
    try {
      return resolve(await realpath(existing), ...missing.reverse());
    } catch (error) {
      if (!(["ENOENT", "ENOTDIR"] as const).includes((error as NodeJS.ErrnoException).code as "ENOENT" | "ENOTDIR")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw error;
      missing.push(basename(existing));
      existing = parent;
    }
  }
}

async function publishStagedDirectory(
  stage: StagedDirectory,
  target: string,
  label: string,
  hooks: Pick<CreateBackupHooks, "beforePublish" | "atPublicationBoundary">,
  verify?: (anchoredTarget: string) => Promise<void>,
  beforeRename?: () => Promise<void>,
): Promise<void> {
  await hooks.beforePublish?.();
  await hooks.atPublicationBoundary?.();
  await beforeRename?.();
  if (await realpath(dirname(target)) !== await realpath(descriptorPath(stage.parent))) {
    throw new Error(`${label} destination changed during publication`);
  }
  const targetName = basename(target);
  if (!await pathMatchesDirectory(join(descriptorPath(stage.parent), stage.name), stage.directory)) {
    throw new Error(`${label} staging directory changed during publication`);
  }
  const { dlopen, FFIType } = await import("bun:ffi");
  const libc = dlopen("libc.so.6", {
    renameat2: {
      args: [FFIType.i32, FFIType.cstring, FFIType.i32, FFIType.cstring, FFIType.u32],
      returns: FFIType.i32,
    },
  });
  let result: number;
  try {
    result = libc.symbols.renameat2(
      stage.parent.fd,
      Buffer.from(`${stage.name}\0`),
      stage.parent.fd,
      Buffer.from(`${targetName}\0`),
      1,
    );
  } finally {
    libc.close();
  }
  if (result !== 0) {
    try {
      await lstat(join(descriptorPath(stage.parent), targetName));
      throw new Error(`${label} destination already exists: ${target}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      throw new Error(`${label} destination could not be published atomically: ${target}`);
    }
  }
  const anchoredTarget = join(descriptorPath(stage.parent), targetName);
  if (!await pathMatchesDirectory(anchoredTarget, stage.directory)) {
    throw new Error(`${label} staging directory changed during publication`);
  }
  stage.publishedName = targetName;
  await verify?.(anchoredTarget);
  if (!await pathMatchesDirectory(anchoredTarget, stage.directory)) {
    throw new Error(`${label} staging directory changed during publication`);
  }
}

async function assertMigrationSchemaMatchesLedger(databasePath: string): Promise<void> {
  const source = new Database(databasePath, { readonly: true, strict: true });
  const expected = new Database(":memory:", { strict: true });
  try {
    const appliedMigrations = readValidatedMigrationLedger(source);
    runMigrations(expected, migrations.slice(0, appliedMigrations.length));
    const readSchema = (database: Database) => database.query<{
      type: string;
      name: string;
      tableName: string;
      sql: string | null;
    }, []>(`
      SELECT type, name, tbl_name AS tableName, sql
      FROM sqlite_master
      WHERE name NOT GLOB 'sqlite_*'
      ORDER BY type, name
    `).all();
    if (JSON.stringify(readSchema(source)) !== JSON.stringify(readSchema(expected))) {
      throw new Error("Application database schema does not match its migration ledger");
    }
  } finally {
    source.close();
    expected.close();
  }

  const probePath = `${databasePath}.migration-probe-${randomUUID()}`;
  await copyFile(databasePath, probePath, constants.COPYFILE_EXCL);
  try {
    const probe = openDatabase(probePath);
    probe.close();
  } catch (error) {
    throw new Error("Application database schema does not match its migration ledger", { cause: error });
  } finally {
    await rm(probePath, { force: true });
    await rm(`${probePath}-wal`, { force: true });
    await rm(`${probePath}-shm`, { force: true });
  }
}

async function assertPublishedPathUnchanged(target: string, anchoredTarget: string, label: string): Promise<string> {
  let actualTarget: string;
  try {
    actualTarget = await realpath(target);
  } catch {
    throw new Error(`${label} destination changed during publication`);
  }
  if (actualTarget !== await realpath(anchoredTarget)) {
    throw new Error(`${label} destination changed during publication`);
  }
  return actualTarget;
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

export async function createBackupBundle(options: CreateBackupOptions, hooks: CreateBackupHooks = {}): Promise<BackupManifest> {
  if (process.platform !== "linux") throw new Error("Hardened backup/restore requires Linux with glibc and /proc mounted");
  const databasePath = resolve(options.databasePath);
  const bundlePath = resolve(options.bundlePath);
  if (existsSync(bundlePath)) throw new Error(`Backup destination already exists: ${bundlePath}`);
  await mkdir(dirname(bundlePath), { recursive: true });
  const stage = await createStagedDirectory(bundlePath);
  let completed = false;

  try {
    const source = openValidatedReadOnlyDatabase(databasePath);
    try {
      await hooks.beforeSnapshot?.();
      source.query("VACUUM INTO ?").run(stagedFile(stage, DATABASE_FILE));
    } finally {
      source.close();
    }

    const snapshot = openValidatedReadOnlyDatabase(stagedFile(stage, DATABASE_FILE));
    const migrations = readValidatedMigrationLedger(snapshot);
    snapshot.close();
    await assertMigrationSchemaMatchesLedger(stagedFile(stage, DATABASE_FILE));
    await chmod(stagedFile(stage, DATABASE_FILE), 0o600);
    const application = await fileMetadata(stagedFile(stage, DATABASE_FILE), DATABASE_FILE);
    const capturedAt = options.createdAt ?? new Date().toISOString();
    let mcp: BackupManifest["mcp"] = { mode: "ephemeral-regenerated" };
    if (options.mcpDataPath !== undefined) {
      const mcpSource = resolve(options.mcpDataPath);
      const bytes = await readBoundedRegularFile(mcpSource, MAX_MCP_BYTES, "TilbudsTrolden data");
      validateMcpData(bytes);
      await writeFile(stagedFile(stage, MCP_FILE), bytes, { mode: 0o600, flag: "wx" });
      mcp = {
        mode: "persistent-included",
        capturedAt,
        ...(await fileMetadata(stagedFile(stage, MCP_FILE), MCP_FILE)),
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
    await writeFile(stagedFile(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await publishStagedDirectory(stage, bundlePath, "Backup", hooks, async (anchoredTarget) => {
      await assertPublishedPathUnchanged(bundlePath, anchoredTarget, "Backup");
    });
    completed = true;
    return manifest;
  } finally {
    try {
      if (!completed) await cleanupStagedDirectory(stage);
    } finally {
      await closeStagedDirectory(stage);
    }
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
  try {
    const bytes = await readBoundedRegularFile(manifestPath, MAX_MANIFEST_BYTES, "Backup manifest");
    return parseManifest(JSON.parse(bytes.toString("utf8")));
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("Backup manifest is not valid JSON");
    throw error;
  }
}

export async function restoreBackupBundle(options: RestoreBackupOptions, hooks: RestoreBackupHooks = {}) {
  if (process.platform !== "linux") throw new Error("Hardened backup/restore requires Linux with glibc and /proc mounted");
  const sourceDirectory = await open(await realpath(resolve(options.bundlePath)),
    constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try {
    return await restoreFromOpenedBundle(options, hooks, sourceDirectory);
  } finally {
    await sourceDirectory.close();
  }
}

async function assertOutsideOpenedBundle(source: FileHandle, destination: FileHandle): Promise<void> {
  const [sourcePath, destinationPath] = await Promise.all([
    realpath(descriptorPath(source)), realpath(descriptorPath(destination)),
  ]);
  const fromSource = relative(sourcePath, destinationPath);
  if (fromSource === "" || (fromSource !== ".." && !fromSource.startsWith(`..${sep}`) && !isAbsolute(fromSource))) {
    throw new Error("Restore destination must be outside the backup bundle");
  }
}

async function restoreFromOpenedBundle(options: RestoreBackupOptions, hooks: RestoreBackupHooks, sourceDirectory: FileHandle): Promise<{
  readonly databasePath: string;
  readonly mcpDataPath: string | null;
  readonly manifest: BackupManifest;
}> {
  const bundlePath = resolve(options.bundlePath);
  const destination = resolve(options.destinationDirectory);
  const canonicalBundlePath = await realpath(bundlePath);
  const initialDestination = await canonicalPotentialPath(destination);
  const destinationFromBundle = relative(canonicalBundlePath, initialDestination);
  if (destinationFromBundle === ""
    || (destinationFromBundle !== ".." && !destinationFromBundle.startsWith(`..${sep}`) && !isAbsolute(destinationFromBundle))) {
    throw new Error("Restore destination must be outside the backup bundle");
  }
  if (existsSync(destination)) throw new Error(`Restore destination already exists: ${destination}`);
  const openedBundlePath = descriptorPath(sourceDirectory);
  const manifest = await readManifest(openedBundlePath);
  const expectedFiles = new Set([
    MANIFEST_FILE,
    DATABASE_FILE,
    ...(manifest.mcp.mode === "persistent-included" ? [MCP_FILE] : []),
  ]);
  const bundleFiles = await readdir(openedBundlePath);
  const unexpectedFile = bundleFiles.find((file) => !expectedFiles.has(file));
  if (unexpectedFile !== undefined) throw new Error(`Backup bundle contains unexpected file: ${unexpectedFile}`);
  const missingFile = [...expectedFiles].find((file) => !bundleFiles.includes(file));
  if (missingFile !== undefined) throw new Error(`Backup bundle is missing required file: ${missingFile}`);
  const sourceDatabase = join(openedBundlePath, manifest.application.file);
  const databaseEntry = await lstat(sourceDatabase);
  if (!databaseEntry.isFile() || databaseEntry.isSymbolicLink()) {
    throw new Error("Backup application database is not a regular file");
  }

  let mcpBytes: Buffer | null = null;
  if (manifest.mcp.mode === "persistent-included") {
    const sourceMcp = join(openedBundlePath, manifest.mcp.file);
    mcpBytes = await readBoundedRegularFile(sourceMcp, MAX_MCP_BYTES, "Backup TilbudsTrolden data");
    validateMcpData(mcpBytes);
    if (mcpBytes.byteLength !== manifest.mcp.bytes || sha256(mcpBytes) !== manifest.mcp.sha256) {
      throw new Error("Backup TilbudsTrolden data checksum does not match the manifest");
    }
  }

  await mkdir(dirname(destination), { recursive: true });
  const publishedDestination = join(await realpath(dirname(destination)), basename(destination));
  const publishedFromBundle = relative(canonicalBundlePath, publishedDestination);
  if (publishedFromBundle === ""
    || (publishedFromBundle !== ".." && !publishedFromBundle.startsWith(`..${sep}`) && !isAbsolute(publishedFromBundle))) {
    throw new Error("Restore destination must be outside the backup bundle");
  }
  if (existsSync(publishedDestination)) throw new Error(`Restore destination already exists: ${publishedDestination}`);
  const stage = await createStagedDirectory(publishedDestination);
  let completed = false;
  try {
    const restoreToken = randomUUID();
    await writeFile(stagedFile(stage, RESTORE_MARKER_FILE), restoreToken, { mode: 0o600, flag: "wx" });
    const restoredDatabase = stagedFile(stage, DATABASE_FILE);
    await hooks.beforeDatabaseCopy?.();
    if (await realpath(bundlePath) !== canonicalBundlePath) throw new Error("Backup source changed during restore");
    await copyFile(sourceDatabase, restoredDatabase);
    await chmod(restoredDatabase, 0o600);
    const stagedMetadata = await fileMetadata(restoredDatabase, DATABASE_FILE);
    if (stagedMetadata.bytes !== manifest.application.bytes || stagedMetadata.sha256 !== manifest.application.sha256) {
      throw new Error("Backup application database checksum does not match the manifest");
    }
    const staged = openValidatedReadOnlyDatabase(restoredDatabase);
    const actualMigrations = readValidatedMigrationLedger(staged);
    staged.close();
    if (JSON.stringify(actualMigrations) !== JSON.stringify(manifest.application.migrations)) {
      throw new Error("Backup application migration ledger does not match the manifest");
    }
    await assertMigrationSchemaMatchesLedger(restoredDatabase);
    if (mcpBytes !== null) {
      await writeFile(stagedFile(stage, MCP_FILE), mcpBytes, { mode: 0o600, flag: "wx" });
    }
    await writeFile(stagedFile(stage, MANIFEST_FILE), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await publishStagedDirectory(stage, publishedDestination, "Restore", hooks, async (anchoredTarget) => {
      try {
        await assertPublishedPathUnchanged(publishedDestination, anchoredTarget, "Restore");
      } catch {
        throw new Error("Restore destination changed during restore");
      }
      await assertOutsideOpenedBundle(sourceDirectory, stage.directory);
      if (await readFile(stagedFile(stage, RESTORE_MARKER_FILE), "utf8") !== restoreToken) {
        throw new Error("Restore destination changed during restore");
      }
      await rm(stagedFile(stage, RESTORE_MARKER_FILE));
    }, async () => {
      await assertOutsideOpenedBundle(sourceDirectory, stage.parent);
    });
    completed = true;
  } finally {
    try {
      if (!completed) await cleanupStagedDirectory(stage);
    } finally {
      await closeStagedDirectory(stage);
    }
  }
  return {
    databasePath: join(publishedDestination, DATABASE_FILE),
    mcpDataPath: manifest.mcp.mode === "persistent-included" ? join(publishedDestination, MCP_FILE) : null,
    manifest,
  };
}
