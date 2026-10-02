import { createHash } from "node:crypto";
import { normalizeMeasuredQuantity } from "./ingredients";
import type { WeeklyPlan } from "../infrastructure/plan-repository";
import type { Recipe, RecipeIngredient } from "../infrastructure/recipe-repository";
import type { Day, PlannerPantryItem, VerifiedPrepLink } from "./planner";

export type ShoppingContribution = {
  mealId: string; recipeId: string; recipeTitle: string; sourceUrl: string;
  day: Day; date: string; rawText: string; quantity: number | null; unit: string | null;
  preparedDeduction: number; kind: "recipe" | "prep";
};
export type ShoppingIngredient = {
  key: string; normalizedIngredient: string | null; unit: string | null;
  requiredQuantity: number | null; pantryDeduction: number; preparedDeduction: number;
  purchaseQuantity: number | null; contributions: ShoppingContribution[]; warnings: string[];
};
export type ShoppingAggregationInput = {
  plan: WeeklyPlan; recipes: readonly Recipe[]; pantry: readonly PlannerPantryItem[];
  producingLinks?: readonly VerifiedPrepLink[];
  incomingLinks?: readonly { link: VerifiedPrepLink; producerMealId: string; producerDate: string }[];
};
function keyFor(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
function normalized(value: string): string {
  return value.normalize("NFKC").trim().replace(/\s+/gu, " ").toLocaleLowerCase("da-DK");
}
function measured(quantity: number, unit: string): { quantity: number; unit: string } {
  checked(quantity, "measured quantity", true);
  const conversion = normalizeMeasuredQuantity(`1 ${normalized(unit)}`);
  return { quantity: checked(quantity * (conversion?.quantity ?? 1), "converted quantity", true), unit: conversion?.unit ?? normalized(unit) };
}
function checked(value: number, label: string, positive = false): number {
  if (!Number.isFinite(value) || value < 0 || (positive && value === 0) || value > Number.MAX_SAFE_INTEGER) {
    throw new RangeError(`${label}: invalid quantity or numeric overflow`);
  }
  return value;
}
function close(a: number, b: number, scale = 0): boolean {
  return Math.abs(a - b) <= Number.EPSILON * 8 * Math.max(Math.abs(a), Math.abs(b), scale, Number.MIN_VALUE);
}
function difference(a: number, b: number): number {
  return close(a, b) ? 0 : checked(a - b, "net quantity");
}
function compareContributions(a: ShoppingContribution, b: ShoppingContribution): number {
  return a.date.localeCompare(b.date) || a.mealId.localeCompare(b.mealId)
    || a.kind.localeCompare(b.kind) || a.recipeId.localeCompare(b.recipeId) || a.rawText.localeCompare(b.rawText)
    || (a.quantity ?? -1) - (b.quantity ?? -1);
}
function ingredientIdentity(ingredient: RecipeIngredient): string {
  return JSON.stringify([ingredient.rawText, ingredient.normalizedName, ingredient.unit, ingredient.quantity, ingredient.uncertain]);
}
function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/u.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value;
}
function linkIdentity(link: VerifiedPrepLink): string {
  return JSON.stringify([link.id, link.sourceRecipeId, link.targetMealId, link.targetDate, link.kind,
    link.normalizedIngredient, link.quantity, link.unit, link.note]);
}
function uniqueLinks<T>(values: readonly T[], linkOf: (value: T) => VerifiedPrepLink, identityOf: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) {
    const id = linkOf(value).id;
    const previous = unique.get(id);
    if (previous && identityOf(previous) !== identityOf(value)) throw new Error(`Conflicting duplicate prep link ${id}`);
    unique.set(id, value);
  }
  return [...unique.values()].sort((a, b) => linkOf(a).id.localeCompare(linkOf(b).id));
}
export function aggregateShoppingIngredients(input: ShoppingAggregationInput): { items: ShoppingIngredient[]; warnings: string[] } {
  const warnings = new Set<string>();
  const items = new Map<string, ShoppingIngredient>();
  const recipes = new Map<string, Recipe>();
  for (const recipe of input.recipes) {
    if (recipes.has(recipe.id)) throw new Error(`Ambiguous duplicate recipe ${recipe.id}`);
    recipes.set(recipe.id, recipe);
  }
  for (const meal of [...input.plan.meals].sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id))) {
    const recipe = recipes.get(meal.recipeId);
    if (!recipe) throw new Error(`Missing recipe ${meal.recipeId} for ${meal.id}`);
    const occurrences = new Map<string, number>();
    for (const ingredient of [...recipe.ingredients].sort((a, b) => ingredientIdentity(a).localeCompare(ingredientIdentity(b)))) {
      const identity = ingredientIdentity(ingredient);
      const occurrence = occurrences.get(identity) ?? 0;
      occurrences.set(identity, occurrence + 1);
      const unknownServings = recipe.servings === null || !Number.isFinite(recipe.servings) || recipe.servings <= 0
        || !Number.isFinite(meal.servings) || meal.servings <= 0;
      if (unknownServings || ingredient.uncertain || ingredient.quantity === null || ingredient.unit === null || ingredient.normalizedName === null) {
        const warning = `${recipe.title}: ${unknownServings ? "servings are unknown" : "uncertain ingredient quantity"}: ${ingredient.rawText}`;
        warnings.add(warning);
        const key = keyFor(JSON.stringify(["uncertain", meal.id, recipe.id, identity, occurrence]));
        items.set(key, { key, normalizedIngredient: ingredient.normalizedName === null ? null : normalized(ingredient.normalizedName),
          unit: ingredient.unit === null ? null : normalized(ingredient.unit), requiredQuantity: null,
          pantryDeduction: 0, preparedDeduction: 0, purchaseQuantity: null, warnings: [warning],
          contributions: [{ mealId: meal.id, recipeId: recipe.id, recipeTitle: recipe.title, sourceUrl: recipe.sourceUrl,
            day: meal.day, date: meal.date, rawText: ingredient.rawText, quantity: null,
            unit: ingredient.unit === null ? null : normalized(ingredient.unit), preparedDeduction: 0, kind: "recipe" }] });
        continue;
      }
      const { quantity, unit } = measured(ingredient.quantity! * meal.servings / recipe.servings!, ingredient.unit!);
      const name = normalized(ingredient.normalizedName!);
      const key = keyFor(JSON.stringify([name, unit]));
      const item = items.get(key) ?? { key, normalizedIngredient: name, unit,
        requiredQuantity: 0, pantryDeduction: 0, preparedDeduction: 0, purchaseQuantity: 0, contributions: [], warnings: [] };
      item.requiredQuantity = checked(item.requiredQuantity! + quantity, "aggregate quantity");
      item.purchaseQuantity = item.requiredQuantity;
      item.contributions.push({ mealId: meal.id, recipeId: recipe.id, recipeTitle: recipe.title, sourceUrl: recipe.sourceUrl,
        day: meal.day, date: meal.date, rawText: ingredient.rawText, quantity, unit, preparedDeduction: 0, kind: "recipe" });
      items.set(key, item);
    }
  }
  for (const link of uniqueLinks(input.producingLinks ?? [], (link) => link, linkIdentity)) {
    if (link.kind !== "prep") continue;
    const sources = input.plan.meals.filter((meal) => meal.day === "sun" && meal.recipeId === link.sourceRecipeId && meal.prepLinks.includes(link.id));
    if (sources.length !== 1 || !validDate(sources[0]!.date) || !validDate(link.targetDate) || sources[0]!.date >= link.targetDate) {
      warnings.add(`Prep link ${link.id}: no unique earlier saved Sunday producer`); continue;
    }
    const meal = sources[0]!;
    const recipe = recipes.get(meal.recipeId)!;
    const name = normalized(link.normalizedIngredient);
    const { quantity, unit } = measured(link.quantity, link.unit);
    const key = keyFor(JSON.stringify([name, unit]));
    const item = items.get(key) ?? { key, normalizedIngredient: name, unit, requiredQuantity: 0,
      pantryDeduction: 0, preparedDeduction: 0, purchaseQuantity: 0, contributions: [], warnings: [] };
    item.requiredQuantity = checked(item.requiredQuantity! + quantity, "prep aggregate quantity");
    item.contributions.push({ mealId: meal.id, recipeId: recipe.id, recipeTitle: recipe.title, sourceUrl: recipe.sourceUrl,
      day: meal.day, date: meal.date, rawText: link.note, quantity, unit, preparedDeduction: 0, kind: "prep" });
    items.set(key, item);
  }
  for (const item of items.values()) item.contributions.sort(compareContributions);
  for (const incoming of uniqueLinks(input.incomingLinks ?? [], (value) => value.link,
    (value) => JSON.stringify([linkIdentity(value.link), value.producerMealId, value.producerDate]))) {
    const { link, producerMealId, producerDate } = incoming;

    const target = input.plan.meals.find((meal) => meal.id === link.targetMealId && meal.date === link.targetDate);
    if (!target || producerMealId === target.id || !producerMealId || !validDate(producerDate) || !validDate(target.date) || producerDate >= target.date) {
      warnings.add(`Incoming link ${link.id}: no matching target with an earlier bound producer`); continue;
    }
    const name = normalized(link.normalizedIngredient);
    const amount = measured(link.quantity, link.unit);
    const item = items.get(keyFor(JSON.stringify([name, amount.unit])));
    let remaining = amount.quantity;
    if (item && item.requiredQuantity !== null) {
      for (const contribution of item.contributions) {
        if (contribution.mealId !== target.id || contribution.date !== target.date || contribution.kind !== "recipe" || contribution.quantity === null) continue;
        const used = Math.min(remaining, contribution.quantity - contribution.preparedDeduction);
        contribution.preparedDeduction += used;
        item.preparedDeduction += used;
        remaining -= used;
      }
    }
    if (remaining > 0) {
      const warning = `Incoming link ${link.id}: excess or incompatible quantity capped at matching target demand`;
      warnings.add(warning);
      if (item) item.warnings.push(warning);
    }
  }
  const pantry = new Map<string, number>();
  for (const entry of [...input.pantry].sort((a, b) => a.normalizedName.localeCompare(b.normalizedName) || a.quantity.localeCompare(b.quantity))) {
    const name = normalized(entry.normalizedName);
    const amount = normalizeMeasuredQuantity(entry.quantity);
    if (!amount) {
      const warning = `Ambiguous pantry quantity for ${name}: ${entry.quantity}`;
      warnings.add(warning);
      for (const item of items.values()) if (item.normalizedIngredient === name) item.warnings.push(warning);
      continue;
    }
    const key = keyFor(JSON.stringify([name, amount.unit]));
    pantry.set(key, checked((pantry.get(key) ?? 0) + amount.quantity, "pantry aggregate quantity"));
  }
  for (const item of items.values()) {
    item.warnings = [...new Set(item.warnings)].sort();
    if (item.requiredQuantity === null) continue;
    const net = difference(item.requiredQuantity, item.preparedDeduction);
    item.pantryDeduction = Math.min(net, pantry.get(item.key) ?? 0);
    item.purchaseQuantity = difference(net, item.pantryDeduction);
    item.contributions.sort(compareContributions);
  }
  return { items: [...items.values()].sort((a, b) => a.key.localeCompare(b.key)), warnings: [...warnings].sort() };
}

export type PackageReuse = {
  packageCount: number; purchasedQuantity: number; remainder: number;
  uses: Array<{ fromMealId: string; toMealId: string; quantity: number; unit: string }>;
};
/** Arithmetic package reuse only; this makes no storage or food-safety claim. */
export function calculatePackageReuse(item: ShoppingIngredient, packageQuantity: number): PackageReuse {
  checked(packageQuantity, "package quantity", true);
  if (item.requiredQuantity === null || item.purchaseQuantity === null || item.unit === null) {
    throw new RangeError("Cannot calculate packages for unknown quantity or unit");
  }
  checked(item.requiredQuantity, "required quantity");
  checked(item.purchaseQuantity, "purchase quantity");
  checked(item.pantryDeduction, "pantry deduction");
  checked(item.preparedDeduction, "prepared deduction");
  const expectedPurchase = difference(difference(item.requiredQuantity, item.preparedDeduction), item.pantryDeduction);
  if (!close(expectedPurchase, item.purchaseQuantity, item.requiredQuantity)) {
    throw new RangeError("Inconsistent purchase quantity and total deductions");
  }
  const demands = new Map<string, { mealId: string; date: string; quantity: number; prepared: number; unknown: boolean }>();
  for (const contribution of [...item.contributions].sort(compareContributions)) {
    if (!validDate(contribution.date)) throw new RangeError("Invalid contribution date");
    if (contribution.unit !== null && normalized(contribution.unit) !== normalized(item.unit)) {
      throw new RangeError("Incompatible contribution unit");
    }
    if (contribution.quantity !== null) checked(contribution.quantity, "contribution quantity");
    checked(contribution.preparedDeduction, "contribution prepared deduction");
    if (contribution.quantity !== null && contribution.preparedDeduction > contribution.quantity) {
      throw new RangeError("Prepared deduction exceeds contribution quantity");
    }
    const key = JSON.stringify([contribution.date, contribution.mealId]);
    const demand = demands.get(key) ?? { mealId: contribution.mealId, date: contribution.date, quantity: 0, prepared: 0, unknown: false };
    demand.quantity = checked(demand.quantity + (contribution.quantity ?? 0), "meal quantity");
    demand.prepared = checked(demand.prepared + contribution.preparedDeduction, "meal prepared deduction");
    demand.unknown ||= contribution.quantity === null;
    demands.set(key, demand);
  }
  const unknown = [...demands.values()].filter((demand) => demand.unknown);
  if (unknown.length > 0) throw new RangeError("Cannot trace unknown contribution quantities without inventing demand");
  for (const demand of demands.values()) demand.quantity = difference(demand.quantity, demand.prepared);
  const netTotal = [...demands.values()].reduce((sum, demand) => sum + demand.quantity, 0);
  const preparedTotal = [...demands.values()].reduce((sum, demand) => sum + demand.prepared, 0);
  if (!close(preparedTotal, item.preparedDeduction, item.requiredQuantity)) throw new RangeError("Inconsistent prepared deductions");
  if (!close(netTotal - item.pantryDeduction, item.purchaseQuantity, item.requiredQuantity)) throw new RangeError("Inconsistent purchase quantity and contribution deductions");
  let pantry = item.pantryDeduction;
  let available = 0;
  let fromMealId = "";
  let packageCount = 0;
  const uses: PackageReuse["uses"] = [];
  for (const demand of demands.values()) {
    const pantryUsed = Math.min(pantry, demand.quantity);
    pantry = difference(pantry, pantryUsed);
    let needed = difference(demand.quantity, pantryUsed);
    const reused = Math.min(available, needed);
    if (reused > 0 && fromMealId !== demand.mealId) uses.push({ fromMealId, toMealId: demand.mealId, quantity: reused, unit: item.unit! });
    available = difference(available, reused);
    needed = difference(needed, reused);
    if (needed > 0) {
      const ratio = checked(needed / packageQuantity, "package count");
      const nearest = Math.round(ratio);
      const opened = nearest > 0 && close(ratio, nearest) ? nearest : Math.ceil(ratio);
      packageCount = checked(packageCount + opened, "package count");
      const purchased = checked(opened * packageQuantity, "purchased quantity");
      available = close(purchased, needed) ? 0 : checked(purchased - needed, "package remainder");
      fromMealId = demand.mealId;
    }
  }
  return { packageCount, purchasedQuantity: checked(packageCount * packageQuantity, "purchased quantity"), remainder: available, uses };
}
