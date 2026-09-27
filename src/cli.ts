#!/usr/bin/env bun

import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import packageJson from "../package.json";
import { TilbudstroldenClient } from "./adapters/deals/tilbudstrolden-client";
import { readFamilyConfiguration, type FamilyEdit } from "./commands/family";
import { runFamilyEditWorkflow } from "./commands/family-workflow";
import { inspectRecipeUrl } from "./commands/inspect-recipe";
import { runSetupWorkflow } from "./commands/setup-workflow";
import type { SetupAnswers } from "./commands/setup";
import { openExistingDatabase } from "./infrastructure/database";
import { resolveDatabasePath } from "./infrastructure/database-path";
import { ClackPromptAdapter } from "./presentation/prompts";

const program = new Command()
  .name("mealplan")
  .description("Family-aware weekly meal planning for Denmark")
  .version(packageJson.version)
  .option("--database <path>", "SQLite database path (or set MEALPLAN_DATABASE)");

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} must be valid JSON`);
  }
}

function databasePath(): string {
  const explicitPath = program.opts<{ database?: string }>().database;
  return resolveDatabasePath(explicitPath === undefined ? {} : { explicitPath });
}

const prompts = new ClackPromptAdapter();

const setup = program
  .command("setup")
  .description("Configure household members, rules, weekly defaults, stores, and sources")
  .option("--member <json>", "member object; repeat for each member", collect, [])
  .option("--household-dietary-restriction <text>", "household dietary restriction; repeatable", collect, [])
  .option("--household-disliked-ingredient <text>", "household disliked ingredient; repeatable", collect, [])
  .option("--member-rule <json>", "member-scoped rule object; repeatable", collect, [])
  .option("--store <name>", "preferred store name; repeatable", collect, []);

setup.action(async (options: {
  member: string[];
  householdDietaryRestriction: string[];
  householdDislikedIngredient: string[];
  memberRule: string[];
  store: string[];
}) => {
  const hasFlags = options.member.length > 0
    || options.householdDietaryRestriction.length > 0
    || options.householdDislikedIngredient.length > 0
    || options.memberRule.length > 0
    || options.store.length > 0;
  if (hasFlags && options.member.length === 0) {
    throw new Error("Flag-based setup requires at least one --member");
  }
  const answers: SetupAnswers | undefined = hasFlags ? {
    members: options.member.map((value) => parseJson(value, "--member") as SetupAnswers["members"][number]),
    rules: [
      ...options.householdDietaryRestriction.map((value) => ({ memberId: null, kind: "dietary_restriction" as const, value })),
      ...options.householdDislikedIngredient.map((value) => ({ memberId: null, kind: "disliked_ingredient" as const, value })),
      ...options.memberRule.map((value) => parseJson(value, "--member-rule") as NonNullable<SetupAnswers["rules"]>[number]),
    ],
    ...(options.store.length === 0 ? {} : { preferredStoreNames: options.store }),
  } : undefined;
  const result = await runSetupWorkflow({
    databasePath: databasePath(),
    prompts,
    ...(answers === undefined ? {} : { answers }),
  });
  if (result === "saved") console.log("Setup saved.");
});

const family = program.command("family").description("Show or edit family configuration");

family.command("show")
  .description("Show family configuration")
  .option("--json", "emit stable JSON")
  .action(async (options: { json?: boolean }) => {
    const database = openExistingDatabase(databasePath());
    try {
      const configuration = readFamilyConfiguration(database);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(configuration, null, 2)}\n`);
      } else {
        console.log(`Members (${configuration.members.length})`);
        for (const member of configuration.members) {
          console.log(`- ${member.name} [${member.id}] · ${member.kind} · ${member.servings} serving(s)`);
        }
        console.log(`Rules (${configuration.rules.length})`);
        for (const rule of configuration.rules) {
          console.log(`- ${rule.memberId ?? "household"} · ${rule.kind}: ${rule.value}`);
        }
        console.log(`Preferred stores: ${configuration.preferredStores.map(({ name }) => name).join(", ")}`);
      }
    } finally {
      database.close();
    }
  });

family.command("edit")
  .description("Add, update, or remove members and rules")
  .option("--upsert-member <json>", "member object; repeatable", collect, [])
  .option("--remove-member <id>", "member id; repeatable", collect, [])
  .option("--upsert-rule <json>", "new rule object with memberId, kind, and value; repeatable", collect, [])
  .option("--update-rule <json>", "existing rule object with id, memberId, kind, and value; repeatable", collect, [])
  .option("--remove-rule <id>", "rule id from family show --json; repeatable", collect, [])
  .action(async (options: {
    upsertMember: string[];
    removeMember: string[];
    upsertRule: string[];
    updateRule: string[];
    removeRule: string[];
  }) => {
    const hasFlags = options.upsertMember.length > 0 || options.removeMember.length > 0
      || options.upsertRule.length > 0 || options.updateRule.length > 0 || options.removeRule.length > 0;
    const edit: FamilyEdit | undefined = hasFlags ? {
      upsertMembers: options.upsertMember.map((value) => parseJson(value, "--upsert-member") as FamilyEdit["upsertMembers"][number]),
      removeMemberIds: options.removeMember,
      upsertRules: options.upsertRule.map((value) => parseJson(value, "--upsert-rule") as FamilyEdit["upsertRules"][number]),
      replaceRules: options.updateRule.map((value) => parseJson(value, "--update-rule") as NonNullable<FamilyEdit["replaceRules"]>[number]),
      removeRuleIds: options.removeRule,
    } : undefined;
    const result = await runFamilyEditWorkflow({
      databasePath: databasePath(),
      prompts,
      ...(edit === undefined ? {} : { edit }),
    });
    if (result === "saved") console.log("Family configuration saved.");
  });

const recipes = program
  .command("recipes")
  .description("Import, inspect, and manage recipes");

recipes
  .command("inspect")
  .description("Fetch a recipe URL and inspect its Schema.org Recipe data")
  .argument("<url>", "recipe page URL")
  .option("--json", "emit stable JSON")
  .action(async (urlValue: string, options: { json?: boolean }) => {
    const url = new URL(urlValue);
    const recipe = await inspectRecipeUrl(url, {
      requestInit: {
        headers: { "user-agent": `meal-planer/${packageJson.version}` },
        signal: AbortSignal.timeout(15_000),
      },
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(recipe, null, 2)}\n`);
      return;
    }

    console.log(`${recipe.title}\n${recipe.canonicalUrl}`);
  });

const integrations = program
  .command("integrations")
  .description("Inspect external recipe and deal integrations");

integrations
  .command("verify-deals")
  .description("Verify compatibility with the pinned TilbudsTrolden MCP server")
  .option("--server <path>", "server entry point", "vendor/tilbudstrolden-mcp/dist/server.js")
  .option("--data <path>", "isolated TilbudsTrolden data file", ".data/tilbudstrolden.json")
  .option("--json", "emit stable JSON")
  .action(async (options: { server: string; data: string; json?: boolean }) => {
    const serverPath = resolve(options.server);
    const dataPath = resolve(options.data);
    await mkdir(dirname(dataPath), { recursive: true });

    await using client = new TilbudstroldenClient({
      command: "node",
      args: [serverPath],
      cwd: process.cwd(),
      dataPath,
    });
    const result = await client.checkCompatibility();

    if (options.json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      const server = result.server
        ? `${result.server.name} ${result.server.version}`
        : "unknown server";
      console.log(`${server}: ${result.toolCount} tools`);
      console.log(
        result.missingRequiredTools.length === 0
          ? "All required tools are available."
          : `Missing required tools: ${result.missingRequiredTools.join(", ")}`,
      );
      if (result.incompatibleToolSchemas.length > 0) {
        console.log(`Incompatible tool input schemas: ${result.incompatibleToolSchemas
          .map(({ name, issues }) => `${name} (${issues.join("; ")})`)
          .join(", ")}`);
      }
      if (result.missingRequiredToolOutputSchemas.length > 0) {
        console.log(
          `Missing required tool output schemas: ${result.missingRequiredToolOutputSchemas.join(", ")}`,
        );
      }
      if (result.incompatibleToolOutputSchemas.length > 0) {
        console.log(`Incompatible tool output schemas: ${result.incompatibleToolOutputSchemas
          .map(({ name, issues }) => `${name} (${issues.join("; ")})`)
          .join(", ")}`);
      } else if (result.missingRequiredToolOutputSchemas.length === 0) {
        console.log("All required tool output schemas are compatible.");
      }
    }

    if (!result.compatible) process.exitCode = 1;
  });

await program.parseAsync();
