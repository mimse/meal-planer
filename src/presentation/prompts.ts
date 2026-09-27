import * as clack from "@clack/prompts";
import type { FamilyConfiguration, FamilyEdit } from "../commands/family";
import type { PantryPromptAdapter } from "../commands/pantry-workflow";
import { DEFAULT_STORE_NAMES, type SetupAnswers } from "../commands/setup";
import { MAX_HOUSEHOLD_MEMBERS, MAX_PANTRY_ITEMS_PER_OPERATION } from "../domain/configuration";
import type {
  HouseholdMember,
  HouseholdRuleInput,
  PantryItem,
  PantryItemInput,
} from "../infrastructure/configuration-repositories";
import {
  getDraftMembers,
  getDraftRules,
  getFamilyEditActionOptions,
  getRuleUpdateTargets,
  removeMemberDraft,
  removeRuleDraft,
  upsertMemberDraft,
  updateRuleDraft,
} from "./family-edit-draft";

export const CANCELLED = Symbol("cancelled");
export type Cancelled = typeof CANCELLED;

export interface PromptAdapter {
  collectSetup(): Promise<SetupAnswers | Cancelled>;
  collectFamilyEdit(current: FamilyConfiguration): Promise<FamilyEdit | Cancelled>;
}

function cancelled<T>(value: T | symbol): value is symbol {
  return clack.isCancel(value);
}

type RequiredTextPromptOptions = {
  readonly message: string;
  readonly initialValue?: string;
  readonly validate: (candidate: string | undefined) => string | undefined;
};

export function createRequiredTextPromptOptions(
  message: string,
  initialValue?: string,
): RequiredTextPromptOptions {
  return {
    message,
    ...(initialValue === undefined ? {} : { initialValue }),
    validate: (candidate) => candidate === undefined || candidate.trim().length === 0
      ? "A value is required"
      : undefined,
  };
}

async function requiredText(message: string, initialValue?: string): Promise<string | Cancelled> {
  const value = await clack.text(createRequiredTextPromptOptions(message, initialValue));
  return cancelled(value) ? CANCELLED : value;
}

export { MAX_HOUSEHOLD_MEMBERS } from "../domain/configuration";

export function validateHouseholdMemberCount(value: string | undefined): string | undefined {
  if (value !== undefined && /^\d+$/.test(value)) {
    const count = Number(value);
    if (Number.isSafeInteger(count) && count >= 1 && count <= MAX_HOUSEHOLD_MEMBERS) {
      return undefined;
    }
  }
  return `Enter a whole number from 1 to ${MAX_HOUSEHOLD_MEMBERS}`;
}

async function collectRules(kind: HouseholdRuleInput["kind"]): Promise<HouseholdRuleInput[] | Cancelled> {
  const rules: HouseholdRuleInput[] = [];
  while (true) {
    const add = await clack.confirm({
      message: rules.length === 0
        ? `Add a household ${kind === "dietary_restriction" ? "dietary restriction" : "disliked ingredient"}?`
        : "Add another?",
      initialValue: false,
    });
    if (cancelled(add)) return CANCELLED;
    if (!add) return rules;
    const value = await requiredText(kind === "dietary_restriction" ? "Restriction" : "Disliked ingredient");
    if (value === CANCELLED) return CANCELLED;
    rules.push({ memberId: null, kind, value });
  }
}

export class ClackPromptAdapter implements PromptAdapter, PantryPromptAdapter {
  async collectPantryItems(): Promise<readonly PantryItemInput[] | Cancelled> {
    const items: PantryItemInput[] = [];
    while (true) {
      const name = await requiredText("Pantry item name");
      if (name === CANCELLED) return CANCELLED;
      const quantity = await requiredText("Pantry quantity");
      if (quantity === CANCELLED) return CANCELLED;
      items.push({ name, quantity });
      if (items.length === MAX_PANTRY_ITEMS_PER_OPERATION) return items;
      const addAnother = await clack.confirm({ message: "Add another pantry item?", initialValue: false });
      if (cancelled(addAnother)) return CANCELLED;
      if (!addAnother) return items;
    }
  }

  async collectPantryNames(current: readonly PantryItem[]): Promise<readonly string[] | Cancelled> {
    if (current.length === 0) throw new Error("Pantry is empty");
    const names = await clack.multiselect({
      message: "Pantry items to remove",
      options: current.map((item) => ({ value: item.name, label: `${item.name}: ${item.quantity}` })),
      required: true,
    });
    return cancelled(names) ? CANCELLED : names;
  }

  async collectSetup(): Promise<SetupAnswers | Cancelled> {
    clack.intro("Mealplan setup");
    const countValue = await clack.text({
      message: "Number of household members",
      initialValue: "1",
      validate: validateHouseholdMemberCount,
    });
    if (cancelled(countValue)) return CANCELLED;

    const members: HouseholdMember[] = [];
    for (let index = 0; index < Number(countValue); index += 1) {
      const name = await requiredText(`Member ${index + 1} name`);
      if (name === CANCELLED) return CANCELLED;
      const defaultId = name.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase()
        .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      const id = await requiredText(`Member ${index + 1} id`, defaultId);
      if (id === CANCELLED) return CANCELLED;
      const kind = await clack.select({
        message: `Member ${index + 1} type`,
        options: [
          { value: "adult" as const, label: "Adult" },
          { value: "child" as const, label: "Child" },
        ],
        initialValue: "adult" as const,
      });
      if (cancelled(kind)) return CANCELLED;
      const servingsValue = await clack.text({
        message: `Member ${index + 1} serving weight`,
        initialValue: kind === "child" ? "0.75" : "1",
        validate: (value) => Number.isFinite(Number(value)) && Number(value) > 0 ? undefined : "Enter a positive number",
      });
      if (cancelled(servingsValue)) return CANCELLED;
      members.push({ id, name, kind, servings: Number(servingsValue) });
    }

    const restrictions = await collectRules("dietary_restriction");
    if (restrictions === CANCELLED) return CANCELLED;
    const dislikes = await collectRules("disliked_ingredient");
    if (dislikes === CANCELLED) return CANCELLED;
    const addPantry = await clack.confirm({ message: "Add pantry staples?", initialValue: false });
    if (cancelled(addPantry)) return CANCELLED;
    let pantryItems: readonly PantryItemInput[] = [];
    if (addPantry) {
      const collectedPantryItems = await this.collectPantryItems();
      if (collectedPantryItems === CANCELLED) return CANCELLED;
      pantryItems = collectedPantryItems;
    }
    const stores = await clack.multiselect({
      message: "Preferred stores",
      options: DEFAULT_STORE_NAMES.map((name) => ({ value: name, label: name })),
      initialValues: [...DEFAULT_STORE_NAMES],
      required: true,
    });
    if (cancelled(stores)) return CANCELLED;

    return {
      members,
      rules: [...restrictions, ...dislikes],
      pantryItems,
      preferredStoreNames: stores,
    };
  }

  async collectFamilyEdit(current: FamilyConfiguration): Promise<FamilyEdit | Cancelled> {
    let edit: FamilyEdit = {
      upsertMembers: [], removeMemberIds: [], upsertRules: [], replaceRules: [], removeRuleIds: [],
    };
    while (true) {
      const action = await clack.select({
        message: "Family edit action",
        options: getFamilyEditActionOptions(current, edit),
      });
      if (cancelled(action)) return CANCELLED;
      if (action === "done") return edit;

      if (action === "upsert-member") {
        const id = await requiredText("Member id");
        if (id === CANCELLED) return CANCELLED;
        const existing = [...edit.upsertMembers, ...current.members].find((member) => member.id === id);
        const name = await requiredText("Member name", existing?.name);
        if (name === CANCELLED) return CANCELLED;
        const kind = await clack.select({
          message: "Member type",
          options: [{ value: "adult" as const, label: "Adult" }, { value: "child" as const, label: "Child" }],
          initialValue: existing?.kind ?? "adult",
        });
        if (cancelled(kind)) return CANCELLED;
        const servings = await clack.text({
          message: "Serving weight",
          initialValue: String(existing?.servings ?? (kind === "child" ? 0.75 : 1)),
          validate: (value) => Number(value) > 0 ? undefined : "Enter a positive number",
        });
        if (cancelled(servings)) return CANCELLED;
        edit = upsertMemberDraft(edit, { id, name, kind, servings: Number(servings) });
        continue;
      }

      if (action === "remove-member") {
        const members = getDraftMembers(current.members, edit);
        const id = await clack.select({
          message: "Member to remove",
          options: members.map((member) => ({ value: member.id, label: `${member.name} (${member.id})` })),
        });
        if (cancelled(id)) return CANCELLED;
        edit = removeMemberDraft(current.members, edit, id);
        continue;
      }

      if (action === "replace-rule") {
        const availableRules = getRuleUpdateTargets(current.rules, edit);
        const id = await clack.select({
          message: "Rule to update",
          options: availableRules.map((rule) => ({ value: rule.id, label: `${rule.value} (${rule.memberId ?? "household"})` })),
        });
        if (cancelled(id)) return CANCELLED;
        const existing = availableRules.find((rule) => rule.id === id)!;
        const members = getDraftMembers(current.members, edit);
        const scope = await clack.select({
          message: "Rule scope",
          options: [
            { value: "" as const, label: "Whole household" },
            ...members.map((member) => ({ value: member.id, label: member.name })),
          ],
          initialValue: existing.memberId ?? "",
        });
        if (cancelled(scope)) return CANCELLED;
        const kind = await clack.select({
          message: "Rule type",
          options: [
            { value: "dietary_restriction" as const, label: "Dietary restriction" },
            { value: "disliked_ingredient" as const, label: "Disliked ingredient" },
          ],
          initialValue: existing.kind,
        });
        if (cancelled(kind)) return CANCELLED;
        const value = await requiredText("Rule text", existing.value);
        if (value === CANCELLED) return CANCELLED;
        edit = updateRuleDraft(edit, { id, memberId: scope === "" ? null : scope, kind, value });
        continue;
      }

      if (action === "upsert-rule") {
        const members = getDraftMembers(current.members, edit);
        const scope = await clack.select({
          message: "Rule scope",
          options: [
            { value: "" as const, label: "Whole household" },
            ...members.map((member) => ({ value: member.id, label: member.name })),
          ],
        });
        if (cancelled(scope)) return CANCELLED;
        const kind = await clack.select({
          message: "Rule type",
          options: [
            { value: "dietary_restriction" as const, label: "Dietary restriction" },
            { value: "disliked_ingredient" as const, label: "Disliked ingredient" },
          ],
        });
        if (cancelled(kind)) return CANCELLED;
        const value = await requiredText("Rule text");
        if (value === CANCELLED) return CANCELLED;
        edit.upsertRules = [...edit.upsertRules, { memberId: scope === "" ? null : scope, kind, value }];
        continue;
      }

      const availableRules = getDraftRules(current.rules, edit);
      const id = await clack.select({
        message: "Rule to remove",
        options: availableRules.map((rule) => ({ value: rule.id, label: `${rule.value} (${rule.memberId ?? "household"})` })),
      });
      if (cancelled(id)) return CANCELLED;
      edit = removeRuleDraft(edit, id);
    }
  }
}
