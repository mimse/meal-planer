import { describe, expect, test } from "bun:test";
import type { FamilyEdit } from "../../src/commands/family";
import type { HouseholdMember, HouseholdRule } from "../../src/infrastructure/configuration-repositories";
import {
  getFamilyEditActionOptions,
  getDraftMembers,
  getDraftRules,
  getRuleUpdateTargets,
  removeMemberDraft,
  removeRuleDraft,
  upsertMemberDraft,
  updateRuleDraft,
} from "../../src/presentation/family-edit-draft";

function emptyEdit(): FamilyEdit {
  return {
    upsertMembers: [],
    removeMemberIds: [],
    upsertRules: [],
    replaceRules: [],
    removeRuleIds: [],
  };
}

const originalRule: HouseholdRule = {
  id: "rule-1",
  memberId: null,
  kind: "dietary_restriction",
  value: "Gluten",
};
const originalMember: HouseholdMember = {
  id: "alex",
  name: "Alex",
  kind: "adult",
  servings: 1,
};

describe("interactive family-edit draft", () => {
  test("a second rule update sees and replaces the pending replacement", () => {
    const first = updateRuleDraft(emptyEdit(), {
      id: originalRule.id,
      memberId: null,
      kind: "dietary_restriction",
      value: "Wheat",
    });

    expect(getDraftRules([originalRule], first)).toEqual([{ ...originalRule, value: "Wheat" }]);

    const second = updateRuleDraft(first, {
      id: originalRule.id,
      memberId: null,
      kind: "dietary_restriction",
      value: "Barley",
    });

    expect(second.replaceRules).toEqual([{ ...originalRule, value: "Barley" }]);
    expect(getDraftRules([originalRule], second)).toEqual([{ ...originalRule, value: "Barley" }]);
  });

  test("removing a pending rule replacement records only removal", () => {
    const updated = updateRuleDraft(emptyEdit(), { ...originalRule, value: "Wheat" });

    const removed = removeRuleDraft(updated, originalRule.id);

    expect(removed.replaceRules).toEqual([]);
    expect(removed.removeRuleIds).toEqual([originalRule.id]);
    expect(getDraftRules([originalRule], removed)).toEqual([]);
  });

  test("updating a rule pending removal cancels the removal", () => {
    const removed = removeRuleDraft(emptyEdit(), originalRule.id);

    expect(getRuleUpdateTargets([originalRule], removed)).toEqual([originalRule]);
    expect(getFamilyEditActionOptions({
      members: [originalMember],
      rules: [originalRule],
      dayProfiles: [],
      preferredStores: [],
    }, removed).map(({ value }) => value)).toContain("replace-rule");

    const updated = updateRuleDraft(removed, { ...originalRule, value: "Wheat" });

    expect(updated.removeRuleIds).toEqual([]);
    expect(updated.replaceRules).toEqual([{ ...originalRule, value: "Wheat" }]);
  });

  test("upserting a member pending removal cancels the removal", () => {
    const removed = removeMemberDraft([originalMember], emptyEdit(), originalMember.id);

    const updated = upsertMemberDraft(removed, { ...originalMember, name: "Alexandra" });

    expect(updated.removeMemberIds).toEqual([]);
    expect(getDraftMembers([originalMember], updated)).toEqual([{ ...originalMember, name: "Alexandra" }]);
  });

  test("removing a newly upserted member drops the upsert without recording a removal", () => {
    const added = upsertMemberDraft(emptyEdit(), {
      id: "sam",
      name: "Sam",
      kind: "child",
      servings: 0.75,
    });

    const removed = removeMemberDraft([originalMember], added, "sam");

    expect(removed.upsertMembers).toEqual([]);
    expect(removed.removeMemberIds).toEqual([]);
    expect(getDraftMembers([originalMember], removed)).toEqual([originalMember]);
  });

  test("removing a member drops a pending new rule scoped to that member", () => {
    const sam: HouseholdMember = {
      id: "sam",
      name: "Sam",
      kind: "adult",
      servings: 1,
    };
    const edit: FamilyEdit = {
      ...emptyEdit(),
      upsertRules: [{ memberId: sam.id, kind: "disliked_ingredient", value: "Olives" }],
    };

    const removed = removeMemberDraft([originalMember, sam], edit, sam.id);

    expect(removed.upsertRules).toEqual([]);
  });

  test("removing a member drops its pending replacement and preserves unrelated rule edits", () => {
    const sam: HouseholdMember = {
      id: "sam",
      name: "Sam",
      kind: "adult",
      servings: 1,
    };
    const householdRule = { memberId: null, kind: "dietary_restriction" as const, value: "Gluten" };
    const alexRule = { memberId: originalMember.id, kind: "disliked_ingredient" as const, value: "Fennel" };
    const edit: FamilyEdit = {
      ...emptyEdit(),
      upsertRules: [
        { memberId: sam.id, kind: "disliked_ingredient", value: "Olives" },
        householdRule,
        alexRule,
      ],
      replaceRules: [
        { id: "sam-rule", memberId: sam.id, kind: "disliked_ingredient", value: "Capers" },
        { id: "household-rule", ...householdRule },
        { id: "alex-rule", ...alexRule },
      ],
    };

    const removed = removeMemberDraft([originalMember, sam], edit, sam.id);

    expect(removed.upsertRules).toEqual([householdRule, alexRule]);
    expect(removed.replaceRules).toEqual([
      { id: "household-rule", ...householdRule },
      { id: "alex-rule", ...alexRule },
    ]);
  });

  test("actions with no available targets omit their selection actions", () => {
    const edit = removeMemberDraft([originalMember], emptyEdit(), originalMember.id);

    expect(getFamilyEditActionOptions({
      members: [originalMember],
      rules: [],
      dayProfiles: [],
      preferredStores: [],
    }, edit).map(({ value }) => value)).toEqual([
      "upsert-member",
      "upsert-rule",
      "done",
    ]);
  });
});
