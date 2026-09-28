import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { openDatabase } from "../../src/infrastructure/database";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import {
  createRecipeId,
  createRecipeRepository,
  normalizeRecipeCanonicalUrl,
  type RecipeImport,
} from "../../src/infrastructure/recipe-repository";
import { migrations, runMigrations } from "../../src/infrastructure/migrations";
import { removeRecipeSource, setRecipeSourceEnabled } from "../../src/commands/sources";

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meal-planer-recipes-"));
  temporaryDirectories.push(directory);
  return join(directory, "mealplan.sqlite");
}

function addSource(
  database: ReturnType<typeof openDatabase>,
  id = "example",
  baseUrl = `https://${id}.dk/`,
): void {
  createConfigurationRepositories(database).recipeSources.upsert({
    id,
    name: "Example Recipes",
    baseUrl,
    adapter: "jsonld",
    enabled: true,
  });
}

function recipeImport(overrides: Partial<RecipeImport> = {}): RecipeImport {
  return {
    sourceId: "example",
    sourceUrl: "https://example.dk/recipes/tomatpasta?ref=feed",
    canonicalUrl: "https://example.dk/recipes/tomatpasta/",
    title: " Tomatpasta ",
    author: null,
    servings: null,
    prepMinutes: 15,
    cookMinutes: null,
    totalMinutes: 40,
    cuisineTags: ["italian"],
    proteinTag: null,
    dietaryTags: ["vegetarian"],
    suitabilityTags: ["quick", "reheatFriendly"],
    extraMealServings: 0,
    preference: "neutral",
    needsReview: true,
    parserVersion: "jsonld@1",
    fetchedAt: "2026-09-27T10:15:00.000Z",
    rawSourcePayload: { "@type": "Recipe", name: "Tomatpasta" },
    sourceEvidence: { kind: "jsonld", selector: "script[type='application/ld+json']" },
    ingredients: [
      {
        rawText: "ca. 400 g pasta",
        normalizedName: "pasta",
        quantity: 400,
        unit: "g",
        uncertain: true,
      },
      {
        rawText: "Salt efter smag",
        normalizedName: null,
        quantity: null,
        unit: null,
        uncertain: true,
      },
    ],
    instructions: ["Kog pastaen.", "Bland saucen i."],
    ...overrides,
  };
}

function withAfterParentReadHook(database: Database, afterParentRead: () => void): Database {
  let hookPending = true;
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (property !== "query") return typeof value === "function" ? value.bind(target) : value;
      return (sql: string) => {
        const statement = target.query(sql);
        if (!sql.includes("raw_source_payload AS rawSourcePayloadJson")) return statement;
        return new Proxy(statement, {
          get(statementTarget, statementProperty) {
            const statementValue = Reflect.get(statementTarget, statementProperty, statementTarget);
            if (
              hookPending
              && (statementProperty === "get" || statementProperty === "all")
              && typeof statementValue === "function"
            ) {
              return (...parameters: unknown[]) => {
                const result = Reflect.apply(statementValue, statementTarget, parameters);
                hookPending = false;
                afterParentRead();
                return result;
              };
            }
            return typeof statementValue === "function" ? statementValue.bind(statementTarget) : statementValue;
          },
        });
      };
    },
  });
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("recipe persistence", () => {
  test("migrates normalized recipe tables and preserves the version across reopen", async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);

    expect(database.query("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "initial configuration" },
      { version: 2, name: "recipe ingestion persistence" },
      { version: 3, name: "bounded HTTP cache" },
    ]);
    expect(database.query(`
      SELECT name
      FROM sqlite_master
      WHERE type = 'table' AND name IN ('recipes', 'recipe_ingredients', 'recipe_instructions')
      ORDER BY name
    `).all()).toEqual([
      { name: "recipe_ingredients" },
      { name: "recipe_instructions" },
      { name: "recipes" },
    ]);
    database.close();

    const reopened = openDatabase(path);
    expect(reopened.query("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 2").get())
      .toEqual({ count: 1 });
    reopened.close();
  });

  test("upgrades and reopens an existing version-one configuration database", async () => {
    const path = await temporaryDatabasePath();
    const versionOne = new Database(path, { create: true, strict: true });
    versionOne.exec("PRAGMA foreign_keys = ON");
    runMigrations(versionOne, [migrations[0]!]);
    versionOne.close();

    const upgraded = openDatabase(path);
    expect(upgraded.query("SELECT version, name FROM schema_migrations ORDER BY version").all()).toEqual([
      { version: 1, name: "initial configuration" },
      { version: 2, name: "recipe ingestion persistence" },
      { version: 3, name: "bounded HTTP cache" },
    ]);
    upgraded.close();

    const reopened = openDatabase(path);
    expect(reopened.query("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 3 });
    reopened.close();
  });

  test("imports and reads a complete recipe without inventing nullable ingredient data", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);

    const imported = recipes.import(recipeImport());

    expect(imported.id).toBe(createRecipeId("https://example.dk/recipes/tomatpasta/"));
    expect(imported).toEqual({
      id: imported.id,
      ...recipeImport(),
      title: "Tomatpasta",
      normalizedTitle: "tomatpasta",
    });
    expect(recipes.get(imported.id)).toEqual(imported);
    database.close();
  });

  test("normalizes percent-encoded canonical URLs before hashing and lookup without decoding reserved bytes", async () => {
    const encoded = "https://EXAMPLE.dk:443/%7edish?token=%7e%2f%c3%a9#fragment";
    const decodedUnreserved = "https://example.dk/~dish?token=~%2F%C3%A9";

    expect(normalizeRecipeCanonicalUrl(encoded)).toBe(decodedUnreserved);
    expect(createRecipeId(encoded)).toBe(createRecipeId(decodedUnreserved));
    expect(normalizeRecipeCanonicalUrl("https://example.dk/a%2fb"))
      .not.toBe(normalizeRecipeCanonicalUrl("https://example.dk/a/b"));

    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const first = recipes.import(recipeImport({ canonicalUrl: encoded }));
    const reimported = recipes.import(recipeImport({ canonicalUrl: decodedUnreserved }));
    expect(reimported.id).toBe(first.id);
    expect(recipes.list()).toEqual([reimported]);
    database.close();
  });

  test("rejects malformed percent escapes accepted by the WHATWG URL parser", () => {
    for (const canonicalUrl of [
      "https://example.dk/%",
      "https://example.dk/%2",
      "https://example.dk/%GG",
    ]) {
      expect(() => normalizeRecipeCanonicalUrl(canonicalUrl)).toThrow("malformed percent escape");
    }
  });

  test("reimport by canonical URL keeps the stable id and atomically replaces ordered children", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const first = recipes.import(recipeImport());

    const replacement = recipes.import(recipeImport({
      title: "Tomatpasta med basilikum",
      ingredients: [{
        rawText: " 1 håndfuld basilikum ",
        normalizedName: "basilikum",
        quantity: 1,
        unit: "håndfuld",
        uncertain: false,
      }],
      instructions: ["Hak basilikum.", "Vend den i pastaen."],
      fetchedAt: "2026-09-28T10:15:00.000Z",
    }));

    expect(replacement.id).toBe(first.id);
    expect(replacement.ingredients).toEqual([{
      rawText: " 1 håndfuld basilikum ",
      normalizedName: "basilikum",
      quantity: 1,
      unit: "håndfuld",
      uncertain: false,
    }]);
    expect(replacement.instructions).toEqual(["Hak basilikum.", "Vend den i pastaen."]);
    expect(database.query("SELECT COUNT(*) AS count FROM recipe_ingredients").get()).toEqual({ count: 1 });
    database.close();
  });

  test("get reads the parent and children from one snapshot during a concurrent reimport", async () => {
    const path = await temporaryDatabasePath();
    const reader = openDatabase(path);
    reader.exec("PRAGMA journal_mode = WAL");
    addSource(reader);
    const original = createRecipeRepository(reader).import(recipeImport());
    const writer = openDatabase(path);
    const replacement = recipeImport({
      title: "Replacement",
      ingredients: [{
        rawText: "Replacement ingredient",
        normalizedName: "replacement",
        quantity: 1,
        unit: null,
        uncertain: false,
      }],
      instructions: ["Replacement instruction"],
      fetchedAt: "2026-09-28T10:15:00.000Z",
    });
    const hookedReader = withAfterParentReadHook(reader, () => {
      createRecipeRepository(writer).import(replacement);
    });

    expect(createRecipeRepository(hookedReader).get(original.id)).toEqual(original);
    expect(createRecipeRepository(writer).get(original.id)?.title).toBe("Replacement");
    writer.close();
    reader.close();
  });

  test("list reads all parents and children from one snapshot during a concurrent reimport", async () => {
    const path = await temporaryDatabasePath();
    const reader = openDatabase(path);
    reader.exec("PRAGMA journal_mode = WAL");
    addSource(reader);
    const original = createRecipeRepository(reader).import(recipeImport());
    const writer = openDatabase(path);
    const replacement = recipeImport({
      title: "Replacement",
      ingredients: [{
        rawText: "Replacement ingredient",
        normalizedName: "replacement",
        quantity: 1,
        unit: null,
        uncertain: false,
      }],
      instructions: ["Replacement instruction"],
      fetchedAt: "2026-09-28T10:15:00.000Z",
    });
    const hookedReader = withAfterParentReadHook(reader, () => {
      createRecipeRepository(writer).import(replacement);
    });

    expect(createRecipeRepository(hookedReader).list()).toEqual([original]);
    expect(createRecipeRepository(writer).get(original.id)?.title).toBe("Replacement");
    writer.close();
    reader.close();
  });

  test("falls back to normalized title plus source when the canonical URL changes", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const first = recipes.import(recipeImport({ title: "Crème  brûlée" }));

    const reimported = recipes.import(recipeImport({
      canonicalUrl: "https://example.dk/new/canonical-location",
      sourceUrl: "https://example.dk/new/source-location",
      title: "ＣＲÈＭＥ BRÛLÉE",
    }));

    expect(reimported.id).toBe(first.id);
    expect(reimported.canonicalUrl).toBe("https://example.dk/new/canonical-location");
    expect(reimported.sourceUrl).toBe("https://example.dk/new/source-location");
    expect(recipes.list()).toEqual([reimported]);
    database.close();
  });

  test("rejects ambiguous canonical and source-title matches instead of merging recipes", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const first = recipes.import(recipeImport({ title: "First" }));
    recipes.import(recipeImport({
      title: "Second",
      canonicalUrl: "https://example.dk/recipes/second",
      sourceUrl: "https://example.dk/recipes/second",
    }));

    expect(() => recipes.import(recipeImport({
      title: "Second",
      canonicalUrl: first.canonicalUrl,
    }))).toThrow("canonical URL and source/title match different recipes");
    expect(recipes.list()).toHaveLength(2);
    database.close();
  });

  test("rejects a canonical identity collision after title-based relocation", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const originalCanonicalUrl = recipeImport().canonicalUrl;
    recipes.import(recipeImport({ title: "First" }));
    recipes.import(recipeImport({
      title: "First",
      canonicalUrl: "https://example.dk/recipes/first-moved",
    }));
    recipes.import(recipeImport({
      title: "Second",
      canonicalUrl: "https://example.dk/recipes/second",
      sourceUrl: "https://example.dk/recipes/second",
    }));

    expect(() => recipes.import(recipeImport({
      title: "Second",
      canonicalUrl: originalCanonicalUrl,
    }))).toThrow("canonical identity and source/title match different recipes");
    database.close();
  });

  test("rejects a historical canonical identity when source and title no longer agree", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const originalCanonicalUrl = recipeImport().canonicalUrl;
    const first = recipes.import(recipeImport({ title: "First" }));
    const relocated = recipes.import(recipeImport({
      title: "First",
      canonicalUrl: "https://example.dk/recipes/first-moved",
      sourceUrl: "https://example.dk/recipes/first-moved",
    }));

    expect(() => recipes.import(recipeImport({
      title: "Different",
      canonicalUrl: originalCanonicalUrl,
      sourceUrl: originalCanonicalUrl,
    }))).toThrow("historical canonical identity does not match source/title");
    expect(recipes.get(first.id)).toEqual(relocated);
    expect(recipes.list()).toEqual([relocated]);
    database.close();
  });

  test("allows disabling a referenced source but blocks deletion with a clear provenance error", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());

    expect(setRecipeSourceEnabled(database, "example", false).enabled).toBe(false);
    expect(recipes.get(imported.id)).toEqual(imported);
    expect(() => removeRecipeSource(database, "example")).toThrow(
      "Cannot remove recipe source example while 1 imported recipe references it; disable it instead",
    );
    expect(createConfigurationRepositories(database).recipeSources.get("example")?.enabled).toBe(false);
    database.close();
  });

  test("rolls back parent and child replacement when any new child row fails", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const original = recipes.import(recipeImport());
    database.exec(`
      CREATE TRIGGER reject_exploding_instruction
      BEFORE INSERT ON recipe_instructions
      WHEN NEW.text = 'explode'
      BEGIN
        SELECT RAISE(ABORT, 'instruction rejected');
      END;
    `);

    expect(() => recipes.import(recipeImport({
      title: "Changed title",
      ingredients: [{
        rawText: "New ingredient",
        normalizedName: null,
        quantity: null,
        unit: null,
        uncertain: true,
      }],
      instructions: ["explode"],
    }))).toThrow("instruction rejected");
    expect(recipes.get(original.id)).toEqual(original);
    database.close();
  });

  test("lists and searches recipes in deterministic order with planner-facing filters", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    addSource(database, "other");
    const recipes = createRecipeRepository(database);
    const zulu = recipes.import(recipeImport({ title: "Zulu" }));
    const alpha = recipes.import(recipeImport({
      title: "Alpha Suppe",
      canonicalUrl: "https://example.dk/alpha",
      dietaryTags: ["vegan"],
      suitabilityTags: ["batchCook"],
      cuisineTags: ["Nordic"],
      needsReview: false,
    }));
    recipes.import(recipeImport({
      sourceId: "other",
      title: "Alpha Other",
      canonicalUrl: "https://other.dk/alpha",
      sourceUrl: "https://other.dk/alpha",
    }));

    expect(recipes.list({ sourceId: "example" }).map(({ id }) => id)).toEqual([alpha.id, zulu.id]);
    expect(recipes.search("alpha", {
      sourceId: "example",
      cuisineTag: "nordic",
      dietaryTag: "vegan",
      suitabilityTag: "batchCook",
      needsReview: false,
    })).toEqual([alpha]);
    database.close();
  });

  test("rejects malformed or internally inconsistent persisted recipe parents", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());
    database.exec("PRAGMA ignore_check_constraints = ON");

    database.query("UPDATE recipes SET normalized_title = ? WHERE id = ?").run("wrong", imported.id);
    expect(() => recipes.get(imported.id)).toThrow("normalized title");
    database.query("UPDATE recipes SET normalized_title = ? WHERE id = ?").run(imported.normalizedTitle, imported.id);

    database.query("UPDATE recipes SET cuisine_tags = ? WHERE id = ?").run("not json", imported.id);
    expect(() => recipes.list()).toThrow("malformed JSON");
    database.query("UPDATE recipes SET cuisine_tags = ? WHERE id = ?").run('["italian"]', imported.id);

    database.query("UPDATE recipes SET raw_source_payload = ? WHERE id = ?").run("{", imported.id);
    expect(() => recipes.get(imported.id)).toThrow("malformed JSON");
    database.query("UPDATE recipes SET raw_source_payload = ? WHERE id = ?").run(
      JSON.stringify(imported.rawSourcePayload),
      imported.id,
    );

    database.query("UPDATE recipes SET dietary_tags = ? WHERE id = ?").run('["unsupported"]', imported.id);
    expect(() => recipes.get(imported.id)).toThrow();
    database.query("UPDATE recipes SET dietary_tags = ? WHERE id = ?").run('["vegetarian"]', imported.id);

    database.query("UPDATE recipes SET servings = 1e999 WHERE id = ?").run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow();
    database.query("UPDATE recipes SET servings = NULL WHERE id = ?").run(imported.id);

    database.query("UPDATE recipes SET identity_key = ? WHERE id = ?").run(
      "canonical:https://example.dk/corrupt",
      imported.id,
    );
    expect(() => recipes.get(imported.id)).toThrow("stable identity");
    database.close();
  });

  test("rejects a persisted source id that changes during normalization", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());
    database.exec("PRAGMA foreign_keys = OFF");
    database.query("UPDATE recipes SET source_id = ? WHERE id = ?").run(" example ", imported.id);

    expect(() => recipes.get(imported.id)).toThrow("persisted text is not in normalized form");
    database.close();
  });

  test("rejects persisted tags that are not already in normalized form", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());

    database.query("UPDATE recipes SET cuisine_tags = ? WHERE id = ?").run('["Italian"]', imported.id);
    expect(() => recipes.get(imported.id)).toThrow("normalized form");
    database.close();
  });

  test("rejects malformed persisted ingredients and noncontiguous ingredient ordinals", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());
    database.exec("PRAGMA ignore_check_constraints = ON");

    database.query("UPDATE recipe_ingredients SET ordinal = 3 WHERE recipe_id = ? AND ordinal = 1").run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow("unique and contiguous");
    database.query("UPDATE recipe_ingredients SET ordinal = 1 WHERE recipe_id = ? AND ordinal = 3").run(imported.id);

    database.query("UPDATE recipe_ingredients SET normalized_name = 'PASTA' WHERE recipe_id = ? AND ordinal = 0")
      .run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow("normalized name");
    database.query("UPDATE recipe_ingredients SET normalized_name = 'pasta' WHERE recipe_id = ? AND ordinal = 0")
      .run(imported.id);

    database.query("UPDATE recipe_ingredients SET quantity = 1e999 WHERE recipe_id = ? AND ordinal = 0")
      .run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow();
    database.query("UPDATE recipe_ingredients SET quantity = 400 WHERE recipe_id = ? AND ordinal = 0")
      .run(imported.id);

    database.query("UPDATE recipe_ingredients SET uncertain = 2 WHERE recipe_id = ? AND ordinal = 0")
      .run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow();
    database.close();
  });

  test("rejects malformed persisted instructions and noncontiguous instruction ordinals", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());
    database.exec("PRAGMA ignore_check_constraints = ON");

    database.query("UPDATE recipe_instructions SET ordinal = 4 WHERE recipe_id = ? AND ordinal = 1").run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow("unique and contiguous");
    database.query("UPDATE recipe_instructions SET ordinal = 1 WHERE recipe_id = ? AND ordinal = 4").run(imported.id);

    database.query("UPDATE recipe_instructions SET text = '   ' WHERE recipe_id = ? AND ordinal = 0").run(imported.id);
    expect(() => recipes.get(imported.id)).toThrow();

    expect(() => database.query(`
      INSERT INTO recipe_instructions (recipe_id, ordinal, text) VALUES (?, ?, ?)
    `).run(imported.id, 1, "Duplicate ordinal")).toThrow("UNIQUE constraint failed");
    database.close();
  });

  test("validates normalized Unicode and payload limits before writing", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);

    expect(() => recipes.import(recipeImport({ title: "ﬃ".repeat(200) }))).toThrow();
    expect(() => recipes.import(recipeImport({
      rawSourcePayload: { html: "x".repeat(1_000_001) },
    }))).toThrow("Raw recipe source payload exceeds 1000000 bytes");
    expect(database.query("SELECT COUNT(*) AS count FROM recipes").get()).toEqual({ count: 0 });
    database.close();
  });

  test("removes a recipe and its ordered children without removing its source", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    addSource(database);
    const recipes = createRecipeRepository(database);
    const imported = recipes.import(recipeImport());

    expect(recipes.remove(imported.id)).toBe(true);
    expect(recipes.remove(imported.id)).toBe(false);
    expect(recipes.get(imported.id)).toBeNull();
    expect(database.query("SELECT COUNT(*) AS count FROM recipe_ingredients").get()).toEqual({ count: 0 });
    expect(database.query("SELECT COUNT(*) AS count FROM recipe_instructions").get()).toEqual({ count: 0 });
    expect(createConfigurationRepositories(database).recipeSources.get("example")).not.toBeNull();
    database.close();
  });
});
