import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { createConfigurationRepositories } from "../../src/infrastructure/configuration-repositories";
import { openDatabase } from "../../src/infrastructure/database";

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meal-planer-setup-"));
  temporaryDirectories.push(directory);
  return join(directory, "mealplan.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("setup workflow", () => {
  test("persists members, scoped rules, weekly defaults, stores without dealer ids, and built-in sources", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    const configuration = createSetupConfiguration({
      members: [
        { id: "alex", name: "Alex", kind: "adult", servings: 1 },
        { id: "sam", name: "Sam", kind: "child", servings: 0.75 },
      ],
      rules: [
        { memberId: null, kind: "dietary_restriction", value: "Tree nuts, including hazelnuts" },
        { memberId: "sam", kind: "disliked_ingredient", value: "Olives; capers" },
      ],
    });

    applySetup(database, configuration);
    const repositories = createConfigurationRepositories(database);

    expect(repositories.householdMembers.list()).toEqual(configuration.members);
    expect(repositories.householdRules.list().map(({ id: _, ...rule }) => rule)).toEqual(configuration.rules);
    expect(repositories.dayProfiles.list()).toEqual(configuration.dayProfiles);
    expect(repositories.preferredStores.list()).toEqual(configuration.preferredStores);
    expect(repositories.preferredStores.list().every((store) => store.dealerId === null)).toBe(true);
    expect(repositories.recipeSources.list()).toEqual(configuration.recipeSources);
    database.close();
  });

  test("rerun replaces setup-managed configuration while retaining pantry items", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [{ memberId: null, kind: "dietary_restriction", value: "Gluten" }],
    }));
    const repositories = createConfigurationRepositories(database);
    const pantryItem = repositories.pantryItems.upsert({ name: "Rice", quantity: "500 g" });
    repositories.householdMembers.upsert({ id: "legacy", name: "Legacy", kind: "adult", servings: 1 });
    repositories.dayProfiles.upsert({
      day: "mon",
      maxTotalMinutes: 5,
      requiredServingModes: ["immediate"],
      easyOnly: true,
      minimumExtraMeals: 2,
      prepLinkSatisfiesMinimum: true,
      notes: "Must be replaced",
    });
    repositories.preferredStores.upsert({
      id: "legacy-store",
      name: "Legacy Store",
      dealerId: "legacy-dealer",
      countryCode: "DK",
      priority: 99,
      dealsEnabled: true,
    });
    repositories.recipeSources.upsert({
      id: "legacy-source",
      name: "Legacy Source",
      baseUrl: "https://legacy.example/recipes",
      adapter: "jsonld",
      enabled: true,
    });
    const replacement = createSetupConfiguration({
      members: [{ id: "sam", name: "Sam", kind: "child", servings: 0.75 }],
      rules: [{ memberId: "sam", kind: "disliked_ingredient", value: "Olives" }],
      preferredStoreNames: ["Netto"],
    });

    applySetup(database, replacement);

    expect(repositories.householdMembers.list()).toEqual(replacement.members);
    expect(repositories.householdRules.list().map(({ id: _, ...rule }) => rule)).toEqual(replacement.rules);
    expect(repositories.dayProfiles.list()).toEqual(replacement.dayProfiles);
    expect(repositories.preferredStores.list()).toEqual(replacement.preferredStores);
    expect(repositories.recipeSources.list()).toEqual(replacement.recipeSources);
    expect(repositories.pantryItems.list()).toEqual([pantryItem]);
    database.close();
  });

  test("setup atomically upserts supplied pantry items without deleting other pantry entries", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      pantryItems: [
        { name: "Rice", quantity: "500 g" },
        { name: "Beans", quantity: "2 cans" },
      ],
    }));

    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      pantryItems: [{ name: " ＲＩＣＥ ", quantity: "1 kg" }],
    }));

    expect(createConfigurationRepositories(database).pantryItems.list()).toEqual([
      { normalizedName: "beans", name: "Beans", quantity: "2 cans" },
      { normalizedName: "rice", name: "ＲＩＣＥ", quantity: "1 kg" },
    ]);
    database.close();
  });
});
