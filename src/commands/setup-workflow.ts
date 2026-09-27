import { openApplicationDatabase } from "../infrastructure/database";
import { CANCELLED, type PromptAdapter } from "../presentation/prompts";
import { applySetup, createSetupConfiguration, type SetupAnswers } from "./setup";

export type SetupWorkflowOptions = {
  readonly databasePath: string;
  readonly prompts: PromptAdapter;
  readonly answers?: SetupAnswers;
};

export async function runSetupWorkflow(options: SetupWorkflowOptions): Promise<"saved" | "cancelled"> {
  const answers = options.answers ?? await options.prompts.collectSetup();
  if (answers === CANCELLED) return "cancelled";

  const configuration = createSetupConfiguration(answers);
  const database = await openApplicationDatabase(options.databasePath);
  try {
    applySetup(database, configuration);
  } finally {
    database.close();
  }
  return "saved";
}
