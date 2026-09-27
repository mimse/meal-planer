import { afterEach, describe, expect, test } from "bun:test";
import { exists } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamilyEditWorkflow } from "../../src/commands/family-workflow";
import { readFamilyConfiguration } from "../../src/commands/family";
import { applySetup, createSetupConfiguration } from "../../src/commands/setup";
import { runSetupWorkflow } from "../../src/commands/setup-workflow";
import { openDatabase } from "../../src/infrastructure/database";
import { CANCELLED, type PromptAdapter } from "../../src/presentation/prompts";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

describe("interactive command workflows", () => {
  test("setup cancellation is a no-op and does not create the database directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-prompt-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "nested", "mealplan.sqlite");
    const prompts: PromptAdapter = {
      collectSetup: async () => CANCELLED,
      collectFamilyEdit: async () => CANCELLED,
    };

    expect(await runSetupWorkflow({ databasePath, prompts })).toBe("cancelled");
    expect(await exists(join(root, "nested"))).toBe(false);
  });

  test("setup saves validated answers supplied by an injected prompt adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-prompt-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "mealplan.sqlite");
    const prompts: PromptAdapter = {
      collectSetup: async () => ({
        members: [{ id: "pat", name: "Pat", kind: "adult", servings: 1.5 }],
        rules: [{ memberId: null, kind: "dietary_restriction", value: "No peanuts" }],
      }),
      collectFamilyEdit: async () => CANCELLED,
    };

    expect(await runSetupWorkflow({ databasePath, prompts })).toBe("saved");
    const database = openDatabase(databasePath);
    expect(readFamilyConfiguration(database).members).toEqual([
      { id: "pat", name: "Pat", kind: "adult", servings: 1.5 },
    ]);
    database.close();
  });

  test("family edit cancellation does not create a new database", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-prompt-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "nested", "mealplan.sqlite");
    const prompts: PromptAdapter = {
      collectSetup: async () => CANCELLED,
      collectFamilyEdit: async () => CANCELLED,
    };

    await expect(runFamilyEditWorkflow({ databasePath, prompts })).rejects.toThrow("Run mealplan setup first");
    expect(await exists(join(root, "nested"))).toBe(false);
  });

  test("family edit rejects an existing database without completed setup", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-prompt-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "mealplan.sqlite");
    openDatabase(databasePath).close();
    const prompts: PromptAdapter = {
      collectSetup: async () => CANCELLED,
      collectFamilyEdit: async () => CANCELLED,
    };

    await expect(runFamilyEditWorkflow({
      databasePath,
      prompts,
      edit: {
        upsertMembers: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
        removeMemberIds: [],
        upsertRules: [],
        removeRuleIds: [],
      },
    })).rejects.toThrow("Run mealplan setup first");
    const database = openDatabase(databasePath);
    expect(database.query("SELECT COUNT(*) AS count FROM household_members").get()).toEqual({ count: 0 });
    database.close();
  });

  test("family edit cancellation preserves existing family configuration", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-prompt-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "mealplan.sqlite");
    const database = openDatabase(databasePath);
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
    }));
    const before = readFamilyConfiguration(database);
    database.close();
    const prompts: PromptAdapter = {
      collectSetup: async () => CANCELLED,
      collectFamilyEdit: async () => CANCELLED,
    };

    expect(await runFamilyEditWorkflow({ databasePath, prompts })).toBe("cancelled");
    const reopened = openDatabase(databasePath);
    expect(readFamilyConfiguration(reopened)).toEqual(before);
    reopened.close();
  });

  test("family edit applies changes supplied by an injected prompt adapter", async () => {
    const root = await mkdtemp(join(tmpdir(), "meal-planer-prompt-"));
    temporaryDirectories.push(root);
    const databasePath = join(root, "mealplan.sqlite");
    const database = openDatabase(databasePath);
    applySetup(database, createSetupConfiguration({
      members: [{ id: "alex", name: "Alex", kind: "adult", servings: 1 }],
    }));
    database.close();
    const prompts: PromptAdapter = {
      collectSetup: async () => CANCELLED,
      collectFamilyEdit: async () => ({
        upsertMembers: [{ id: "alex", name: "Alexandra", kind: "adult", servings: 1.25 }],
        removeMemberIds: [],
        upsertRules: [{ memberId: "alex", kind: "disliked_ingredient", value: "Fennel, raw" }],
        removeRuleIds: [],
      }),
    };

    expect(await runFamilyEditWorkflow({ databasePath, prompts })).toBe("saved");
    const reopened = openDatabase(databasePath);
    const family = readFamilyConfiguration(reopened);
    expect(family.members[0]?.name).toBe("Alexandra");
    expect(family.rules[0]).toMatchObject({ memberId: "alex", value: "Fennel, raw" });
    reopened.close();
  });
});
