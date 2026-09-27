import type { Database } from "bun:sqlite";
import { z } from "zod";
import { BUILT_IN_RECIPE_SOURCES } from "../adapters/recipes/sources";
import {
  MAX_HOUSEHOLD_MEMBERS,
  MAX_PANTRY_ITEMS_PER_OPERATION,
  RECIPE_SOURCE_ADAPTERS,
} from "../domain/configuration";
import {
  createConfigurationRepositories,
  type DayProfile,
  type HouseholdMember,
  type HouseholdRuleInput,
  type PantryItemInput,
  type PreferredStore,
  type RecipeSource,
} from "../infrastructure/configuration-repositories";

const identifierSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const memberSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["adult", "child"]),
  servings: z.number().positive().finite(),
}).strict();
const ruleSchema = z.object({
  memberId: identifierSchema.nullable(),
  kind: z.enum(["dietary_restriction", "disliked_ingredient"]),
  value: z.string().max(500).refine((value) => value.trim().length > 0, "Rule value cannot be empty"),
}).strict();
const dayProfileSchema = z.object({
  day: z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]),
  maxTotalMinutes: z.number().int().positive().nullable(),
  requiredServingModes: z.array(z.enum(["immediate", "keep-warm", "reheat", "assemble-later"])).max(4),
  easyOnly: z.boolean(),
  minimumExtraMeals: z.number().int().nonnegative(),
  prepLinkSatisfiesMinimum: z.boolean(),
  notes: z.string().max(1_000).nullable(),
}).strict();
const preferredStoreSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  dealerId: z.string().min(1).max(200).nullable(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  priority: z.number().int().nonnegative(),
  dealsEnabled: z.boolean(),
}).strict();
const recipeSourceSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().max(2_048).url(),
  adapter: z.enum(RECIPE_SOURCE_ADAPTERS),
  enabled: z.boolean(),
}).strict();
const pantryItemSchema = z.object({
  name: z.string().trim().min(1).max(200).refine(
    (name) => name.normalize("NFKC").trim().replace(/\s+/g, " ").length <= 200,
    "Normalized pantry name is too long",
  ),
  quantity: z.string().max(500).refine(
    (quantity) => quantity.trim().length > 0,
    "Pantry quantity cannot be empty",
  ),
}).strict();

const setupConfigurationSchema = z.object({
  members: z.array(memberSchema).min(1).max(MAX_HOUSEHOLD_MEMBERS),
  rules: z.array(ruleSchema),
  dayProfiles: z.array(dayProfileSchema).length(7),
  preferredStores: z.array(preferredStoreSchema).min(1),
  recipeSources: z.array(recipeSourceSchema),
  pantryItems: z.array(pantryItemSchema).max(MAX_PANTRY_ITEMS_PER_OPERATION),
}).strict().superRefine((configuration, context) => {
  const memberIds = new Set<string>();
  for (const [index, member] of configuration.members.entries()) {
    if (memberIds.has(member.id)) {
      context.addIssue({ code: "custom", message: `Duplicate member id: ${member.id}`, path: ["members", index, "id"] });
    }
    memberIds.add(member.id);
  }
  for (const [index, rule] of configuration.rules.entries()) {
    if (rule.memberId !== null && !memberIds.has(rule.memberId)) {
      context.addIssue({
        code: "custom",
        message: `Rule references unknown member: ${rule.memberId}`,
        path: ["rules", index, "memberId"],
      });
    }
  }
  if (new Set(configuration.dayProfiles.map(({ day }) => day)).size !== 7) {
    context.addIssue({ code: "custom", message: "Day profiles must contain each weekday exactly once", path: ["dayProfiles"] });
  }
  if (new Set(configuration.preferredStores.map(({ id }) => id)).size !== configuration.preferredStores.length) {
    context.addIssue({ code: "custom", message: "Preferred stores must have unique ids", path: ["preferredStores"] });
  }
});

export type SetupConfiguration = z.infer<typeof setupConfigurationSchema>;
export type SetupAnswers = {
  readonly members: readonly HouseholdMember[];
  readonly rules?: readonly HouseholdRuleInput[];
  readonly preferredStoreNames?: readonly string[];
  readonly pantryItems?: readonly PantryItemInput[];
};

export const DEFAULT_DAY_PROFILES: readonly DayProfile[] = [
  { day: "mon", maxTotalMinutes: 60, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false, notes: "Normal family meal" },
  { day: "tue", maxTotalMinutes: null, requiredServingModes: ["keep-warm", "reheat"], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false, notes: "Suitable for a late arrival" },
  { day: "wed", maxTotalMinutes: null, requiredServingModes: ["reheat"], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false, notes: "Suitable for reheating" },
  { day: "thu", maxTotalMinutes: 30, requiredServingModes: [], easyOnly: true, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false, notes: "Easy badminton-day meal" },
  { day: "fri", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false, notes: "Extra cooking time available" },
  { day: "sat", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 0, prepLinkSatisfiesMinimum: false, notes: "Dinner remains configurable" },
  { day: "sun", maxTotalMinutes: null, requiredServingModes: [], easyOnly: false, minimumExtraMeals: 1, prepLinkSatisfiesMinimum: true, notes: "Batch meal or preparation linked to later meals" },
];

export const DEFAULT_STORE_NAMES = ["REMA 1000", "Netto", "SuperBrugsen"] as const;

function storeId(name: string): string {
  const id = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLocaleLowerCase("da-DK")
    .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return identifierSchema.parse(id);
}

export function createSetupConfiguration(answers: SetupAnswers): SetupConfiguration {
  const stores: PreferredStore[] = (answers.preferredStoreNames ?? DEFAULT_STORE_NAMES).map((name, priority) => ({
    id: storeId(name),
    name,
    dealerId: null,
    countryCode: "DK",
    priority,
    dealsEnabled: false,
  }));
  const sources: RecipeSource[] = BUILT_IN_RECIPE_SOURCES.map((source) => ({
    id: source.id,
    name: source.name,
    baseUrl: source.baseUrl,
    adapter: source.extraction,
    enabled: true,
  })).sort((left, right) => left.id.localeCompare(right.id));

  return setupConfigurationSchema.parse({
    members: answers.members,
    rules: answers.rules ?? [],
    dayProfiles: DEFAULT_DAY_PROFILES,
    preferredStores: stores,
    recipeSources: sources,
    pantryItems: answers.pantryItems ?? [],
  });
}

export function validateSetupConfiguration(input: unknown): SetupConfiguration {
  return setupConfigurationSchema.parse(input);
}

export function applySetup(database: Database, input: SetupConfiguration): void {
  const configuration = validateSetupConfiguration(input);

  database.transaction(() => {
    const repositories = createConfigurationRepositories(database);
    const desiredSourcesById = new Map(configuration.recipeSources.map((source) => [source.id, source]));
    const referencedSources = database.query<{ id: string; baseUrl: string }, []>(`
      SELECT DISTINCT recipe_sources.id, recipe_sources.base_url AS baseUrl
      FROM recipe_sources
      INNER JOIN recipes ON recipes.source_id = recipe_sources.id
    `).all();
    for (const existingSource of referencedSources) {
      const desiredSource = desiredSourcesById.get(existingSource.id);
      if (
        desiredSource !== undefined
        && new URL(existingSource.baseUrl).href !== new URL(desiredSource.baseUrl).href
      ) {
        throw new Error(
          `Cannot change base URL for referenced recipe source ${existingSource.id} from ${existingSource.baseUrl} to ${desiredSource.baseUrl}`,
        );
      }
    }

    for (const source of repositories.recipeSources.list()) {
      if (desiredSourcesById.has(source.id)) continue;
      const referencedRecipes = database.query<{ count: number }, [string]>(
        "SELECT COUNT(*) AS count FROM recipes WHERE source_id = ?",
      ).get(source.id)?.count ?? 0;
      if (referencedRecipes > 0) {
        repositories.recipeSources.upsert({ ...source, enabled: false });
      } else {
        repositories.recipeSources.remove(source.id);
      }
    }

    database.exec(`
      DELETE FROM household_rules;
      DELETE FROM household_members;
      DELETE FROM day_profiles;
      DELETE FROM preferred_stores;
    `);
    for (const member of configuration.members) repositories.householdMembers.upsert(member);
    for (const rule of configuration.rules) repositories.householdRules.upsert(rule);
    for (const profile of configuration.dayProfiles) repositories.dayProfiles.upsert(profile);
    for (const store of configuration.preferredStores) repositories.preferredStores.upsert(store);
    for (const source of configuration.recipeSources) repositories.recipeSources.upsert(source);
    for (const item of configuration.pantryItems) repositories.pantryItems.upsert(item);
  }).immediate();
}
