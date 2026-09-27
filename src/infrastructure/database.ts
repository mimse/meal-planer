import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readValidatedMigrationLedger, runMigrations } from "./migrations";

const REQUIRED_APPLICATION_TABLES = [
  "day_profiles",
  "household_members",
  "household_rules",
  "pantry_items",
  "preferred_stores",
  "recipe_sources",
  "schema_migrations",
] as const;

function assertApplicationDatabase(database: Database): void {
  const tableNames = new Set(database
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(({ name }) => name));
  if (REQUIRED_APPLICATION_TABLES.some((tableName) => !tableNames.has(tableName))) {
    throw new Error("Family configuration does not exist. Run mealplan setup first.");
  }
  if (readValidatedMigrationLedger(database).length === 0) {
    throw new Error("Application database migration ledger is empty");
  }
}

export function openDatabase(path: string): Database {
  const database = new Database(path, { create: true, strict: true });

  try {
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export async function openApplicationDatabase(path: string): Promise<Database> {
  await mkdir(dirname(path), { recursive: true });
  return openDatabase(path);
}

export function openExistingDatabase(path: string): Database {
  if (!existsSync(path)) {
    throw new Error("Family configuration does not exist. Run mealplan setup first.");
  }
  const database = new Database(path, { create: false, strict: true });

  try {
    assertApplicationDatabase(database);
    database.exec("PRAGMA foreign_keys = ON");
    database.exec("PRAGMA busy_timeout = 5000");
    runMigrations(database);
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}
