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
  {
    version: 2,
    name: "recipe ingestion persistence",
    up(database) {
      database.exec(`
        CREATE TABLE recipes (
          id TEXT PRIMARY KEY CHECK (length(id) = 71),
          identity_key TEXT NOT NULL UNIQUE CHECK (length(identity_key) BETWEEN 1 AND 2200),
          source_id TEXT NOT NULL CHECK (length(source_id) BETWEEN 1 AND 100)
            REFERENCES recipe_sources(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          source_url TEXT NOT NULL CHECK (length(source_url) BETWEEN 1 AND 2048),
          canonical_url TEXT NOT NULL CHECK (length(canonical_url) BETWEEN 1 AND 2048),
          normalized_canonical_url TEXT NOT NULL CHECK (length(normalized_canonical_url) BETWEEN 1 AND 2048),
          title TEXT NOT NULL CHECK (length(trim(title)) BETWEEN 1 AND 500),
          normalized_title TEXT NOT NULL CHECK (length(normalized_title) BETWEEN 1 AND 500),
          author TEXT CHECK (author IS NULL OR length(trim(author)) BETWEEN 1 AND 300),
          servings REAL CHECK (servings IS NULL OR servings > 0 AND servings <= 1000000),
          prep_minutes INTEGER CHECK (prep_minutes IS NULL OR prep_minutes BETWEEN 0 AND 525600),
          cook_minutes INTEGER CHECK (cook_minutes IS NULL OR cook_minutes BETWEEN 0 AND 525600),
          total_minutes INTEGER CHECK (total_minutes IS NULL OR total_minutes BETWEEN 0 AND 525600),
          cuisine_tags TEXT NOT NULL CHECK (
            length(cuisine_tags) <= 10000 AND json_valid(cuisine_tags) AND json_type(cuisine_tags) = 'array'
          ),
          protein_tag TEXT CHECK (protein_tag IS NULL OR length(protein_tag) BETWEEN 1 AND 64),
          dietary_tags TEXT NOT NULL CHECK (
            length(dietary_tags) <= 10000 AND json_valid(dietary_tags) AND json_type(dietary_tags) = 'array'
          ),
          suitability_tags TEXT NOT NULL CHECK (
            length(suitability_tags) <= 10000 AND json_valid(suitability_tags)
              AND json_type(suitability_tags) = 'array'
          ),
          extra_meal_servings REAL NOT NULL CHECK (extra_meal_servings BETWEEN 0 AND 1000000),
          preference TEXT NOT NULL CHECK (preference IN ('favorite', 'neutral', 'disliked')),
          needs_review INTEGER NOT NULL CHECK (needs_review IN (0, 1)),
          parser_version TEXT NOT NULL CHECK (length(trim(parser_version)) BETWEEN 1 AND 100),
          fetched_at TEXT NOT NULL CHECK (length(fetched_at) BETWEEN 1 AND 50),
          raw_source_payload TEXT NOT NULL CHECK (
            length(raw_source_payload) <= 1000000 AND json_valid(raw_source_payload)
          ),
          source_evidence TEXT NOT NULL CHECK (
            length(source_evidence) <= 250000 AND json_valid(source_evidence)
          )
        ) STRICT;

        CREATE UNIQUE INDEX recipes_canonical_identity
          ON recipes(normalized_canonical_url);
        CREATE UNIQUE INDEX recipes_source_title_identity
          ON recipes(source_id, normalized_title);
        CREATE INDEX recipes_source_id ON recipes(source_id);
        CREATE INDEX recipes_normalized_title ON recipes(normalized_title);

        CREATE TABLE recipe_ingredients (
          recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE ON UPDATE RESTRICT,
          ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 499),
          raw_text TEXT NOT NULL CHECK (length(trim(raw_text)) BETWEEN 1 AND 2000),
          normalized_name TEXT CHECK (
            normalized_name IS NULL OR length(normalized_name) BETWEEN 1 AND 300
          ),
          quantity REAL CHECK (quantity IS NULL OR quantity > 0 AND quantity <= 1000000000),
          unit TEXT CHECK (unit IS NULL OR length(trim(unit)) BETWEEN 1 AND 100),
          uncertain INTEGER NOT NULL CHECK (uncertain IN (0, 1)),
          PRIMARY KEY (recipe_id, ordinal)
        ) STRICT;

        CREATE INDEX recipe_ingredients_normalized_name
          ON recipe_ingredients(normalized_name) WHERE normalized_name IS NOT NULL;

        CREATE TABLE recipe_instructions (
          recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE CASCADE ON UPDATE RESTRICT,
          ordinal INTEGER NOT NULL CHECK (ordinal BETWEEN 0 AND 499),
          text TEXT NOT NULL CHECK (length(trim(text)) BETWEEN 1 AND 5000),
          PRIMARY KEY (recipe_id, ordinal)
        ) STRICT;
      `);
    },
  },
  {
    version: 3,
    name: "bounded HTTP cache",
    up(database) {
      database.exec(`
        CREATE TABLE http_cache (
          url TEXT PRIMARY KEY CHECK (length(url) BETWEEN 1 AND 2048),
          final_url TEXT NOT NULL CHECK (length(final_url) BETWEEN 1 AND 2048),
          media_type TEXT NOT NULL CHECK (media_type IN (
            'text/plain', 'application/xml', 'text/xml', 'text/html', 'application/xhtml+xml'
          )),
          body TEXT NOT NULL CHECK (length(CAST(body AS BLOB)) <= 2097152),
          fetched_at TEXT NOT NULL CHECK (length(fetched_at) BETWEEN 20 AND 30),
          etag TEXT CHECK (etag IS NULL OR length(etag) BETWEEN 1 AND 1024),
          last_modified TEXT CHECK (last_modified IS NULL OR length(last_modified) BETWEEN 1 AND 1024),
          access_sequence INTEGER NOT NULL CHECK (access_sequence >= 0)
        ) STRICT;

        CREATE INDEX http_cache_lru ON http_cache(access_sequence, url);
      `);
    },
  },
  {
    version: 4,
    name: "family-aware weekly plans",
    up(database) {
      database.exec(`
        CREATE TABLE weekly_plans (
          id TEXT PRIMARY KEY CHECK (length(id) = 69),
          week_start TEXT NOT NULL CHECK (length(week_start) = 10),
          shopping_date TEXT NOT NULL CHECK (length(shopping_date) = 10),
          planned_at TEXT NOT NULL CHECK (length(planned_at) BETWEEN 20 AND 30),
          status TEXT NOT NULL CHECK (status IN ('draft', 'accepted', 'completed', 'superseded')),
          seed TEXT NOT NULL CHECK (length(seed) BETWEEN 1 AND 500),
          score_summary TEXT NOT NULL CHECK (
            length(score_summary) <= 250000 AND json_valid(score_summary)
              AND json_type(score_summary) = 'object'
          )
        ) STRICT;

        CREATE UNIQUE INDEX weekly_plans_one_draft_per_week
          ON weekly_plans(week_start) WHERE status = 'draft';
        CREATE UNIQUE INDEX weekly_plans_one_accepted_per_week
          ON weekly_plans(week_start) WHERE status = 'accepted';
        CREATE INDEX weekly_plans_week_status ON weekly_plans(week_start, status);

        CREATE TABLE plan_meals (
          id TEXT PRIMARY KEY CHECK (length(id) = 69),
          plan_id TEXT NOT NULL REFERENCES weekly_plans(id) ON DELETE CASCADE ON UPDATE RESTRICT,
          day TEXT NOT NULL CHECK (day IN ('mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun')),
          date TEXT NOT NULL CHECK (length(date) = 10),
          recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          servings REAL NOT NULL CHECK (servings > 0 AND servings <= 1000000),
          locked INTEGER NOT NULL DEFAULT 0 CHECK (locked IN (0, 1)),
          rationale TEXT NOT NULL CHECK (
            length(rationale) <= 100000 AND json_valid(rationale) AND json_type(rationale) = 'array'
          ),
          prep_links TEXT NOT NULL CHECK (
            length(prep_links) <= 100000 AND json_valid(prep_links) AND json_type(prep_links) = 'array'
          ),
          content_hash TEXT NOT NULL CHECK (length(content_hash) = 64),
          UNIQUE(plan_id, day),
          UNIQUE(plan_id, date)
        ) STRICT;

        CREATE INDEX plan_meals_recipe_id ON plan_meals(recipe_id);

        CREATE TABLE meal_history (
          id TEXT PRIMARY KEY CHECK (length(id) = 72),
          recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          cooked_on TEXT NOT NULL CHECK (length(cooked_on) = 10),
          plan_id TEXT NOT NULL REFERENCES weekly_plans(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          plan_meal_id TEXT NOT NULL REFERENCES plan_meals(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 30),
          UNIQUE(plan_meal_id)
        ) STRICT;

        CREATE INDEX meal_history_cooked_on ON meal_history(cooked_on DESC, recipe_id);
      `);
    },
  },
  {
    version: 5,
    name: "atomic meal replacement and preparation links",
    up(database) {
      database.exec(`
        CREATE TABLE weekly_recipe_rejections (
          week_start TEXT NOT NULL CHECK (length(week_start) = 10),
          recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 30),
          PRIMARY KEY (week_start, recipe_id)
        ) STRICT;
        CREATE TABLE plan_meal_revisions (
          id INTEGER PRIMARY KEY,
          plan_id TEXT NOT NULL REFERENCES weekly_plans(id) ON DELETE CASCADE ON UPDATE RESTRICT,
          plan_meal_id TEXT NOT NULL REFERENCES plan_meals(id) ON DELETE CASCADE ON UPDATE RESTRICT,
          original_hash TEXT NOT NULL CHECK (length(original_hash) = 64),
          replacement_hash TEXT NOT NULL CHECK (length(replacement_hash) = 64),
          original_recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          replacement_recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          rejection TEXT NOT NULL CHECK (rejection IN ('not-this-week', 'disliked', 'none')),
          recorded_at TEXT NOT NULL CHECK (length(recorded_at) BETWEEN 20 AND 30)
        ) STRICT;
        CREATE INDEX plan_meal_revisions_meal ON plan_meal_revisions(plan_meal_id, id);
        CREATE TABLE recipe_prep_links (
          id TEXT PRIMARY KEY,
          source_recipe_id TEXT NOT NULL REFERENCES recipes(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          target_meal_id TEXT NOT NULL REFERENCES plan_meals(id) ON DELETE RESTRICT ON UPDATE RESTRICT,
          kind TEXT NOT NULL CHECK (kind IN ('prep', 'leftover')),
          normalized_ingredient TEXT NOT NULL CHECK (length(trim(normalized_ingredient)) > 0),
          quantity REAL NOT NULL CHECK (quantity > 0 AND quantity <= 1000000000),
          unit TEXT NOT NULL CHECK (length(trim(unit)) > 0),
          note TEXT NOT NULL
        ) STRICT;
        CREATE INDEX recipe_prep_links_source ON recipe_prep_links(source_recipe_id);
        CREATE INDEX recipe_prep_links_target ON recipe_prep_links(target_meal_id);
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

export function readValidatedMigrationLedger(
  database: Database,
  pendingMigrations: readonly Migration[] = migrations,
): readonly { readonly version: number; readonly name: string }[] {
  validateMigrations(pendingMigrations);
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
  return appliedRows;
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
    const appliedRows = readValidatedMigrationLedger(database, pendingMigrations);

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
