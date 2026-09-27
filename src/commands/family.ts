import type { Database } from "bun:sqlite";
import { z } from "zod";
import { MAX_HOUSEHOLD_MEMBERS } from "../domain/configuration";
import {
  createConfigurationRepositories,
  createHouseholdRuleId,
  type DayProfile,
  type HouseholdMember,
  type HouseholdRule,
  type HouseholdRuleInput,
  type PreferredStore,
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

const ruleUpdateSchema = ruleSchema.extend({ id: z.string().min(1) }).strict();

const familyEditSchema = z.object({
  upsertMembers: z.array(memberSchema),
  removeMemberIds: z.array(identifierSchema),
  upsertRules: z.array(ruleSchema),
  replaceRules: z.array(ruleUpdateSchema).default([]),
  removeRuleIds: z.array(z.string().min(1)),
}).strict().superRefine((edit, context) => {
  const upsertedMemberIds = new Set<string>();
  for (const [index, member] of edit.upsertMembers.entries()) {
    if (upsertedMemberIds.has(member.id)) {
      context.addIssue({ code: "custom", message: `Duplicate member upsert: ${member.id}`, path: ["upsertMembers", index, "id"] });
    }
    upsertedMemberIds.add(member.id);
  }
  for (const [index, memberId] of edit.removeMemberIds.entries()) {
    if (upsertedMemberIds.has(memberId)) {
      context.addIssue({
        code: "custom",
        message: `Member cannot be upserted and removed in the same edit: ${memberId}`,
        path: ["removeMemberIds", index],
      });
    }
  }
  const replacedRuleIds = new Set<string>();
  for (const [index, replacement] of edit.replaceRules.entries()) {
    if (replacedRuleIds.has(replacement.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate rule replacement: ${replacement.id}`,
        path: ["replaceRules", index, "id"],
      });
    }
    replacedRuleIds.add(replacement.id);
  }
  for (const [index, ruleId] of edit.removeRuleIds.entries()) {
    if (replacedRuleIds.has(ruleId)) {
      context.addIssue({
        code: "custom",
        message: `Rule cannot be replaced and removed in the same edit: ${ruleId}`,
        path: ["removeRuleIds", index],
      });
    }
  }
});

export type FamilyEdit = z.input<typeof familyEditSchema>;
type ValidatedFamilyEdit = z.output<typeof familyEditSchema>;
export type FamilyConfiguration = {
  readonly members: HouseholdMember[];
  readonly rules: HouseholdRule[];
  readonly dayProfiles: DayProfile[];
  readonly preferredStores: PreferredStore[];
};

export function validateFamilyEdit(input: unknown): ValidatedFamilyEdit {
  return familyEditSchema.parse(input);
}

export function readFamilyConfiguration(database: Database): FamilyConfiguration {
  const repositories = createConfigurationRepositories(database);
  const configuration = {
    members: repositories.householdMembers.list(),
    rules: repositories.householdRules.list(),
    dayProfiles: repositories.dayProfiles.list(),
    preferredStores: repositories.preferredStores.list(),
  };
  if (
    configuration.members.length === 0
    || configuration.dayProfiles.length !== 7
    || configuration.preferredStores.length === 0
  ) {
    throw new Error("Family configuration is incomplete. Run mealplan setup first.");
  }
  return configuration;
}

export function applyFamilyEdit(database: Database, input: FamilyEdit): void {
  const edit = validateFamilyEdit(input);
  const repositories = createConfigurationRepositories(database);

  database.transaction(() => {
    const existingRules = repositories.householdRules.list();
    const finalMemberIds = new Set(repositories.householdMembers.list().map(({ id }) => id));
    for (const memberId of edit.removeMemberIds) finalMemberIds.delete(memberId);
    for (const member of edit.upsertMembers) finalMemberIds.add(member.id);
    if (finalMemberIds.size === 0) {
      throw new Error("Family must contain at least one member");
    }
    if (finalMemberIds.size > MAX_HOUSEHOLD_MEMBERS) {
      throw new Error(`Family cannot contain more than ${MAX_HOUSEHOLD_MEMBERS} members`);
    }
    for (const rule of [...edit.upsertRules, ...edit.replaceRules]) {
      if (rule.memberId !== null && !finalMemberIds.has(rule.memberId)) {
        throw new Error(`Rule references unknown member: ${rule.memberId}`);
      }
    }
    const existingRuleIds = new Set(existingRules.map(({ id }) => id));
    for (const replacement of edit.replaceRules) {
      if (!existingRuleIds.has(replacement.id)) {
        throw new Error(`Household rule does not exist: ${replacement.id}`);
      }
    }

    const replacedRuleIds = new Set(edit.replaceRules.map(({ id }) => id));
    const removedRuleIds = new Set(edit.removeRuleIds);
    const survivingRuleIds = new Set(existingRules
      .filter((rule) => !replacedRuleIds.has(rule.id))
      .filter((rule) => !removedRuleIds.has(rule.id))
      .filter((rule) => rule.memberId === null || !edit.removeMemberIds.includes(rule.memberId))
      .map(({ id }) => id));
    const replacementIds = new Set<string>();
    for (const { id: sourceId, ...replacement } of edit.replaceRules) {
      const replacementId = createHouseholdRuleId(replacement);
      if (survivingRuleIds.has(replacementId)) {
        throw new Error(
          `Replacement rule identity conflicts with an existing rule: ${sourceId} -> ${replacementId}`,
        );
      }
      if (replacementIds.has(replacementId)) {
        throw new Error(`Replacement rules have the same final identity: ${replacementId}`);
      }
      replacementIds.add(replacementId);
    }
    for (const rule of edit.upsertRules) {
      const ruleId = createHouseholdRuleId(rule);
      if (replacedRuleIds.has(ruleId) || replacementIds.has(ruleId)) {
        throw new Error(`Rule upsert conflicts with a replacement operation: ${ruleId}`);
      }
    }

    for (const ruleId of edit.removeRuleIds) repositories.householdRules.remove(ruleId);
    for (const replacement of edit.replaceRules) repositories.householdRules.remove(replacement.id);
    for (const memberId of edit.removeMemberIds) repositories.householdMembers.remove(memberId);
    for (const member of edit.upsertMembers) repositories.householdMembers.upsert(member);
    for (const { id: _, ...rule } of edit.replaceRules) repositories.householdRules.upsert(rule);
    for (const rule of edit.upsertRules as HouseholdRuleInput[]) repositories.householdRules.upsert(rule);
  }).immediate();
}
