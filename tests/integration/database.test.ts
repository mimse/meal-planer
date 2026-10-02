import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { openDatabase, openExistingDatabase } from "../../src/infrastructure/database";
import { migrations, runMigrations, type Migration } from "../../src/infrastructure/migrations";

const temporaryDirectories: string[] = [];
const nextMigrationVersion = migrations.at(-1)!.version + 1;

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meal-planer-database-"));
  temporaryDirectories.push(directory);
  return join(directory, "mealplan.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("openDatabase", () => {
  test("applies all known migrations", async () => {
    const database = openDatabase(await temporaryDatabasePath());

    expect(database.query("PRAGMA foreign_keys").get()).toEqual({ foreign_keys: 1 });
    expect(database.query("SELECT version, name FROM schema_migrations").all()).toEqual(migrations.map(({ version, name }) => ({ version, name })));
    expect(database.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
      ORDER BY name
    `).all()).toEqual([
      { name: "day_profiles" },
      { name: "household_members" },
      { name: "household_rules" },
      { name: "http_cache" },
      { name: "meal_history" },
      { name: "pantry_items" },
      { name: "plan_meal_revisions" },
      { name: "plan_meals" },
      { name: "preferred_stores" },
      { name: "recipe_ingredients" },
      { name: "recipe_instructions" },
      { name: "recipe_prep_links" },
      { name: "recipe_sources" },
      { name: "recipes" },
      { name: "schema_migrations" },
      { name: "weekly_plans" },
      { name: "weekly_recipe_rejections" },
    ]);

    database.close();
  });

  test("rejects an application-shaped database with an empty migration ledger before migration", async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);
    database.exec("DELETE FROM schema_migrations");
    database.close();
    const before = await readFile(path);

    expect(() => openExistingDatabase(path)).toThrow("Application database migration ledger is empty");
    expect(await readFile(path)).toEqual(before);
  });

  test("rejects a version-two database missing any required recipe table without mutation", async () => {
    for (const tableName of ["recipes", "recipe_ingredients", "recipe_instructions"] as const) {
      const path = await temporaryDatabasePath();
      const database = openDatabase(path);
      database.exec(`DROP TABLE ${tableName}`);
      database.close();
      const before = await readFile(path);

      expect(() => openExistingDatabase(path)).toThrow(
        "Family configuration does not exist. Run mealplan setup first.",
      );
      expect(await readFile(path)).toEqual(before);
    }
  });

  test("rejects a version-three database missing its HTTP cache table without mutation", async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);
    database.exec("DROP TABLE http_cache");
    database.close();
    const before = await readFile(path);

    expect(() => openExistingDatabase(path)).toThrow(
      "Family configuration does not exist. Run mealplan setup first.",
    );
    expect(await readFile(path)).toEqual(before);
  });

  test("rejects databases missing migration-four or five tables without mutation", async () => {
    for (const tableName of ["weekly_plans", "plan_meals", "meal_history", "weekly_recipe_rejections", "plan_meal_revisions", "recipe_prep_links"]) {
      const path = await temporaryDatabasePath();
      const database = openDatabase(path);
      database.exec(`DROP TABLE ${tableName}`);
      database.close();
      const before = await readFile(path);
      expect(() => openExistingDatabase(path)).toThrow("Family configuration does not exist");
      expect(await readFile(path)).toEqual(before);
    }
  });

  test("upgrades a legitimate version-one database through openExistingDatabase", async () => {
    const path = await temporaryDatabasePath();
    const versionOne = new Database(path, { create: true, strict: true });
    versionOne.exec("PRAGMA foreign_keys = ON");
    runMigrations(versionOne, [migrations[0]!]);
    versionOne.close();

    const upgraded = openExistingDatabase(path);
    expect(upgraded.query("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual(migrations.map(({ version, name }) => ({ version, name })));
    expect(upgraded.query(`
      SELECT name FROM sqlite_master
      WHERE type = 'table' AND name IN ('recipes', 'recipe_ingredients', 'recipe_instructions')
      ORDER BY name
    `).all()).toEqual([
      { name: "recipe_ingredients" },
      { name: "recipe_instructions" },
      { name: "recipes" },
    ]);
    upgraded.close();
  });

  test("upserts, lists, and removes household members", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const members = createConfigurationRepositories(database).householdMembers;

    expect(members.upsert({ id: "alex", name: " Alex ", kind: "adult", servings: 1 })).toEqual({
      id: "alex",
      name: "Alex",
      kind: "adult",
      servings: 1,
    });
    expect(members.upsert({ id: "alex", name: "Alexandra", kind: "adult", servings: 1.5 })).toEqual({
      id: "alex",
      name: "Alexandra",
      kind: "adult",
      servings: 1.5,
    });
    expect(members.list()).toEqual([
      { id: "alex", name: "Alexandra", kind: "adult", servings: 1.5 },
    ]);
    expect(members.remove("alex")).toBe(true);
    expect(members.get("alex")).toBeNull();
    expect(members.remove("alex")).toBe(false);

    database.close();
  });

  test("rejects malformed household member rows at the repository boundary", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query(`
      INSERT INTO household_members (id, name, kind, servings, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run("invalid member id", "Invalid", "adult", 1, new Date().toISOString());

    expect(() => createConfigurationRepositories(database).householdMembers.list()).toThrow();

    database.close();
  });

  test("uses deterministic identities when upserting household rules", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const repositories = createConfigurationRepositories(database);
    repositories.householdMembers.upsert({ id: "child-1", name: "Robin", kind: "child", servings: 0.75 });

    const first = repositories.householdRules.upsert({
      memberId: "child-1",
      kind: "disliked_ingredient",
      value: "Mushrooms",
    });
    const updated = repositories.householdRules.upsert({
      memberId: "child-1",
      kind: "disliked_ingredient",
      value: "mushrooms",
    });
    const householdRule = repositories.householdRules.upsert({
      memberId: null,
      kind: "dietary_restriction",
      value: "Tree nuts",
    });

    expect(updated.id).toBe(first.id);
    expect(repositories.householdRules.list()).toEqual([
      householdRule,
      { ...first, value: "mushrooms" },
    ]);
    expect(repositories.householdRules.remove(first.id)).toBe(true);
    expect(repositories.householdRules.get(first.id)).toBeNull();

    database.close();
  });

  test("rejects malformed household rule rows at the repository boundary", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const oversizedValue = "x".repeat(501);
    database.query(`
      INSERT INTO household_rules (id, member_id, kind, value, normalized_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      "invalid-rule",
      null,
      "dietary_restriction",
      oversizedValue,
      oversizedValue,
      new Date().toISOString(),
    );

    expect(() => createConfigurationRepositories(database).householdRules.list()).toThrow();

    database.close();
  });

  test("rejects inconsistent persisted household rule identities in get and list", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const rules = createConfigurationRepositories(database).householdRules;
    const insertRule = database.query(`
      INSERT INTO household_rules (id, member_id, kind, value, normalized_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `);
    const inconsistentNormalizedValueId = "rule:household:dietary_restriction:hazelnuts";
    insertRule.run(
      inconsistentNormalizedValueId,
      null,
      "dietary_restriction",
      "Peanuts",
      "hazelnuts",
      new Date().toISOString(),
    );

    expect(() => rules.get(inconsistentNormalizedValueId)).toThrow();
    expect(() => rules.list()).toThrow();

    database.query("DELETE FROM household_rules WHERE id = ?").run(inconsistentNormalizedValueId);
    const inconsistentId = "rule:household:dietary_restriction:hazelnuts";
    insertRule.run(
      inconsistentId,
      null,
      "dietary_restriction",
      "Peanuts",
      "peanuts",
      new Date().toISOString(),
    );

    expect(() => rules.get(inconsistentId)).toThrow();
    expect(() => rules.list()).toThrow();

    database.close();
  });

  test("keeps household-wide and member-scoped rules distinct for a member named household", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const repositories = createConfigurationRepositories(database);
    repositories.householdMembers.upsert({
      id: "household",
      name: "Household",
      kind: "adult",
      servings: 1,
    });

    const householdWide = repositories.householdRules.upsert({
      memberId: null,
      kind: "dietary_restriction",
      value: "Gluten",
    });
    const memberScoped = repositories.householdRules.upsert({
      memberId: "household",
      kind: "dietary_restriction",
      value: "Gluten",
    });

    expect(memberScoped.id).not.toBe(householdWide.id);
    expect(repositories.householdRules.get(householdWide.id)).toEqual(householdWide);
    expect(repositories.householdRules.get(memberScoped.id)).toEqual(memberScoped);
    expect(repositories.householdRules.list()).toEqual([householdWide, memberScoped]);

    database.close();
  });

  test("keeps upsert results consistent with the persisted rule identity", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const repositories = createConfigurationRepositories(database);
    repositories.householdMembers.upsert({
      id: "household",
      name: "Household",
      kind: "adult",
      servings: 1,
    });
    const id = "rule:member:household:dietary_restriction:gluten";
    database.query(`
      INSERT INTO household_rules (id, member_id, kind, value, normalized_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(id, null, "dietary_restriction", "Gluten", "gluten", new Date().toISOString());

    const upserted = repositories.householdRules.upsert({
      memberId: "household",
      kind: "dietary_restriction",
      value: "Gluten",
    });

    expect(upserted).toEqual({
      id,
      memberId: "household",
      kind: "dietary_restriction",
      value: "Gluten",
    });
    expect(repositories.householdRules.get(id)).toEqual(upserted);

    database.close();
  });

  test("upserts editable day profiles by weekday", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const profiles = createConfigurationRepositories(database).dayProfiles;
    const thursday = {
      day: "thu" as const,
      maxTotalMinutes: 30,
      requiredServingModes: [],
      easyOnly: true,
      minimumExtraMeals: 0,
      prepLinkSatisfiesMinimum: false,
      notes: "Badminton night",
    };

    expect(profiles.upsert(thursday)).toEqual(thursday);
    expect(profiles.upsert({ ...thursday, maxTotalMinutes: 25, notes: null })).toEqual({
      ...thursday,
      maxTotalMinutes: 25,
      notes: null,
    });
    expect(profiles.list()).toEqual([{ ...thursday, maxTotalMinutes: 25, notes: null }]);
    expect(profiles.remove("thu")).toBe(true);
    expect(profiles.get("thu")).toBeNull();

    database.close();
  });

  test("rejects malformed day-profile serving-mode arrays at the repository boundary", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query(`
      INSERT INTO day_profiles (
        day, max_total_minutes, required_serving_modes, easy_only,
        minimum_extra_meals, prep_link_satisfies_minimum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(
      "mon",
      30,
      JSON.stringify(["immediate", "keep-warm", "reheat", "assemble-later", "immediate"]),
      0,
      0,
      0,
      null,
    );

    const profiles = createConfigurationRepositories(database).dayProfiles;
    expect(() => profiles.list()).toThrow();

    database.query("DELETE FROM day_profiles WHERE day = ?").run("mon");
    database.query(`
      INSERT INTO day_profiles (
        day, max_total_minutes, required_serving_modes, easy_only,
        minimum_extra_meals, prep_link_satisfies_minimum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("tue", 30, JSON.stringify(["invalid-mode"]), 0, 0, 0, null);
    expect(() => profiles.list()).toThrow();

    database.close();
  });

  test("represents alternative serving and Sunday preparation constraints", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const profiles = createConfigurationRepositories(database).dayProfiles;
    const profile = {
      day: "sun" as const,
      maxTotalMinutes: null,
      requiredServingModes: ["reheat" as const, "assemble-later" as const],
      easyOnly: false,
      minimumExtraMeals: 1,
      prepLinkSatisfiesMinimum: true,
      notes: null,
    };

    expect(profiles.upsert(profile)).toEqual(profile);
    expect(profiles.get("sun")).toEqual(profile);

    database.close();
  });

  test("upserts and enables recipe source configuration", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const sources = createConfigurationRepositories(database).recipeSources;
    const source = {
      id: "mummum",
      name: "Mummum",
      baseUrl: "https://mummum.dk/",
      adapter: "jsonld" as const,
      enabled: true,
    };

    expect(sources.upsert(source)).toEqual(source);
    expect(sources.upsert({ ...source, enabled: false })).toEqual({ ...source, enabled: false });
    expect(sources.list()).toEqual([{ ...source, enabled: false }]);
    expect(sources.remove("mummum")).toBe(true);
    expect(sources.get("mummum")).toBeNull();

    database.close();
  });

  test("rejects malformed recipe-source rows at the repository boundary", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query(`
      INSERT INTO recipe_sources (id, name, base_url, adapter, enabled)
      VALUES (?, ?, ?, ?, ?)
    `).run("invalid-source", "Invalid", "not-a-url", "jsonld", 1);

    expect(() => createConfigurationRepositories(database).recipeSources.list()).toThrow();

    database.close();
  });

  test("keeps raw pantry quantities while upserting by normalized ingredient", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const pantry = createConfigurationRepositories(database).pantryItems;

    const first = pantry.upsert({ name: " Chickpeas ", quantity: "about 2 cans" });
    const updated = pantry.upsert({ name: "chickpeas", quantity: "1½ cans" });

    expect(first).toEqual({
      normalizedName: "chickpeas",
      name: "Chickpeas",
      quantity: "about 2 cans",
    });
    expect(updated.normalizedName).toBe(first.normalizedName);
    expect(pantry.list()).toEqual([updated]);
    expect(pantry.remove("CHICKPEAS")).toBe(true);
    expect(pantry.get("chickpeas")).toBeNull();

    database.close();
  });

  test("rejects malformed pantry rows at the repository boundary", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query(`
      INSERT INTO pantry_items (normalized_name, name, quantity)
      VALUES (?, ?, ?)
    `).run("oversized", "x".repeat(201), "1 bag");

    expect(() => createConfigurationRepositories(database).pantryItems.list()).toThrow();

    database.close();
  });

  test("rejects normalized pantry keys longer than the output limit without writing", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const pantry = createConfigurationRepositories(database).pantryItems;
    const compatibilityLigatures = "ﬃ".repeat(200);

    expect(() => pantry.upsert({ name: compatibilityLigatures, quantity: "1 bag" })).toThrow();
    expect(database.query("SELECT COUNT(*) AS count FROM pantry_items").get()).toEqual({ count: 0 });

    database.close();
  });

  test("preserves all configuration across idempotent reopen", async () => {
    const path = await temporaryDatabasePath();
    const firstDatabase = openDatabase(path);
    const first = createConfigurationRepositories(firstDatabase);
    const member = first.householdMembers.upsert({
      id: "sam",
      name: "Sam",
      kind: "child",
      servings: 0.75,
    });
    const rule = first.householdRules.upsert({
      memberId: null,
      kind: "dietary_restriction",
      value: "Gluten free",
    });
    const profile = first.dayProfiles.upsert({
      day: "tue",
      maxTotalMinutes: 60,
      requiredServingModes: ["keep-warm"],
      easyOnly: false,
      minimumExtraMeals: 0,
      prepLinkSatisfiesMinimum: false,
      notes: null,
    });
    const source = first.recipeSources.upsert({
      id: "example",
      name: "Example",
      baseUrl: "https://example.com/recipes",
      adapter: "auto",
      enabled: true,
    });
    const pantryItem = first.pantryItems.upsert({ name: "Rice", quantity: "ca. 500 g" });
    const store = first.preferredStores.upsert({
      id: "netto",
      name: "Netto",
      dealerId: "9ba51",
      countryCode: "DK",
      priority: 1,
      dealsEnabled: true,
    });
    const appliedAt = firstDatabase
      .query<{ appliedAt: string }, []>("SELECT applied_at AS appliedAt FROM schema_migrations WHERE version = 1")
      .get()?.appliedAt;
    firstDatabase.close();

    const reopenedDatabase = openDatabase(path);
    const reopened = createConfigurationRepositories(reopenedDatabase);

    expect(reopened.householdMembers.get(member.id)).toEqual(member);
    expect(reopened.householdRules.get(rule.id)).toEqual(rule);
    expect(reopened.dayProfiles.get(profile.day)).toEqual(profile);
    expect(reopened.recipeSources.get(source.id)).toEqual(source);
    expect(reopened.pantryItems.get(pantryItem.name)).toEqual(pantryItem);
    expect(reopened.preferredStores.get(store.id)).toEqual(store);
    expect(reopenedDatabase
      .query<{ appliedAt: string }, []>("SELECT applied_at AS appliedAt FROM schema_migrations WHERE version = 1")
      .get()?.appliedAt).toBe(appliedAt);

    reopenedDatabase.close();
  });

  test("upserts preferred stores while preserving provider dealer IDs", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const stores = createConfigurationRepositories(database).preferredStores;
    const store = {
      id: "rema-1000",
      name: "REMA 1000",
      dealerId: "11deC",
      countryCode: "DK",
      priority: 0,
      dealsEnabled: true,
    };

    expect(stores.upsert(store)).toEqual(store);
    expect(stores.upsert({ ...store, dealerId: null, dealsEnabled: false })).toEqual({
      ...store,
      dealerId: null,
      dealsEnabled: false,
    });
    expect(stores.list()).toEqual([{ ...store, dealerId: null, dealsEnabled: false }]);
    expect(stores.remove("rema-1000")).toBe(true);
    expect(stores.get("rema-1000")).toBeNull();

    database.close();
  });

  test("rejects malformed preferred-store rows at the repository boundary", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query(`
      INSERT INTO preferred_stores (
        id, name, dealer_id, country_code, priority, deals_enabled
      ) VALUES (?, ?, ?, ?, ?, ?)
    `).run("invalid-store", "Invalid", null, "dk", 99, 1);

    expect(() => createConfigurationRepositories(database).preferredStores.list()).toThrow();

    database.close();
  });

  test("enforces repository validation and relational invariants", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const repositories = createConfigurationRepositories(database);

    expect(() => repositories.householdRules.upsert({
      memberId: "missing",
      kind: "dietary_restriction",
      value: "Peanuts",
    })).toThrow("FOREIGN KEY constraint failed");
    expect(() => repositories.dayProfiles.upsert({
      day: "mon",
      maxTotalMinutes: 0,
      requiredServingModes: [],
      easyOnly: false,
      minimumExtraMeals: 0,
      prepLinkSatisfiesMinimum: false,
      notes: null,
    })).toThrow();
    expect(() => repositories.recipeSources.upsert({
      id: "unsafe",
      name: "Unsafe",
      baseUrl: "file:///etc/passwd",
      adapter: "auto",
      enabled: true,
    })).toThrow("Recipe source URL must use HTTP or HTTPS");
    expect(() => repositories.recipeSources.upsert({
      id: "unsupported",
      name: "Unsupported",
      baseUrl: "https://example.com/",
      adapter: "imaginary" as "auto",
      enabled: true,
    })).toThrow();
    expect(() => repositories.recipeSources.upsert({
      id: "oversized-url",
      name: "Oversized URL",
      baseUrl: `https://example.com/${"x".repeat(2_048)}`,
      adapter: "auto",
      enabled: true,
    })).toThrow();
    expect(() => repositories.pantryItems.upsert({ name: "Rice", quantity: "   " })).toThrow(
      "Pantry quantity cannot be empty",
    );

    repositories.householdMembers.upsert({ id: "child-1", name: "Robin", kind: "child", servings: 1 });
    const rule = repositories.householdRules.upsert({
      memberId: "child-1",
      kind: "disliked_ingredient",
      value: "Olives",
    });
    repositories.householdMembers.remove("child-1");
    expect(repositories.householdRules.get(rule.id)).toBeNull();

    database.close();
  });

  test("rejects an applied migration newer than the known migration history", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(99, "future migration", new Date().toISOString());

    expect(() => runMigrations(database)).toThrow(
      "Applied migration 99 (future migration) is not in the known migration history",
    );

    database.close();
  });

  test("rejects an applied migration ledger with a gap", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const knownHistory: readonly Migration[] = [
      ...migrations,
      { version: nextMigrationVersion, name: "fifth migration", up() {} },
      { version: nextMigrationVersion + 1, name: "sixth migration", up() {} },
    ];
    database.query(`
      INSERT INTO schema_migrations (version, name, applied_at)
      VALUES (?, ?, ?)
    `).run(nextMigrationVersion + 1, "sixth migration", new Date().toISOString());

    expect(() => runMigrations(database, knownHistory)).toThrow(
      `Migration ledger is not a known ordered prefix: expected ${nextMigrationVersion} (fifth migration), found ${nextMigrationVersion + 1} (sixth migration)`,
    );

    database.close();
  });

  test("rejects a renamed applied migration", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    database.query("UPDATE schema_migrations SET name = ? WHERE version = ?")
      .run("renamed initial migration", 1);

    expect(() => runMigrations(database)).toThrow(
      "Migration ledger is not a known ordered prefix: expected 1 (initial configuration), found 1 (renamed initial migration)",
    );

    database.close();
  });

  test("rejects reordered applied migration names", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const knownHistory: readonly Migration[] = [
      ...migrations,
    ];
    database.query("UPDATE schema_migrations SET name = ? WHERE version = ?")
      .run("second migration", 1);
    expect(() => runMigrations(database, knownHistory)).toThrow(
      "Migration ledger is not a known ordered prefix: expected 1 (initial configuration), found 1 (second migration)",
    );

    database.close();
  });

  test("persists a successful subsequent migration across close and reopen", async () => {
    const path = await temporaryDatabasePath();
    const subsequentMigration: Migration = {
      version: nextMigrationVersion,
      name: "subsequent migration",
      up(database) {
        database.exec("CREATE TABLE subsequent_migration_probe (id TEXT PRIMARY KEY) STRICT");
      },
    };
    const knownHistory = [...migrations, subsequentMigration];
    const firstDatabase = openDatabase(path);

    runMigrations(firstDatabase, knownHistory);
    firstDatabase.close();

    const reopenedDatabase = new Database(path, { strict: true });
    runMigrations(reopenedDatabase, knownHistory);
    expect(reopenedDatabase.query("SELECT version, name FROM schema_migrations ORDER BY version").all())
      .toEqual(knownHistory.map(({ version, name }) => ({ version, name })));
    expect(reopenedDatabase.query(`
      SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'subsequent_migration_probe'
    `).get()).toEqual({ name: "subsequent_migration_probe" });
    reopenedDatabase.close();
  });

  test("waits a bounded time during concurrent openDatabase migration startup", async () => {
    const path = await temporaryDatabasePath();
    const firstDatabase = openDatabase(path);
    firstDatabase.exec("BEGIN IMMEDIATE");
    const databaseModuleUrl = new URL(
      "../../src/infrastructure/database.ts",
      import.meta.url,
    ).href;
    const runner = `
      import { openDatabase } from ${JSON.stringify(databaseModuleUrl)};

      const database = openDatabase(${JSON.stringify(path)});
      database.close();
    `;
    const secondRunner = Bun.spawn(
      [process.execPath, "--eval", runner],
      { cwd: join(import.meta.dir, "../.."), stderr: "pipe" },
    );

    await Bun.sleep(250);
    firstDatabase.exec("COMMIT");
    firstDatabase.close();

    const exitCode = await secondRunner.exited;
    const error = await new Response(secondRunner.stderr).text();
    expect(exitCode, error).toBe(0);

    const reopenedDatabase = openDatabase(path);
    expect(reopenedDatabase.query("PRAGMA busy_timeout").get()).toEqual({ timeout: 5_000 });
    expect(reopenedDatabase.query("SELECT version, name FROM schema_migrations").all()).toEqual(migrations.map(({ version, name }) => ({ version, name })));
    reopenedDatabase.close();
  });

  test("rolls back every statement and tracking row from a failing migration", async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);
    const successfulMigration: Migration = {
      version: nextMigrationVersion,
      name: "successful before failure",
      up(migrationDatabase) {
        migrationDatabase.exec("CREATE TABLE committed_before_failure (id TEXT PRIMARY KEY) STRICT");
      },
    };
    const failingMigration: Migration = {
      version: nextMigrationVersion + 1,
      name: "deliberate failure",
      up(migrationDatabase) {
        migrationDatabase.exec("CREATE TABLE should_be_rolled_back (id TEXT PRIMARY KEY) STRICT");
        migrationDatabase.query(`
          INSERT INTO household_members (id, name, kind, servings, created_at)
          VALUES (?, ?, ?, ?, ?)
        `).run("rolled-back", "Rolled Back", "adult", 1, new Date().toISOString());
        throw new Error("deliberate migration failure");
      },
    };

    expect(() => runMigrations(database, [
      ...migrations,
      successfulMigration,
      failingMigration,
    ])).toThrow("deliberate migration failure");
    expect(database.query("SELECT name FROM sqlite_master WHERE name = 'committed_before_failure'").get())
      .toEqual({ name: "committed_before_failure" });
    expect(database.query("SELECT version FROM schema_migrations WHERE version = ?").get(nextMigrationVersion))
      .toEqual({ version: nextMigrationVersion });
    expect(database.query("SELECT name FROM sqlite_master WHERE name = 'should_be_rolled_back'").get()).toBeNull();
    expect(database.query("SELECT id FROM household_members WHERE id = 'rolled-back'").get()).toBeNull();
    expect(database.query("SELECT version FROM schema_migrations WHERE version = ?").get(nextMigrationVersion + 1)).toBeNull();

    database.close();

    const reopened = new Database(path, { strict: true });
    expect(reopened.query("SELECT name FROM sqlite_master WHERE name = 'committed_before_failure'").get())
      .toEqual({ name: "committed_before_failure" });
    expect(reopened.query("SELECT name FROM sqlite_master WHERE name = 'should_be_rolled_back'").get()).toBeNull();
    reopened.close();
  });
});
