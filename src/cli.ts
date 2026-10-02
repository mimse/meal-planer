#!/usr/bin/env bun

import { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import packageJson from "../package.json";
import { TilbudstroldenClient } from "./adapters/deals/tilbudstrolden-client";
import { resolvePlanningServerDirectory } from "./adapters/deals/planning-client";
import { readFamilyConfiguration, type FamilyEdit } from "./commands/family";
import { runFamilyEditWorkflow } from "./commands/family-workflow";
import { inspectRecipeUrl } from "./commands/inspect-recipe";
import { runPantryAddWorkflow, runPantryRemoveWorkflow } from "./commands/pantry-workflow";
import { readPantry } from "./commands/pantry";
import { runSetupWorkflow } from "./commands/setup-workflow";
import type { SetupAnswers } from "./commands/setup";
import { runSourceTest } from "./application/test-source";
import { runSourceSync } from "./application/source-sync";
import {
  createPlanWithDeals,
  localDateInDenmark,
  resolvePlanWeekStart,
} from "./application/create-plan";
import { importRecipeUrl, parseRecipeLimit, parseRecipeRequestUrl } from "./application/recipe-ingestion";
import { parseRecipeReviewPatch, reviewRecipe, type RecipeReviewPatch } from "./application/recipe-review";
import { DIETARY_TAGS } from "./domain/recipe";
import {
  addRecipeSource,
  createRecipeSource,
  readRecipeSources,
  removeRecipeSource,
  setRecipeSourceEnabled,
  validateRecipeSourceId,
} from "./commands/sources";
import { openExistingDatabase } from "./infrastructure/database";
import {
  createRecipeRepository,
  parseRecipeId,
  parseRecipeListOptions,
  RECIPE_PREFERENCES,
  SUITABILITY_TAGS,
  type Recipe,
} from "./infrastructure/recipe-repository";
import { createConfigurationRepositories } from "./infrastructure/configuration-repositories";
import { resolveDatabasePath } from "./infrastructure/database-path";
import { createBackupBundle, restoreBackupBundle } from "./infrastructure/backup";
import { createPlanRepository, type WeeklyPlan } from "./infrastructure/plan-repository";
import { createPrepLinkRepository, parsePrepLinkInput } from "./infrastructure/prep-link-repository";
import { ClackPromptAdapter } from "./presentation/prompts";
import { registerPlanEditCommands } from "./presentation/plan-edit-commands";
import { registerShoppingListCommand } from "./presentation/shopping-list-command";

const program = new Command()
  .name("mealplan")
  .description("Family-aware weekly meal planning for Denmark")
  .version(packageJson.version)
  .option("--database <path>", "SQLite database path (or set MEALPLAN_DATABASE)");

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function collectAtMostTwo(value: string, previous: string[]): string[] {
  return previous.length >= 2 ? previous : [...previous, value];
}

function singletonOption(values: readonly string[], label: string): string | undefined {
  if (values.length > 1) throw new Error(`${label} may be specified only once`);
  return values[0];
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

function oneOf<const Values extends readonly string[]>(value: string, values: Values, label: string): Values[number] {
  if (!(values as readonly string[]).includes(value)) throw new Error(`Unsupported ${label}: ${value}`);
  return value as Values[number];
}

function positiveNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) throw new Error(`${label} must be a positive number`);
  return parsed;
}

function nonnegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative integer`);
  return parsed;
}

function nonnegativeNumber(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) throw new Error(`${label} must be a non-negative number`);
  return parsed;
}

function rejectSetClearConflict(set: boolean, clear: boolean | undefined, label: string): void {
  if (set && clear === true) throw new Error(`Cannot set and clear ${label} in the same review`);
}

function printRecipe(recipe: Recipe): void {
  console.log(`${recipe.title} [${recipe.id}]`);
  console.log(`Source: ${recipe.sourceId} · ${recipe.sourceUrl}`);
  console.log(`Canonical: ${recipe.canonicalUrl}`);
  console.log(`Fetched: ${recipe.fetchedAt} · parser ${recipe.parserVersion}`);
  console.log(`Servings: ${recipe.servings ?? "unknown"} · time: ${recipe.totalMinutes ?? "unknown"} min · review: ${recipe.needsReview ? "needed" : "complete"}`);
  console.log(`Ingredients (${recipe.ingredients.length})`);
  for (const [index, ingredient] of recipe.ingredients.entries()) console.log(`${index + 1}. ${ingredient.rawText}`);
  console.log(`Instructions (${recipe.instructions.length})`);
  for (const [index, instruction] of recipe.instructions.entries()) console.log(`${index + 1}. ${instruction}`);
}

function printPlan(plan: WeeklyPlan, recipesById: ReadonlyMap<string, Recipe>): void {
  console.log(`${plan.weekStart} · ${plan.status} · shopping ${plan.shoppingDate}`);
  for (const meal of plan.meals) {
    const recipe = recipesById.get(meal.recipeId);
    console.log(`${meal.day} ${meal.date}: ${recipe?.title ?? meal.recipeId}${recipe === undefined ? "" : ` · ${recipe.sourceUrl}`}`);
    for (const reason of meal.rationale) console.log(`  - ${reason}`);
  }
  for (const explanation of plan.score.explanations) console.log(`Reuse: ${explanation}`);
  for (const warning of plan.score.warnings) console.log(`Warning: ${warning}`);
}

const prompts = new ClackPromptAdapter();

const setup = program
  .command("setup")
  .description("Configure household members, rules, pantry, weekly defaults, stores, and sources")
  .option("--member <json>", "member object; repeat for each member", collect, [])
  .option("--household-dietary-restriction <text>", "household dietary restriction; repeatable", collect, [])
  .option("--household-disliked-ingredient <text>", "household disliked ingredient; repeatable", collect, [])
  .option("--member-rule <json>", "member-scoped rule object; repeatable", collect, [])
  .option("--pantry-item <json>", "initial pantry item object; repeatable", collect, [])
  .option("--store <name>", "preferred store name; repeatable", collect, []);

setup.action(async (options: {
  member: string[];
  householdDietaryRestriction: string[];
  householdDislikedIngredient: string[];
  memberRule: string[];
  pantryItem: string[];
  store: string[];
}) => {
  const hasFlags = options.member.length > 0
    || options.householdDietaryRestriction.length > 0
    || options.householdDislikedIngredient.length > 0
    || options.memberRule.length > 0
    || options.pantryItem.length > 0
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
    pantryItems: options.pantryItem.map((value) => parseJson(value, "--pantry-item") as NonNullable<SetupAnswers["pantryItems"]>[number]),
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

const pantry = program.command("pantry").description("Show or edit pantry items");

pantry.command("show")
  .description("Show pantry items")
  .option("--json", "emit stable JSON")
  .action((options: { json?: boolean }) => {
    const database = openExistingDatabase(databasePath());
    try {
      const items = readPantry(database);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(items, null, 2)}\n`);
      } else {
        console.log(`Pantry (${items.length})`);
        for (const item of items) console.log(`- ${item.name}: ${item.quantity}`);
      }
    } finally {
      database.close();
    }
  });

pantry.command("add")
  .description("Add or replace pantry items")
  .option("--item <json>", "pantry item object; repeatable", collect, [])
  .action(async (options: { item: string[] }) => {
    const items = options.item.length === 0
      ? undefined
      : options.item.map((value) => parseJson(value, "--item"));
    const result = await runPantryAddWorkflow({
      databasePath: databasePath(),
      prompts,
      ...(items === undefined ? {} : { items }),
    });
    if (result === "saved") console.log("Pantry items saved.");
  });

pantry.command("remove")
  .description("Remove pantry items")
  .argument("[names...]", "pantry item names")
  .action(async (names: string[]) => {
    const result = await runPantryRemoveWorkflow({
      databasePath: databasePath(),
      prompts,
      ...(names.length === 0 ? {} : { names }),
    });
    if (result === "saved") console.log("Pantry items removed.");
  });

const sources = program.command("sources").description("Configure recipe sources");

sources.command("list")
  .description("List configured recipe sources")
  .option("--json", "emit stable JSON")
  .action((options: { json?: boolean }) => {
    const database = openExistingDatabase(databasePath());
    try {
      const configuredSources = readRecipeSources(database);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(configuredSources, null, 2)}\n`);
      } else {
        console.log(`Recipe sources (${configuredSources.length})`);
        for (const source of configuredSources) {
          console.log(`- ${source.name} [${source.id}] · ${source.adapter} · ${source.enabled ? "enabled" : "disabled"} · ${source.baseUrl}`);
        }
      }
    } finally {
      database.close();
    }
  });

sources.command("add")
  .description("Add recipe-source configuration")
  .argument("<base-url>", "HTTP(S) source base URL")
  .option("--id <id>", "stable source id")
  .option("--name <name>", "display name")
  .option("--adapter <adapter>", "auto, jsonld, microdata, or spisbedre-inertia", "auto")
  .action((baseUrl: string, options: { id?: string; name?: string; adapter: string }) => {
    const source = createRecipeSource({ baseUrl, ...options });
    const database = openExistingDatabase(databasePath());
    try {
      addRecipeSource(database, source);
      console.log(`Recipe source added: ${source.id}. Run sources test ${source.id} to probe discovery.`);
    } finally {
      database.close();
    }
  });

sources.command("test")
  .description("Probe bounded sitemap discovery only; use sources sync to extract and persist recipes")
  .argument("<source-id>", "stable source id")
  .option("--json", "emit stable JSON")
  .action(async (sourceId: string, options: { json?: boolean }) => {
    const id = validateRecipeSourceId(sourceId);
    const database = openExistingDatabase(databasePath());
    try {
      const report = await runSourceTest(database, id);
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        console.log(`Source ${report.sourceId}: discovered ${report.count} recipe URL${report.count === 1 ? "" : "s"}${report.capped ? " (capped)" : ""}.`);
        console.log(`Discovery routes: ${report.discoveryRoutes.join(" -> ")}`);
        for (const recipeUrl of report.sampleRecipeUrls) console.log(`- ${recipeUrl}`);
        console.log(`Cache: ${report.cache.misses} miss, ${report.cache.refreshed} refreshed, ${report.cache.revalidated} revalidated.`);
        for (const warning of report.warnings) console.log(`Warning: ${warning}`);
        console.log("Discovery only; run sources sync to extract and persist recipes.");
      }
    } finally {
      database.close();
    }
  });

sources.command("sync")
  .description("Discover, extract, and persist recipes from one enabled source or all enabled sources")
  .argument("[source-id]", "stable source id; omitted syncs all enabled sources")
  .option("--limit <n>", "maximum recipe pages per source (1-100)", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action(async (sourceId: string | undefined, options: { limit: string[]; json?: boolean }) => {
    const limit = parseRecipeLimit(singletonOption(options.limit, "--limit"));
    const parsedSourceId = sourceId === undefined ? undefined : validateRecipeSourceId(sourceId);
    const database = openExistingDatabase(databasePath());
    try {
      const report = await runSourceSync(database, {
        ...(parsedSourceId === undefined ? {} : { sourceId: parsedSourceId }),
        limit,
      });
      if (options.json) {
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
      } else {
        for (const source of report.sources) {
          console.log(`${source.sourceId}: ${source.imported}/${source.attempted} imported${source.capped ? " (discovery capped)" : ""}${source.failed > 0 ? `, ${source.failed} failed` : ""}.`);
          for (const warning of source.warnings) console.log(`Warning: ${warning}`);
          for (const failure of source.failures) console.log(`Failure${failure.url === null ? "" : ` ${failure.url}`}: ${failure.error}`);
        }
        console.log(`Total: ${report.totals.imported} imported, ${report.totals.failed} failed across ${report.totals.sources} source(s).`);
      }
      if (report.sources.some(({ status }) => status !== "completed")) process.exitCode = 1;
    } finally {
      database.close();
    }
  });

for (const enabled of [true, false] as const) {
  const verb = enabled ? "enable" : "disable";
  sources.command(verb)
    .description(`${enabled ? "Enable" : "Disable"} a configured recipe source`)
    .argument("<source-id>", "stable source id")
    .action((sourceId: string) => {
      const id = validateRecipeSourceId(sourceId);
      const database = openExistingDatabase(databasePath());
      try {
        setRecipeSourceEnabled(database, id, enabled);
        console.log(`Recipe source ${id} ${enabled ? "enabled" : "disabled"}.`);
      } finally {
        database.close();
      }
    });
}

sources.command("remove")
  .description("Remove recipe-source configuration")
  .argument("<source-id>", "stable source id")
  .action((sourceId: string) => {
    const id = validateRecipeSourceId(sourceId);
    const database = openExistingDatabase(databasePath());
    try {
      removeRecipeSource(database, id);
      console.log(`Recipe source removed: ${id}.`);
    } finally {
      database.close();
    }
  });

const recipes = program
  .command("recipes")
  .description("Import, inspect, and manage recipes");

recipes.command("search")
  .description("Search persisted recipes in deterministic title order")
  .argument("[query]", "title text")
  .option("--source <source-id>", "configured source id", collectAtMostTwo, [])
  .option("--tag <dietary-tag>", "dietary tag", collectAtMostTwo, [])
  .option("--needs-review", "show only recipes needing review")
  .option("--limit <n>", "maximum results (1-100)", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action((query: string | undefined, options: {
    source: string[];
    tag: string[];
    needsReview?: boolean;
    limit: string[];
    json?: boolean;
  }) => {
    const limit = parseRecipeLimit(singletonOption(options.limit, "--limit"));
    const source = singletonOption(options.source, "--source");
    const tag = singletonOption(options.tag, "--tag");
    const sourceId = source === undefined ? undefined : validateRecipeSourceId(source);
    const dietaryTag = tag === undefined ? undefined : oneOf(tag, DIETARY_TAGS, "dietary tag");
    const listOptions = parseRecipeListOptions({
      ...(query === undefined ? {} : { query }),
      ...(sourceId === undefined ? {} : { sourceId }),
      ...(dietaryTag === undefined ? {} : { dietaryTag }),
      ...(options.needsReview === true ? { needsReview: true } : {}),
      limit,
    });
    const database = openExistingDatabase(databasePath());
    try {
      if (sourceId !== undefined && createConfigurationRepositories(database).recipeSources.get(sourceId) === null) {
        throw new Error(`Recipe source does not exist: ${sourceId}`);
      }
      const repository = createRecipeRepository(database);
      const result = repository.list(listOptions);
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else {
        console.log(`Recipes (${result.length})`);
        for (const recipe of result) {
          console.log(`- ${recipe.title} [${recipe.id}] · ${recipe.sourceId}${recipe.needsReview ? " · needs review" : ""}`);
        }
      }
    } finally {
      database.close();
    }
  });

recipes.command("show")
  .description("Show a persisted recipe with full provenance and ordered evidence")
  .argument("<recipe-id>", "exact stable recipe id")
  .option("--json", "emit stable JSON")
  .action((recipeId: string, options: { json?: boolean }) => {
    const parsedRecipeId = parseRecipeId(recipeId);
    const database = openExistingDatabase(databasePath());
    try {
      const recipe = createRecipeRepository(database).get(parsedRecipeId);
      if (recipe === null) throw new Error(`Recipe does not exist: ${parsedRecipeId}`);
      if (options.json) process.stdout.write(`${JSON.stringify(recipe, null, 2)}\n`);
      else printRecipe(recipe);
    } finally {
      database.close();
    }
  });

recipes.command("import")
  .description("Safely extract and persist one URL from an enabled configured source")
  .argument("<url>", "recipe page URL")
  .option("--source <source-id>", "explicit configured source id", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action(async (url: string, options: { source: string[]; json?: boolean }) => {
    const source = singletonOption(options.source, "--source");
    const sourceId = source === undefined ? undefined : validateRecipeSourceId(source);
    parseRecipeRequestUrl(url);
    const database = openExistingDatabase(databasePath());
    try {
      const result = await importRecipeUrl(database, {
        url,
        ...(sourceId === undefined ? {} : { sourceId }),
      });
      if (options.json) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
      else console.log(`Imported ${result.recipe.title} [${result.recipe.id}] from ${result.sourceId}.`);
    } finally {
      database.close();
    }
  });

recipes.command("review")
  .description("Noninteractively review safe recipe classification and planning fields")
  .argument("<recipe-id>", "exact stable recipe id")
  .option("--dietary-tag <tag>", "replace dietary tags; repeatable", collect, [])
  .option("--clear-dietary-tags", "clear all dietary tags")
  .option("--suitability-tag <tag>", "replace suitability tags; repeatable", collect, [])
  .option("--clear-suitability-tags", "clear all suitability tags")
  .option("--cuisine-tag <tag>", "replace cuisine tags; repeatable", collect, [])
  .option("--clear-cuisine-tags", "clear all cuisine tags")
  .option("--protein-tag <tag>", "set primary protein classification", collectAtMostTwo, [])
  .option("--clear-protein-tag", "clear primary protein classification")
  .option("--preference <value>", "favorite, neutral, or disliked", collectAtMostTwo, [])
  .option("--servings <n>", "set servings", collectAtMostTwo, [])
  .option("--clear-servings", "clear servings")
  .option("--prep-minutes <n>", "set preparation duration", collectAtMostTwo, [])
  .option("--clear-prep-minutes", "clear preparation duration")
  .option("--cook-minutes <n>", "set cooking duration", collectAtMostTwo, [])
  .option("--clear-cook-minutes", "clear cooking duration")
  .option("--total-minutes <n>", "set total duration", collectAtMostTwo, [])
  .option("--clear-total-minutes", "clear total duration")
  .option("--extra-meal-servings <n>", "set servings produced beyond the planned dinner", collectAtMostTwo, [])
  .option("--ingredients-json <json>", "replace reviewed ingredient evidence with a JSON array", collectAtMostTwo, [])
  .option("--mark-reviewed", "clear needs-review only when planning-critical evidence is complete")
  .option("--json", "emit stable JSON")
  .action((recipeId: string, options: {
    dietaryTag: string[];
    clearDietaryTags?: boolean;
    suitabilityTag: string[];
    clearSuitabilityTags?: boolean;
    cuisineTag: string[];
    clearCuisineTags?: boolean;
    proteinTag: string[];
    clearProteinTag?: boolean;
    preference: string[];
    servings: string[];
    clearServings?: boolean;
    prepMinutes: string[];
    clearPrepMinutes?: boolean;
    cookMinutes: string[];
    clearCookMinutes?: boolean;
    totalMinutes: string[];
    clearTotalMinutes?: boolean;
    extraMealServings: string[];
    ingredientsJson: string[];
    markReviewed?: boolean;
    json?: boolean;
  }) => {
    const parsedRecipeId = parseRecipeId(recipeId);
    const proteinTag = singletonOption(options.proteinTag, "--protein-tag");
    const preference = singletonOption(options.preference, "--preference");
    const servings = singletonOption(options.servings, "--servings");
    const prepMinutes = singletonOption(options.prepMinutes, "--prep-minutes");
    const cookMinutes = singletonOption(options.cookMinutes, "--cook-minutes");
    const totalMinutes = singletonOption(options.totalMinutes, "--total-minutes");
    const extraMealServings = singletonOption(options.extraMealServings, "--extra-meal-servings");
    const ingredientsJson = singletonOption(options.ingredientsJson, "--ingredients-json");
    rejectSetClearConflict(options.dietaryTag.length > 0, options.clearDietaryTags, "dietary tags");
    rejectSetClearConflict(options.suitabilityTag.length > 0, options.clearSuitabilityTags, "suitability tags");
    rejectSetClearConflict(options.cuisineTag.length > 0, options.clearCuisineTags, "cuisine tags");
    rejectSetClearConflict(proteinTag !== undefined, options.clearProteinTag, "protein tag");
    rejectSetClearConflict(servings !== undefined, options.clearServings, "servings");
    rejectSetClearConflict(prepMinutes !== undefined, options.clearPrepMinutes, "prep minutes");
    rejectSetClearConflict(cookMinutes !== undefined, options.clearCookMinutes, "cook minutes");
    rejectSetClearConflict(totalMinutes !== undefined, options.clearTotalMinutes, "total minutes");
    if (options.markReviewed === true) {
      if (options.clearServings === true) throw new Error("Cannot mark reviewed while clearing servings");
      if (options.clearDietaryTags === true) throw new Error("Cannot mark reviewed while clearing dietary tags");
      if (
        options.clearPrepMinutes === true
        && options.clearCookMinutes === true
        && options.clearTotalMinutes === true
      ) {
        throw new Error("Cannot mark reviewed while clearing every duration");
      }
    }
    const patchInput: RecipeReviewPatch = {
      ...(options.clearDietaryTags === true ? { dietaryTags: [] } : options.dietaryTag.length === 0 ? {} : {
        dietaryTags: options.dietaryTag.map((tag) => oneOf(tag, DIETARY_TAGS, "dietary tag")),
      }),
      ...(options.clearSuitabilityTags === true ? { suitabilityTags: [] } : options.suitabilityTag.length === 0 ? {} : {
        suitabilityTags: options.suitabilityTag.map((tag) => oneOf(tag, SUITABILITY_TAGS, "suitability tag")),
      }),
      ...(options.clearCuisineTags === true ? { cuisineTags: [] } : options.cuisineTag.length === 0 ? {} : { cuisineTags: options.cuisineTag }),
      ...(options.clearProteinTag === true ? { proteinTag: null } : proteinTag === undefined ? {} : { proteinTag }),
      ...(preference === undefined ? {} : {
        preference: oneOf(preference, RECIPE_PREFERENCES, "recipe preference"),
      }),
      ...(options.clearServings === true ? { servings: null } : servings === undefined ? {} : { servings: positiveNumber(servings, "Servings") }),
      ...(options.clearPrepMinutes === true ? { prepMinutes: null } : prepMinutes === undefined ? {} : { prepMinutes: nonnegativeInteger(prepMinutes, "Prep minutes") }),
      ...(options.clearCookMinutes === true ? { cookMinutes: null } : cookMinutes === undefined ? {} : { cookMinutes: nonnegativeInteger(cookMinutes, "Cook minutes") }),
      ...(options.clearTotalMinutes === true ? { totalMinutes: null } : totalMinutes === undefined ? {} : { totalMinutes: nonnegativeInteger(totalMinutes, "Total minutes") }),
      ...(extraMealServings === undefined ? {} : {
        extraMealServings: nonnegativeNumber(extraMealServings, "Extra meal servings"),
      }),
      ...(options.markReviewed === true ? { markReviewed: true } : {}),
    };
    if (Object.keys(patchInput).length === 0 && ingredientsJson === undefined) throw new Error("At least one recipe review option is required");
    const patch = parseRecipeReviewPatch({ ...patchInput,
      ...(ingredientsJson === undefined ? {} : { ingredients: parseJson(ingredientsJson, "--ingredients-json") }),
    });
    const database = openExistingDatabase(databasePath());
    try {
      const reviewed = reviewRecipe(database, parsedRecipeId, patch);
      if (options.json) process.stdout.write(`${JSON.stringify(reviewed, null, 2)}\n`);
      else console.log(`Reviewed ${reviewed.title} [${reviewed.id}] · ${reviewed.needsReview ? "still needs review" : "complete"}.`);
    } finally {
      database.close();
    }
  });

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

recipes.command("prep-link")
  .description("Link measured preparation or leftovers to a saved future meal")
  .argument("<recipe-id>", "source recipe")
  .requiredOption("--target-meal <id>", "future stable meal id", collectAtMostTwo, [])
  .requiredOption("--ingredient <name>", "normalized ingredient", collectAtMostTwo, [])
  .requiredOption("--quantity <n>", "measured quantity", collectAtMostTwo, [])
  .requiredOption("--unit <unit>", "g, ml, or stk", collectAtMostTwo, [])
  .requiredOption("--note <text>", "explicit preparation task", collectAtMostTwo, [])
  .option("--kind <kind>", "prep or leftover", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action((recipeId: string, options: { targetMeal: string[]; ingredient: string[]; quantity: string[]; unit: string[]; note: string[]; kind: string[]; json?: boolean }) => {
    const input = parsePrepLinkInput({ sourceRecipeId: parseRecipeId(recipeId),
      targetMealId: singletonOption(options.targetMeal, "--target-meal"),
      normalizedIngredient: singletonOption(options.ingredient, "--ingredient"),
      quantity: positiveNumber(singletonOption(options.quantity, "--quantity")!, "--quantity"),
      unit: singletonOption(options.unit, "--unit"),
      note: singletonOption(options.note, "--note"), kind: singletonOption(options.kind, "--kind") ?? "prep",
    });
    const database = openExistingDatabase(databasePath());
    try {
      const link = createPrepLinkRepository(database).add(input);
      if (options.json) process.stdout.write(`${JSON.stringify(link, null, 2)}\n`);
      else console.log(`${link.id}: ${link.note} → ${link.targetDate} [${link.targetMealId}]`);
    } finally { database.close(); }
  });

recipes.command("remove-prep-link")
  .argument("<link-id>", "unreferenced prep link id")
  .action((id: string) => {
    const database = openExistingDatabase(databasePath());
    try { createPrepLinkRepository(database).remove(id); console.log(`Removed ${id}`); }
    finally { database.close(); }
  });

const plan = program.command("plan").description("Create, inspect, accept, and edit weekly meal plans");
registerPlanEditCommands(plan, databasePath);
registerShoppingListCommand(program, databasePath);

plan.command("create")
  .description("Create and save a deterministic family-aware draft")
  .option("--week <date|next>", "date in the requested week, or next", collectAtMostTwo, [])
  .option("--seed <value>", "deterministic selection seed", collectAtMostTwo, [])
  .option("--no-deals", "skip live deals and package estimates")
  .option("--json", "emit stable JSON")
  .action(async (options: { week: string[]; seed: string[]; deals: boolean; json?: boolean }) => {
    const requestedWeek = singletonOption(options.week, "--week");
    const requestedSeed = singletonOption(options.seed, "--seed");
    const plannedAt = new Date().toISOString();
    const weekStart = resolvePlanWeekStart(requestedWeek, localDateInDenmark(new Date(plannedAt)));
    const seed = requestedSeed ?? `week:${weekStart}`;
    if (seed.length === 0 || seed.length > 500) throw new Error("--seed must contain 1-500 characters");
    const database = openExistingDatabase(databasePath());
    try {
      const created = await createPlanWithDeals(database, { week: weekStart, seed, plannedAt, noDeals: !options.deals });
      if (options.json) process.stdout.write(`${JSON.stringify(created, null, 2)}\n`);
      else {
        const recipesById = new Map(createRecipeRepository(database).list({ limit: 500 })
          .map((recipe) => [recipe.id, recipe]));
        printPlan(created, recipesById);
      }
    } finally {
      database.close();
    }
  });

plan.command("show")
  .description("Show the active draft or accepted plan for a week")
  .option("--week <date|next>", "date in the requested week, or next", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action((options: { week: string[]; json?: boolean }) => {
    const requestedWeek = singletonOption(options.week, "--week");
    const weekStart = resolvePlanWeekStart(requestedWeek, localDateInDenmark());
    const database = openExistingDatabase(databasePath());
    try {
      const shown = createPlanRepository(database).getForWeek(weekStart);
      if (shown === null) throw new Error(`No plan exists for week ${weekStart}`);
      if (options.json) process.stdout.write(`${JSON.stringify(shown, null, 2)}\n`);
      else {
        const recipesById = new Map(createRecipeRepository(database).list({ limit: 500 })
          .map((recipe) => [recipe.id, recipe]));
        printPlan(shown, recipesById);
      }
    } finally {
      database.close();
    }
  });

plan.command("accept")
  .description("Accept the saved draft for a week and record meal history")
  .option("--week <date|next>", "date in the requested week, or next", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action((options: { week: string[]; json?: boolean }) => {
    const requestedWeek = singletonOption(options.week, "--week");
    const weekStart = resolvePlanWeekStart(requestedWeek, localDateInDenmark());
    const acceptedAt = new Date().toISOString();
    const database = openExistingDatabase(databasePath());
    try {
      const repository = createPlanRepository(database);
      const current = repository.getForWeek(weekStart);
      if (current === null) throw new Error(`No plan exists for week ${weekStart}`);
      const accepted = repository.accept(current.id, acceptedAt);
      if (options.json) process.stdout.write(`${JSON.stringify(accepted, null, 2)}\n`);
      else {
        const recipesById = new Map(createRecipeRepository(database).list({ limit: 500 })
          .map((recipe) => [recipe.id, recipe]));
        printPlan(accepted, recipesById);
      }
    } finally {
      database.close();
    }
  });

const backup = program.command("backup").description("Create and restore verified local-state bundles");

backup.command("create")
  .description("Create a coherent SQLite backup with optional persistent TilbudsTrolden data")
  .argument("<bundle-directory>", "new backup bundle directory")
  .option("--mcp-data <path>", "persistent TilbudsTrolden JSON file to include", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action(async (bundleDirectory: string, options: { mcpData: string[]; json?: boolean }) => {
    if (bundleDirectory.trim().length === 0) throw new Error("Backup bundle path cannot be empty");
    const mcpDataPath = singletonOption(options.mcpData, "--mcp-data");
    const bundlePath = resolve(bundleDirectory);
    const manifest = await createBackupBundle({
      databasePath: databasePath(),
      bundlePath,
      ...(mcpDataPath === undefined ? {} : { mcpDataPath }),
    });
    if (options.json) {
      process.stdout.write(`${JSON.stringify({ bundlePath, manifest }, null, 2)}\n`);
    } else {
      console.log(`Backup created: ${bundlePath}`);
      if (manifest.mcp.mode === "ephemeral-regenerated") {
        console.log("Planning MCP sessions are ephemeral and will be regenerated.");
      }
    }
  });

backup.command("restore")
  .description("Validate and restore a bundle into a new state directory")
  .argument("<bundle-directory>", "backup bundle directory")
  .requiredOption("--to <directory>", "new, nonexistent restore directory", collectAtMostTwo, [])
  .option("--json", "emit stable JSON")
  .action(async (bundleDirectory: string, options: { to: string[]; json?: boolean }) => {
    if (bundleDirectory.trim().length === 0) throw new Error("Backup bundle path cannot be empty");
    const destinationDirectory = singletonOption(options.to, "--to");
    if (destinationDirectory === undefined || destinationDirectory.trim().length === 0) {
      throw new Error("Restore destination cannot be empty");
    }
    const restored = await restoreBackupBundle({ bundlePath: bundleDirectory, destinationDirectory });
    if (options.json) {
      process.stdout.write(`${JSON.stringify(restored, null, 2)}\n`);
    } else {
      console.log(`Backup restored: ${restored.databasePath}`);
      console.log(`Activate with MEALPLAN_DATABASE=${restored.databasePath}`);
      if (restored.mcpDataPath !== null) {
        console.log(`Persistent MCP data: TILBUDSTROLDEN_DATA=${restored.mcpDataPath}`);
      }
    }
  });

const integrations = program
  .command("integrations")
  .description("Inspect external recipe and deal integrations");

integrations
  .command("verify-deals")
  .description("Verify compatibility with the pinned TilbudsTrolden MCP server")
  .option("--server <path>", "server entry point; defaults to the production sidecar resolver")
  .option("--data <path>", "isolated TilbudsTrolden data file", ".data/tilbudstrolden.json")
  .option("--json", "emit stable JSON")
  .action(async (options: { server?: string; data: string; json?: boolean }) => {
    const serverDirectory = options.server === undefined ? resolvePlanningServerDirectory() : process.cwd();
    const serverPath = options.server === undefined
      ? join(serverDirectory, "dist/server.js")
      : resolve(options.server);
    const dataPath = resolve(options.data);
    await mkdir(dirname(dataPath), { recursive: true });

    await using client = new TilbudstroldenClient({
      command: "node",
      args: [serverPath],
      cwd: serverDirectory,
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
