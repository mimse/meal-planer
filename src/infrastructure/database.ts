import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { readValidatedMigrationLedger, runMigrations } from "./migrations";

const REQUIRED_CONFIGURATION_TABLES = [
  "day_profiles",
  "household_members",
  "household_rules",
  "pantry_items",
  "preferred_stores",
  "recipe_sources",
  "schema_migrations",
] as const;
const REQUIRED_RECIPE_TABLES = [
  "recipes",
  "recipe_ingredients",
  "recipe_instructions",
] as const;
const REQUIRED_CACHE_TABLES = ["http_cache"] as const;
const REQUIRED_PLAN_TABLES = ["weekly_plans", "plan_meals", "meal_history"] as const;
const REQUIRED_REPLACEMENT_TABLES = ["weekly_recipe_rejections", "plan_meal_revisions", "recipe_prep_links"] as const;

function assertApplicationDatabase(database: Database): void {
  const tableNames = new Set(database
    .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all()
    .map(({ name }) => name));
  if (REQUIRED_CONFIGURATION_TABLES.some((tableName) => !tableNames.has(tableName))) {
    throw new Error("Family configuration does not exist. Run mealplan setup first.");
  }
  const appliedMigrations = readValidatedMigrationLedger(database);
  if (appliedMigrations.length === 0) {
    throw new Error("Application database migration ledger is empty");
  }
  if (
    appliedMigrations.some(({ version }) => version >= 2)
    && REQUIRED_RECIPE_TABLES.some((tableName) => !tableNames.has(tableName))
  ) {
    throw new Error("Family configuration does not exist. Run mealplan setup first.");
  }
  if (
    appliedMigrations.some(({ version }) => version >= 3)
    && REQUIRED_CACHE_TABLES.some((tableName) => !tableNames.has(tableName))
  ) {
    throw new Error("Family configuration does not exist. Run mealplan setup first.");
  }
  for (const [version, requiredTables] of [[4, REQUIRED_PLAN_TABLES], [5, REQUIRED_REPLACEMENT_TABLES]] as const) {
    if (appliedMigrations.some((migration) => migration.version >= version) && requiredTables.some((table) => !tableNames.has(table))) {
      throw new Error("Family configuration does not exist. Run mealplan setup first.");
    }
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
