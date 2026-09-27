import { Database } from "bun:sqlite";
import { runMigrations } from "./migrations";

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
