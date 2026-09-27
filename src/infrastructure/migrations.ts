import type { Database } from "bun:sqlite";

export type Migration = {
  readonly version: number;
  readonly name: string;
  readonly up: (database: Database) => void;
};

export const migrations: readonly Migration[] = [
  {
    version: 1,
    name: "initial configuration",
    up(database) {
      database.exec(`
        CREATE TABLE household_members (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          kind TEXT NOT NULL CHECK (kind IN ('adult', 'child')),
          servings REAL NOT NULL DEFAULT 1 CHECK (servings > 0),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE TABLE household_rules (
          id TEXT PRIMARY KEY,
          member_id TEXT REFERENCES household_members(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('dietary_restriction', 'disliked_ingredient')),
          value TEXT NOT NULL CHECK (length(trim(value)) > 0),
          normalized_value TEXT NOT NULL CHECK (length(normalized_value) > 0),
          created_at TEXT NOT NULL
        ) STRICT;

        CREATE INDEX household_rules_member_id ON household_rules(member_id);
        CREATE UNIQUE INDEX household_rules_identity
          ON household_rules(ifnull(member_id, ''), kind, normalized_value);

        CREATE TABLE day_profiles (
          day TEXT PRIMARY KEY CHECK (day IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
          max_total_minutes INTEGER CHECK (max_total_minutes IS NULL OR max_total_minutes > 0),
          required_serving_modes TEXT NOT NULL DEFAULT '[]' CHECK (
            json_valid(required_serving_modes) AND json_type(required_serving_modes) = 'array'
          ),
          easy_only INTEGER NOT NULL DEFAULT 0 CHECK (easy_only IN (0, 1)),
          minimum_extra_meals INTEGER NOT NULL DEFAULT 0 CHECK (minimum_extra_meals >= 0),
          prep_link_satisfies_minimum INTEGER NOT NULL DEFAULT 0 CHECK (
            prep_link_satisfies_minimum IN (0, 1)
          ),
          notes TEXT
        ) STRICT;

        CREATE TABLE recipe_sources (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          base_url TEXT NOT NULL UNIQUE,
          adapter TEXT NOT NULL CHECK (length(trim(adapter)) > 0),
          enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1))
        ) STRICT;

        CREATE TABLE pantry_items (
          normalized_name TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          quantity TEXT NOT NULL CHECK (length(trim(quantity)) > 0)
        ) STRICT;

        CREATE TABLE preferred_stores (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL CHECK (length(trim(name)) > 0),
          dealer_id TEXT,
          country_code TEXT NOT NULL DEFAULT 'DK' CHECK (length(country_code) = 2),
          priority INTEGER NOT NULL CHECK (priority >= 0),
          deals_enabled INTEGER NOT NULL DEFAULT 1 CHECK (deals_enabled IN (0, 1)),
          UNIQUE(priority)
        ) STRICT;
      `);
    },
  },
];

function validateMigrations(pendingMigrations: readonly Migration[]): void {
  const versions = new Set<number>();
  let previousVersion = 0;

  for (const migration of pendingMigrations) {
    if (!Number.isSafeInteger(migration.version) || migration.version <= previousVersion) {
      throw new Error("Migration versions must be positive and strictly increasing");
    }
    if (versions.has(migration.version)) {
      throw new Error(`Duplicate migration version ${migration.version}`);
    }
    versions.add(migration.version);
    previousVersion = migration.version;
  }
}

export function runMigrations(
  database: Database,
  pendingMigrations: readonly Migration[] = migrations,
): void {
  validateMigrations(pendingMigrations);
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TEXT NOT NULL
    ) STRICT;
  `);

  let migrationFailure: { readonly error: unknown } | undefined;

  database.transaction(() => {
    const appliedRows = database
      .query<{ version: number; name: string }, []>(
        "SELECT version, name FROM schema_migrations ORDER BY version",
      )
      .all();

    for (const [index, appliedMigration] of appliedRows.entries()) {
      const expectedMigration = pendingMigrations[index];
      if (expectedMigration === undefined) {
        throw new Error(
          `Applied migration ${appliedMigration.version} (${appliedMigration.name}) is not in the known migration history`,
        );
      }
      if (
        appliedMigration.version !== expectedMigration.version
        || appliedMigration.name !== expectedMigration.name
      ) {
        throw new Error(
          `Migration ledger is not a known ordered prefix: expected ${expectedMigration.version} (${expectedMigration.name}), found ${appliedMigration.version} (${appliedMigration.name})`,
        );
      }
    }

    for (const migration of pendingMigrations.slice(appliedRows.length)) {
      try {
        database.transaction(() => {
          migration.up(database);
          database
            .query("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)")
            .run(migration.version, migration.name, new Date().toISOString());
        })();
      } catch (error) {
        migrationFailure = { error };
        break;
      }
    }
  }).immediate();

  if (migrationFailure !== undefined) {
    throw migrationFailure.error;
  }
}
