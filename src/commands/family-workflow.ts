import { openExistingDatabase } from "../infrastructure/database";
import { CANCELLED, type PromptAdapter } from "../presentation/prompts";
import { applyFamilyEdit, readFamilyConfiguration, validateFamilyEdit, type FamilyEdit } from "./family";

export type FamilyEditWorkflowOptions = {
  readonly databasePath: string;
  readonly prompts: PromptAdapter;
  readonly edit?: FamilyEdit;
};

export async function runFamilyEditWorkflow(
  options: FamilyEditWorkflowOptions,
): Promise<"saved" | "cancelled"> {
  const providedEdit = options.edit === undefined ? undefined : validateFamilyEdit(options.edit);
  const database = openExistingDatabase(options.databasePath);
  try {
    const current = readFamilyConfiguration(database);
    const edit = providedEdit ?? await options.prompts.collectFamilyEdit(current);
    if (edit === CANCELLED) return "cancelled";
    applyFamilyEdit(database, edit);
    return "saved";
  } finally {
    database.close();
  }
}
