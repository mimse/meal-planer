import { afterEach, describe, expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyFamilyEdit, readFamilyConfiguration } from "../../src/commands/family";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { openDatabase } from "../../src/infrastructure/database";

const temporaryDirectories: string[] = [];

async function temporaryDatabasePath(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "meal-planer-family-"));
  temporaryDirectories.push(directory);
  return join(directory, "mealplan.sqlite");
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("family workflow", () => {
  test("adds and updates members and preserves rule scope and raw punctuation", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
    }));

    applyFamilyEdit(database, {
      upsertMembers: [
        { id: "alex", name: "Alexandra", kind: "adult", servings: 1.25 },
        { id: "sam", name: "Sam, Jr.", kind: "child", servings: 0.75 },
      ],
      removeMemberIds: [],
      upsertRules: [
        { memberId: null, kind: "dietary_restriction", value: "No peanuts, tree nuts; sesame" },
        { memberId: "sam", kind: "disliked_ingredient", value: "Olives, capers; anchovies" },
      ],
      removeRuleIds: [],
    });

    const family = readFamilyConfiguration(database);
    expect(family.members).toEqual([
      { id: "alex", name: "Alexandra", kind: "adult", servings: 1.25 },
      { id: "sam", name: "Sam, Jr.", kind: "child", servings: 0.75 },
    ]);
    expect(family.rules.map(({ id: _, ...rule }) => rule)).toEqual([
      { memberId: null, kind: "dietary_restriction", value: "No peanuts, tree nuts; sesame" },
      { memberId: "sam", kind: "disliked_ingredient", value: "Olives, capers; anchovies" },
    ]);
    database.close();
  });

  test("rejects removing the final member without changing prior state", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [{ memberId: null, kind: "dietary_restriction", value: "Gluten" }],
    }));
    const before = readFamilyConfiguration(database);

    expect(() => applyFamilyEdit(database, {
      upsertMembers: [],
      removeMemberIds: ["alex"],
      upsertRules: [],
      removeRuleIds: [],
    })).toThrow("Family must contain at least one member");
    expect(readFamilyConfiguration(database)).toEqual(before);
    database.close();
  });

  test("rejects duplicate replacement source ids without changing prior state", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [{ memberId: null, kind: "dietary_restriction", value: "Gluten" }],
    }));
    const before = readFamilyConfiguration(database);
    const sourceId = before.rules[0]!.id;

    expect(() => applyFamilyEdit(database, {
      upsertMembers: [],
      removeMemberIds: [],
      upsertRules: [],
      replaceRules: [
        { id: sourceId, memberId: null, kind: "dietary_restriction", value: "Wheat" },
        { id: sourceId, memberId: null, kind: "dietary_restriction", value: "Barley" },
      ],
      removeRuleIds: [],
    })).toThrow(`Duplicate rule replacement: ${sourceId}`);
    expect(readFamilyConfiguration(database)).toEqual(before);
    database.close();
  });

  test("rejects replacing and removing the same rule without changing prior state", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [{ memberId: null, kind: "dietary_restriction", value: "Gluten" }],
    }));
    const before = readFamilyConfiguration(database);
    const sourceId = before.rules[0]!.id;

    expect(() => applyFamilyEdit(database, {
      upsertMembers: [],
      removeMemberIds: [],
      upsertRules: [],
      replaceRules: [
        { id: sourceId, memberId: null, kind: "dietary_restriction", value: "Wheat" },
      ],
      removeRuleIds: [sourceId],
    })).toThrow(`Rule cannot be replaced and removed in the same edit: ${sourceId}`);
    expect(readFamilyConfiguration(database)).toEqual(before);
    database.close();
  });

  test("rejects a replacement identity that collides with a surviving rule", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [
        { memberId: null, kind: "dietary_restriction", value: "Gluten" },
        { memberId: null, kind: "dietary_restriction", value: "Peanuts" },
      ],
    }));
    const before = readFamilyConfiguration(database);
    const sourceId = before.rules.find(({ value }) => value === "Gluten")!.id;

    expect(() => applyFamilyEdit(database, {
      upsertMembers: [],
      removeMemberIds: [],
      upsertRules: [],
      replaceRules: [
        { id: sourceId, memberId: null, kind: "dietary_restriction", value: "PEANUTS" },
      ],
      removeRuleIds: [],
    })).toThrow("Replacement rule identity conflicts with an existing rule");
    expect(readFamilyConfiguration(database)).toEqual(before);
    database.close();
  });

  test("rejects replacement rules with the same final identity without changing prior state", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [
        { memberId: null, kind: "dietary_restriction", value: "Gluten" },
        { memberId: null, kind: "dietary_restriction", value: "Peanuts" },
      ],
    }));
    const before = readFamilyConfiguration(database);

    expect(() => applyFamilyEdit(database, {
      upsertMembers: [],
      removeMemberIds: [],
      upsertRules: [],
      replaceRules: before.rules.map(({ id }) => ({
        id,
        memberId: null,
        kind: "dietary_restriction" as const,
        value: "Sesame",
      })),
      removeRuleIds: [],
    })).toThrow("Replacement rules have the same final identity");
    expect(readFamilyConfiguration(database)).toEqual(before);
    database.close();
  });

  test("rejects rule upserts that conflict with a replacement source or final identity", async () => {
    const database = openDatabase(await temporaryDatabasePath());
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
      rules: [{ memberId: null, kind: "dietary_restriction", value: "Gluten" }],
    }));
    const before = readFamilyConfiguration(database);
    const sourceId = before.rules[0]!.id;
    const replacement = {
      id: sourceId,
      memberId: null,
      kind: "dietary_restriction" as const,
      value: "Wheat",
    };

    for (const value of ["GLUTEN", "wheat"]) {
      expect(() => applyFamilyEdit(database, {
        upsertMembers: [],
        removeMemberIds: [],
        upsertRules: [{ memberId: null, kind: "dietary_restriction", value }],
        replaceRules: [replacement],
        removeRuleIds: [],
      })).toThrow("Rule upsert conflicts with a replacement operation");
      expect(readFamilyConfiguration(database)).toEqual(before);
    }
    database.close();
  });

  test("serializes final-member validation with concurrent edits", async () => {
    const path = await temporaryDatabasePath();
    const database = openDatabase(path);
    applySetup(database, createSetupConfiguration({
      members: [
        { id: "alex", name: "Alex", kind: "adult", servings: 1 },
        { id: "sam", name: "Sam", kind: "adult", servings: 1 },
      ],
    }));
    const root = join(path, "..");
    const goPath = join(root, "go");
    const readyPaths = [join(root, "ready-alex"), join(root, "ready-sam")];
    const familyModuleUrl = new URL("../../src/commands/family.ts", import.meta.url).href;
    const databaseModuleUrl = new URL("../../src/infrastructure/database.ts", import.meta.url).href;
    const runner = (memberId: string, readyPath: string) => `
      import { existsSync } from "node:fs";
      import { applyFamilyEdit } from ${JSON.stringify(familyModuleUrl)};
      import { openDatabase } from ${JSON.stringify(databaseModuleUrl)};
      const database = openDatabase(${JSON.stringify(path)});
      await Bun.write(${JSON.stringify(readyPath)}, "ready");
      while (!existsSync(${JSON.stringify(goPath)})) await Bun.sleep(10);
      try {
        applyFamilyEdit(database, {
          upsertMembers: [], removeMemberIds: [${JSON.stringify(memberId)}],
          upsertRules: [], removeRuleIds: [],
        });
      } finally { database.close(); }
    `;
    const first = Bun.spawn([process.execPath, "--eval", runner("alex", readyPaths[0]!)], { stderr: "pipe" });
    const second = Bun.spawn([process.execPath, "--eval", runner("sam", readyPaths[1]!)], { stderr: "pipe" });
    while (!await exists(readyPaths[0]!) || !await exists(readyPaths[1]!)) await Bun.sleep(10);

    database.exec("BEGIN IMMEDIATE");
    await Bun.write(goPath, "go");
    await Bun.sleep(250);
    database.exec("COMMIT");
    database.close();

    const [firstExit, secondExit] = await Promise.all([first.exited, second.exited]);
    expect([firstExit, secondExit].sort()).toEqual([0, 1]);
    const reopened = openDatabase(path);
    expect(readFamilyConfiguration(reopened).members).toHaveLength(1);
    reopened.close();
  });
});
