import { openExistingDatabase } from "../infrastructure/database";
import type { PantryItem, PantryItemInput } from "../infrastructure/configuration-repositories";
import { CANCELLED, type Cancelled } from "../presentation/prompts";
import {
  applyPantryRemovals,
  applyPantryUpserts,
  readPantry,
  validatePantryItems,
  validatePantryNames,
} from "./pantry";

export interface PantryPromptAdapter {
  collectPantryItems(): Promise<readonly PantryItemInput[] | Cancelled>;
  collectPantryNames(current: readonly PantryItem[]): Promise<readonly string[] | Cancelled>;
}

type PantryWorkflowOptions = {
  readonly databasePath: string;
  readonly prompts: PantryPromptAdapter;
};

export async function runPantryAddWorkflow(
  options: PantryWorkflowOptions & { readonly items?: unknown },
): Promise<"saved" | "cancelled"> {
  const answers = options.items === undefined ? await options.prompts.collectPantryItems() : options.items;
  if (answers === CANCELLED) return "cancelled";
  const items = validatePantryItems(answers);
  const database = openExistingDatabase(options.databasePath);
  try {
    applyPantryUpserts(database, items);
    return "saved";
  } finally {
    database.close();
  }
}

export async function runPantryRemoveWorkflow(
  options: PantryWorkflowOptions & { readonly names?: unknown },
): Promise<"saved" | "cancelled"> {
  if (options.names !== undefined) {
    const names = validatePantryNames(options.names);
    const database = openExistingDatabase(options.databasePath);
    try {
      applyPantryRemovals(database, names);
      return "saved";
    } finally {
      database.close();
    }
  }

  const database = openExistingDatabase(options.databasePath);
  try {
    const answers = await options.prompts.collectPantryNames(readPantry(database));
    if (answers === CANCELLED) return "cancelled";
    applyPantryRemovals(database, validatePantryNames(answers));
    return "saved";
  } finally {
    database.close();
  }
}
