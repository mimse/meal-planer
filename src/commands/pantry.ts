import type { Database } from "bun:sqlite";
import { z } from "zod";
import { MAX_PANTRY_ITEMS_PER_OPERATION } from "../domain/configuration";
import {
  createConfigurationRepositories,
  type PantryItem,
  type PantryItemInput,
} from "../infrastructure/configuration-repositories";

const pantryItemInputSchema = z.object({
  name: z.string().trim().min(1).max(200).refine(
    (name) => name.normalize("NFKC").trim().replace(/\s+/g, " ").length <= 200,
    "Normalized pantry name is too long",
  ),
  quantity: z.string().max(500).refine(
    (quantity) => quantity.trim().length > 0,
    "Pantry quantity cannot be empty",
  ),
}).strict();

const pantryItemsSchema = z.array(pantryItemInputSchema).min(1).max(MAX_PANTRY_ITEMS_PER_OPERATION);
const pantryNameSchema = z.string().trim().min(1).max(200).refine(
  (name) => name.normalize("NFKC").trim().replace(/\s+/g, " ").length <= 200,
  "Normalized pantry name is too long",
);
const pantryNamesSchema = z.array(pantryNameSchema).min(1).max(MAX_PANTRY_ITEMS_PER_OPERATION);

export function validatePantryItems(input: unknown): PantryItemInput[] {
  return pantryItemsSchema.parse(input);
}

export function validatePantryNames(input: unknown): string[] {
  return pantryNamesSchema.parse(input);
}

export function readPantry(database: Database): PantryItem[] {
  return createConfigurationRepositories(database).pantryItems.list().map((item) => ({
    normalizedName: item.normalizedName,
    name: item.name,
    quantity: item.quantity,
  }));
}

export function applyPantryUpserts(database: Database, input: unknown): PantryItem[] {
  const items = validatePantryItems(input);
  const pantry = createConfigurationRepositories(database).pantryItems;
  return database.transaction(() => items.map((item) => pantry.upsert(item))).immediate();
}

export function applyPantryRemovals(database: Database, input: unknown): void {
  const names = validatePantryNames(input);
  const pantry = createConfigurationRepositories(database).pantryItems;
  database.transaction(() => {
    for (const name of names) {
      if (pantry.get(name) === null) throw new Error(`Pantry item does not exist: ${name}`);
    }
    for (const name of names) pantry.remove(name);
  }).immediate();
}
