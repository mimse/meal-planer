import type { FamilyConfiguration, FamilyEdit } from "../commands/family";
import type { HouseholdMember, HouseholdRule } from "../infrastructure/configuration-repositories";

type RuleReplacement = NonNullable<FamilyEdit["replaceRules"]>[number];
export type FamilyEditAction = "upsert-member" | "remove-member" | "upsert-rule"
  | "replace-rule" | "remove-rule" | "done";
export type FamilyEditActionOption = { readonly value: FamilyEditAction; readonly label: string };

export function getFamilyEditActionOptions(
  current: FamilyConfiguration,
  edit: FamilyEdit,
): FamilyEditActionOption[] {
  const members = getDraftMembers(current.members, edit);
  const rules = getDraftRules(current.rules, edit);
  const ruleUpdateTargets = getRuleUpdateTargets(current.rules, edit);
  return [
    { value: "upsert-member", label: "Add or update a member" },
    ...(members.length === 0 ? [] : [{ value: "remove-member" as const, label: "Remove a member" }]),
    { value: "upsert-rule", label: "Add a rule" },
    ...(ruleUpdateTargets.length === 0
      ? []
      : [{ value: "replace-rule" as const, label: "Update a rule" }]),
    ...(rules.length === 0 ? [] : [{ value: "remove-rule" as const, label: "Remove a rule" }]),
    { value: "done", label: "Save changes" },
  ];
}

export function getDraftMembers(
  currentMembers: readonly HouseholdMember[],
  edit: FamilyEdit,
): HouseholdMember[] {
  const upserts = new Map(edit.upsertMembers.map((member) => [member.id, member]));
  const removed = new Set(edit.removeMemberIds);
  const currentIds = new Set(currentMembers.map(({ id }) => id));
  return [
    ...currentMembers.map((member) => upserts.get(member.id) ?? member),
    ...edit.upsertMembers.filter(({ id }) => !currentIds.has(id)),
  ].filter(({ id }) => !removed.has(id));
}

export function upsertMemberDraft(edit: FamilyEdit, member: HouseholdMember): FamilyEdit {
  return {
    ...edit,
    upsertMembers: [...edit.upsertMembers.filter(({ id }) => id !== member.id), member],
    removeMemberIds: edit.removeMemberIds.filter((id) => id !== member.id),
  };
}

export function removeMemberDraft(
  currentMembers: readonly HouseholdMember[],
  edit: FamilyEdit,
  memberId: string,
): FamilyEdit {
  const existedBeforeEdit = currentMembers.some(({ id }) => id === memberId);
  return {
    ...edit,
    upsertMembers: edit.upsertMembers.filter(({ id }) => id !== memberId),
    removeMemberIds: existedBeforeEdit
      ? [...edit.removeMemberIds.filter((id) => id !== memberId), memberId]
      : edit.removeMemberIds.filter((id) => id !== memberId),
    upsertRules: edit.upsertRules.filter((rule) => rule.memberId !== memberId),
    replaceRules: (edit.replaceRules ?? []).filter((rule) => rule.memberId !== memberId),
  };
}

export function getDraftRules(
  currentRules: readonly HouseholdRule[],
  edit: FamilyEdit,
): HouseholdRule[] {
  const removed = new Set(edit.removeRuleIds);
  return getRuleUpdateTargets(currentRules, edit).filter(({ id }) => !removed.has(id));
}

export function getRuleUpdateTargets(
  currentRules: readonly HouseholdRule[],
  edit: FamilyEdit,
): HouseholdRule[] {
  const replacements = new Map((edit.replaceRules ?? []).map((rule) => [rule.id, rule]));
  return currentRules.map((rule) => replacements.get(rule.id) ?? rule);
}

export function updateRuleDraft(edit: FamilyEdit, replacement: RuleReplacement): FamilyEdit {
  return {
    ...edit,
    replaceRules: [
      ...(edit.replaceRules ?? []).filter(({ id }) => id !== replacement.id),
      replacement,
    ],
    removeRuleIds: edit.removeRuleIds.filter((id) => id !== replacement.id),
  };
}

export function removeRuleDraft(edit: FamilyEdit, ruleId: string): FamilyEdit {
  return {
    ...edit,
    replaceRules: (edit.replaceRules ?? []).filter(({ id }) => id !== ruleId),
    removeRuleIds: [...edit.removeRuleIds.filter((id) => id !== ruleId), ruleId],
  };
}
