import type { Database } from "bun:sqlite";
import { z } from "zod";
import { RECIPE_SOURCE_ADAPTERS } from "../domain/configuration";

const identifierSchema = z.string().trim().min(1).max(100).regex(/^[a-z0-9][a-z0-9_-]*$/i);
const householdMemberInputSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  kind: z.enum(["adult", "child"]),
  servings: z.number().positive().finite(),
}).strict();

export type HouseholdMember = z.infer<typeof householdMemberInputSchema>;

const householdMemberRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  servings: z.number(),
}).strict();
const householdMemberOutputSchema = householdMemberInputSchema;

const householdRuleInputSchema = z.object({
  memberId: identifierSchema.nullable(),
  kind: z.enum(["dietary_restriction", "disliked_ingredient"]),
  value: z.string().max(500).refine((value) => value.trim().length > 0, "Rule value cannot be empty"),
}).strict();

export type HouseholdRuleInput = z.infer<typeof householdRuleInputSchema>;

const householdRuleRowSchema = z.object({
  id: z.string(),
  memberId: z.string().nullable(),
  kind: z.string(),
  value: z.string(),
  normalizedValue: z.string(),
}).strict();
const householdRuleOutputSchema = householdRuleInputSchema.extend({
  id: z.string().min(1),
}).superRefine((rule, context) => {
  const expectedId = createHouseholdRuleId(rule);
  if (rule.id !== expectedId) {
    context.addIssue({
      code: "custom",
      message: "Household rule id does not match its identity",
      path: ["id"],
    });
  }
});
export type HouseholdRule = z.infer<typeof householdRuleOutputSchema>;

const daySchema = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const servingModeSchema = z.enum(["immediate", "keep-warm", "reheat", "assemble-later"]);
const dayProfileSchema = z.object({
  day: daySchema,
  maxTotalMinutes: z.number().int().positive().nullable(),
  requiredServingModes: z.array(servingModeSchema).max(4),
  easyOnly: z.boolean(),
  minimumExtraMeals: z.number().int().nonnegative(),
  prepLinkSatisfiesMinimum: z.boolean(),
  notes: z.string().max(1_000).nullable(),
}).strict();

export type DayProfile = z.infer<typeof dayProfileSchema>;
const dayProfileOutputSchema = dayProfileSchema;

const recipeSourceSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  baseUrl: z.string().max(2_048).url().refine((value) => {
    const protocol = new URL(value).protocol;
    return protocol === "http:" || protocol === "https:";
  }, "Recipe source URL must use HTTP or HTTPS"),
  adapter: z.enum(RECIPE_SOURCE_ADAPTERS),
  enabled: z.boolean(),
}).strict();

export type RecipeSource = z.infer<typeof recipeSourceSchema>;
const recipeSourceOutputSchema = recipeSourceSchema;

const pantryItemInputSchema = z.object({
  name: z.string().trim().min(1).max(200),
  quantity: z.string().max(500).refine(
    (quantity) => quantity.trim().length > 0,
    "Pantry quantity cannot be empty",
  ),
}).strict();

export type PantryItemInput = z.infer<typeof pantryItemInputSchema>;

const pantryItemRowSchema = z.object({
  normalizedName: z.string(),
  name: z.string(),
  quantity: z.string(),
}).strict();
const pantryItemOutputSchema = pantryItemInputSchema.extend({
  normalizedName: z.string().min(1).max(200),
}).superRefine((item,context) => {
  if (item.normalizedName !== normalizeKey(item.name)) {
    context.addIssue({
      code: "custom",
      message: "Pantry normalized name does not match its name",
      path: ["normalizedName"],
    });
  }
});
export type PantryItem = z.infer<typeof pantryItemOutputSchema>;

const preferredStoreSchema = z.object({
  id: identifierSchema,
  name: z.string().trim().min(1).max(200),
  dealerId: z.string().min(1).max(200).nullable(),
  countryCode: z.string().regex(/^[A-Z]{2}$/),
  priority: z.number().int().nonnegative(),
  dealsEnabled: z.boolean(),
}).strict();

export type PreferredStore = z.infer<typeof preferredStoreSchema>;
const preferredStoreOutputSchema = preferredStoreSchema;

const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);

const preferredStoreRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  dealerId: z.string().nullable(),
  countryCode: z.string(),
  priority: z.number(),
  dealsEnabled: sqliteBooleanSchema,
}).strict();

const recipeSourceRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  baseUrl: z.string(),
  adapter: z.string(),
  enabled: sqliteBooleanSchema,
  archived: sqliteBooleanSchema,
}).strict();

const dayProfileRowSchema = z.object({
  day: z.string(),
  maxTotalMinutes: z.number().nullable(),
  requiredServingModesJson: z.string(),
  easyOnly: sqliteBooleanSchema,
  minimumExtraMeals: z.number(),
  prepLinkSatisfiesMinimum: sqliteBooleanSchema,
  notes: z.string().nullable(),
}).strict();

function normalizeKey(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/g, " ").toLocaleLowerCase("da-DK");
}

export function createHouseholdRuleId(rule: HouseholdRuleInput): string {
  const normalizedValue = normalizeKey(rule.value);
  const scope = rule.memberId === null ? "household" : `member:${rule.memberId}`;
  return `rule:${scope}:${rule.kind}:${encodeURIComponent(normalizedValue)}`;
}

function toHouseholdRule(rawRow: unknown): HouseholdRule {
  const row = householdRuleRowSchema.parse(rawRow);
  const { normalizedValue, ...persistedRule } = row;
  const rule = householdRuleOutputSchema.parse(persistedRule);
  if (normalizedValue !== normalizeKey(rule.value)) {
    throw new Error("Household rule normalized value does not match its value");
  }
  return rule;
}

class HouseholdMemberRepository {
  constructor(private readonly database: Database) {}

  upsert(input: HouseholdMember): HouseholdMember {
    const member = householdMemberInputSchema.parse(input);
    this.database.query(`
      INSERT INTO household_members (id, name, kind, servings, created_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        kind = excluded.kind,
        servings = excluded.servings
    `).run(member.id, member.name, member.kind, member.servings, new Date().toISOString());
    return member;
  }

  get(id: string): HouseholdMember | null {
    const parsedId = identifierSchema.parse(id);
    const row = this.database
      .query<Record<string, unknown>, [string]>(
        "SELECT id, name, kind, servings FROM household_members WHERE id = ?",
      )
      .get(parsedId);
    return row === null
      ? null
      : householdMemberOutputSchema.parse(householdMemberRowSchema.parse(row));
  }

  list(): HouseholdMember[] {
    return this.database
      .query<Record<string, unknown>, []>(
        "SELECT id, name, kind, servings FROM household_members ORDER BY id",
      )
      .all()
      .map((row) => householdMemberOutputSchema.parse(householdMemberRowSchema.parse(row)));
  }

  remove(id: string): boolean {
    const parsedId = identifierSchema.parse(id);
    return this.database.query("DELETE FROM household_members WHERE id = ?").run(parsedId).changes === 1;
  }
}

class HouseholdRuleRepository {
  constructor(private readonly database: Database) {}

  upsert(input: HouseholdRuleInput): HouseholdRule {
    const rule = householdRuleInputSchema.parse(input);
    const normalizedValue = normalizeKey(rule.value);
    const id = createHouseholdRuleId(rule);
    this.database.query(`
      INSERT INTO household_rules (id, member_id, kind, value, normalized_value, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        member_id = excluded.member_id,
        kind = excluded.kind,
        value = excluded.value,
        normalized_value = excluded.normalized_value
    `).run(id, rule.memberId, rule.kind, rule.value, normalizedValue, new Date().toISOString());
    return { id, ...rule };
  }

  get(id: string): HouseholdRule | null {
    const row = this.database
      .query<Record<string, unknown>, [string]>(`
        SELECT id, member_id AS memberId, kind, value, normalized_value AS normalizedValue
        FROM household_rules
        WHERE id = ?
      `)
      .get(z.string().min(1).parse(id));
    return row === null ? null : toHouseholdRule(row);
  }

  list(): HouseholdRule[] {
    return this.database
      .query<Record<string, unknown>, []>(`
        SELECT id, member_id AS memberId, kind, value, normalized_value AS normalizedValue
        FROM household_rules
        ORDER BY member_id IS NOT NULL, member_id, kind, normalized_value
      `)
      .all()
      .map(toHouseholdRule);
  }

  remove(id: string): boolean {
    return this.database.query("DELETE FROM household_rules WHERE id = ?")
      .run(z.string().min(1).parse(id)).changes === 1;
  }
}

function toDayProfile(rawRow: unknown): DayProfile {
  const row = dayProfileRowSchema.parse(rawRow);
  const { requiredServingModesJson, ...profile } = row;
  return dayProfileOutputSchema.parse({
    ...profile,
    requiredServingModes: JSON.parse(requiredServingModesJson),
    easyOnly: row.easyOnly === 1,
    prepLinkSatisfiesMinimum: row.prepLinkSatisfiesMinimum === 1,
  });
}

class DayProfileRepository {
  constructor(private readonly database: Database) {}

  upsert(input: DayProfile): DayProfile {
    const profile = dayProfileSchema.parse(input);
    this.database.query(`
      INSERT INTO day_profiles (
        day, max_total_minutes, required_serving_modes, easy_only,
        minimum_extra_meals, prep_link_satisfies_minimum, notes
      ) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(day) DO UPDATE SET
        max_total_minutes = excluded.max_total_minutes,
        required_serving_modes = excluded.required_serving_modes,
        easy_only = excluded.easy_only,
        minimum_extra_meals = excluded.minimum_extra_meals,
        prep_link_satisfies_minimum = excluded.prep_link_satisfies_minimum,
        notes = excluded.notes
    `).run(
      profile.day,
      profile.maxTotalMinutes,
      JSON.stringify(profile.requiredServingModes),
      profile.easyOnly ? 1 : 0,
      profile.minimumExtraMeals,
      profile.prepLinkSatisfiesMinimum ? 1 : 0,
      profile.notes,
    );
    return profile;
  }

  get(day: DayProfile["day"]): DayProfile | null {
    const row = this.database.query<Record<string, unknown>, [string]>(`
      SELECT
        day,
        max_total_minutes AS maxTotalMinutes,
        required_serving_modes AS requiredServingModesJson,
        easy_only AS easyOnly,
        minimum_extra_meals AS minimumExtraMeals,
        prep_link_satisfies_minimum AS prepLinkSatisfiesMinimum,
        notes
      FROM day_profiles
      WHERE day = ?
    `).get(daySchema.parse(day));
    return row === null ? null : toDayProfile(row);
  }

  list(): DayProfile[] {
    return this.database.query<Record<string, unknown>, []>(`
      SELECT
        day,
        max_total_minutes AS maxTotalMinutes,
        required_serving_modes AS requiredServingModesJson,
        easy_only AS easyOnly,
        minimum_extra_meals AS minimumExtraMeals,
        prep_link_satisfies_minimum AS prepLinkSatisfiesMinimum,
        notes
      FROM day_profiles
      ORDER BY CASE day
        WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3 WHEN 'thu' THEN 4
        WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 WHEN 'sun' THEN 7
      END
    `).all().map(toDayProfile);
  }

  remove(day: DayProfile["day"]): boolean {
    return this.database.query("DELETE FROM day_profiles WHERE day = ?")
      .run(daySchema.parse(day)).changes === 1;
  }
}

function toRecipeSource(rawRow: unknown): RecipeSource {
  const row = recipeSourceRowSchema.parse(rawRow);
  const { archived: _archived, ...source } = row;
  return recipeSourceOutputSchema.parse({ ...source, enabled: row.enabled === 1 });
}

type StoredRecipeSource = RecipeSource & { readonly archived: boolean };

function toStoredRecipeSource(rawRow: unknown): StoredRecipeSource {
  const row = recipeSourceRowSchema.parse(rawRow);
  return { ...toRecipeSource(row), archived: row.archived === 1 };
}

class RecipeSourceRepository {
  constructor(private readonly database: Database) {}

  upsert(input: RecipeSource): RecipeSource {
    const source = recipeSourceSchema.parse(input);
    this.database.query(`
      INSERT INTO recipe_sources (id, name, base_url, adapter, enabled, archived)
      VALUES (?, ?, ?, ?, ?, 0)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        base_url = excluded.base_url,
        adapter = excluded.adapter,
        enabled = excluded.enabled,
        archived = 0
    `).run(source.id, source.name, source.baseUrl, source.adapter, source.enabled ? 1 : 0);
    return source;
  }

  get(id: string): RecipeSource | null {
    const row = this.database.query<Record<string, unknown>, [string]>(`
      SELECT id, name, base_url AS baseUrl, adapter, enabled, archived
      FROM recipe_sources
      WHERE id = ? AND archived = 0
    `).get(identifierSchema.parse(id));
    return row === null ? null : toRecipeSource(row);
  }

  getIncludingArchived(id: string): StoredRecipeSource | null {
    const row = this.database.query<Record<string, unknown>, [string]>(`
      SELECT id, name, base_url AS baseUrl, adapter, enabled, archived
      FROM recipe_sources
      WHERE id = ?
    `).get(identifierSchema.parse(id));
    return row === null ? null : toStoredRecipeSource(row);
  }

  list(): RecipeSource[] {
    return this.database.query<Record<string, unknown>, []>(`
      SELECT id, name, base_url AS baseUrl, adapter, enabled, archived
      FROM recipe_sources
      WHERE archived = 0
      ORDER BY id
    `).all().map(toRecipeSource);
  }

  listIncludingArchived(): StoredRecipeSource[] {
    return this.database.query<Record<string, unknown>, []>(`
      SELECT id, name, base_url AS baseUrl, adapter, enabled, archived
      FROM recipe_sources
      ORDER BY id
    `).all().map(toStoredRecipeSource);
  }

  archive(id: string): boolean {
    return this.database.query("UPDATE recipe_sources SET enabled = 0, archived = 1 WHERE id = ? AND archived = 0")
      .run(identifierSchema.parse(id)).changes === 1;
  }

  remove(id: string): boolean {
    return this.database.query("DELETE FROM recipe_sources WHERE id = ?")
      .run(identifierSchema.parse(id)).changes === 1;
  }
}

class PantryItemRepository {
  constructor(private readonly database: Database) {}

  upsert(input: PantryItemInput): PantryItem {
    const item = pantryItemInputSchema.parse(input);
    const persistedItem = pantryItemOutputSchema.parse({
      normalizedName: normalizeKey(item.name),
      ...item,
    });
    this.database.query(`
      INSERT INTO pantry_items (normalized_name, name, quantity)
      VALUES (?, ?, ?)
      ON CONFLICT(normalized_name) DO UPDATE SET
        name = excluded.name,
        quantity = excluded.quantity
    `).run(persistedItem.normalizedName, persistedItem.name, persistedItem.quantity);
    return persistedItem;
  }

  get(name: string): PantryItem | null {
    const row = this.database.query<Record<string, unknown>, [string]>(`
      SELECT normalized_name AS normalizedName, name, quantity
      FROM pantry_items
      WHERE normalized_name = ?
    `).get(normalizeKey(z.string().min(1).parse(name)));
    return row === null
      ? null
      : pantryItemOutputSchema.parse(pantryItemRowSchema.parse(row));
  }

  list(): PantryItem[] {
    return this.database.query<Record<string, unknown>, []>(`
      SELECT normalized_name AS normalizedName, name, quantity
      FROM pantry_items
      ORDER BY normalized_name
    `).all().map((row) => pantryItemOutputSchema.parse(pantryItemRowSchema.parse(row)));
  }

  remove(name: string): boolean {
    const normalizedName = normalizeKey(z.string().min(1).parse(name));
    return this.database.query("DELETE FROM pantry_items WHERE normalized_name = ?")
      .run(normalizedName).changes === 1;
  }
}

function toPreferredStore(rawRow: unknown): PreferredStore {
  const row = preferredStoreRowSchema.parse(rawRow);
  return preferredStoreOutputSchema.parse({ ...row, dealsEnabled: row.dealsEnabled === 1 });
}

class PreferredStoreRepository {
  constructor(private readonly database: Database) {}

  upsert(input: PreferredStore): PreferredStore {
    const store = preferredStoreSchema.parse(input);
    this.database.query(`
      INSERT INTO preferred_stores (
        id, name, dealer_id, country_code, priority, deals_enabled
      ) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        dealer_id = excluded.dealer_id,
        country_code = excluded.country_code,
        priority = excluded.priority,
        deals_enabled = excluded.deals_enabled
    `).run(
      store.id,
      store.name,
      store.dealerId,
      store.countryCode,
      store.priority,
      store.dealsEnabled ? 1 : 0,
    );
    return store;
  }

  get(id: string): PreferredStore | null {
    const row = this.database.query<Record<string, unknown>, [string]>(`
      SELECT
        id, name, dealer_id AS dealerId, country_code AS countryCode,
        priority, deals_enabled AS dealsEnabled
      FROM preferred_stores
      WHERE id = ?
    `).get(identifierSchema.parse(id));
    return row === null ? null : toPreferredStore(row);
  }

  list(): PreferredStore[] {
    return this.database.query<Record<string, unknown>, []>(`
      SELECT
        id, name, dealer_id AS dealerId, country_code AS countryCode,
        priority, deals_enabled AS dealsEnabled
      FROM preferred_stores
      ORDER BY priority, id
    `).all().map(toPreferredStore);
  }

  remove(id: string): boolean {
    return this.database.query("DELETE FROM preferred_stores WHERE id = ?")
      .run(identifierSchema.parse(id)).changes === 1;
  }
}

export function createConfigurationRepositories(database: Database) {
  return {
    householdMembers: new HouseholdMemberRepository(database),
    householdRules: new HouseholdRuleRepository(database),
    dayProfiles: new DayProfileRepository(database),
    recipeSources: new RecipeSourceRepository(database),
    pantryItems: new PantryItemRepository(database),
    preferredStores: new PreferredStoreRepository(database),
  };
}
