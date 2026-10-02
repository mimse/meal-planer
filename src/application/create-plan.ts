import type { Database } from "bun:sqlite";
import { z } from "zod";
import { readFamilyConfiguration } from "../commands/family";
import { readPantry } from "../commands/pantry";
import {
  generateWeeklyPlan,
  type DealSignal,
  type PackageEstimate,
} from "../domain/planner";
import { createConfigurationRepositories } from "../infrastructure/configuration-repositories";
import { createPlanRepository, type WeeklyPlan } from "../infrastructure/plan-repository";
import { createRecipeRepository } from "../infrastructure/recipe-repository";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, "Date is invalid");
const seedSchema = z.string().min(1).max(500);
const plannedAtSchema = z.string().datetime({ offset: true });

export type CreatePlanOptions = {
  readonly week?: string;
  readonly seed: string;
  readonly plannedAt: string;
  readonly packageEstimates?: readonly PackageEstimate[];
  readonly dealSignals?: readonly DealSignal[];
};

export class PlanInfeasibleError extends Error {
  constructor(readonly reasons: readonly string[]) {
    super(`No valid weekly plan: ${reasons.join("; ")}`);
    this.name = "PlanInfeasibleError";
  }
}

function parseDate(value: string): Date {
  return new Date(`${dateSchema.parse(value)}T00:00:00.000Z`);
}

function formatDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function mondayFor(value: Date): Date {
  const result = new Date(value);
  const daysSinceMonday = (result.getUTCDay() + 6) % 7;
  result.setUTCDate(result.getUTCDate() - daysSinceMonday);
  return result;
}

function addDays(value: string, count: number): string {
  const date = parseDate(value);
  date.setUTCDate(date.getUTCDate() + count);
  return formatDate(date);
}

export function resolvePlanWeekStart(week: string | undefined, today: string): string {
  const parsedToday = parseDate(today);
  if (week === undefined || week === "next") {
    const nextMonday = mondayFor(parsedToday);
    nextMonday.setUTCDate(nextMonday.getUTCDate() + 7);
    return formatDate(nextMonday);
  }
  return formatDate(mondayFor(parseDate(week)));
}

export function localDateInDenmark(now: Date = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Copenhagen",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const values = new Map(parts.map(({ type, value }) => [type, value]));
  return dateSchema.parse(`${values.get("year")}-${values.get("month")}-${values.get("day")}`);
}

export function createPlanDraft(database: Database, options: CreatePlanOptions): WeeklyPlan {
  const seed = seedSchema.parse(options.seed);
  const plannedAt = plannedAtSchema.parse(options.plannedAt);
  const today = localDateInDenmark(new Date(plannedAt));
  const weekStart = resolvePlanWeekStart(options.week, today);
  const shoppingDate = addDays(weekStart, -2);
  const family = readFamilyConfiguration(database);
  const householdServings = family.members.reduce((sum, member) => sum + member.servings, 0);
  if (!Number.isFinite(householdServings) || householdServings <= 0) {
    throw new Error("Configured household servings must be positive");
  }
  const sources = createConfigurationRepositories(database).recipeSources.list();
  const enabledSourceIds = new Set(sources.filter(({ enabled }) => enabled).map(({ id }) => id));
  const recipes = createRecipeRepository(database).list({ limit: 500 });
  const dietaryRestrictions = family.rules
    .filter(({ kind }) => kind === "dietary_restriction")
    .map(({ value }) => value);
  const dislikedIngredients = family.rules
    .filter(({ kind }) => kind === "disliked_ingredient")
    .map(({ value }) => value);
  const recentSince = addDays(weekStart, -56);
  const planRepository = createPlanRepository(database);
  const generated = generateWeeklyPlan({
    weekStart,
    plannedAt,
    seed,
    recipes,
    dayProfiles: family.dayProfiles,
    context: {
      householdServings,
      enabledSourceIds,
      dietaryRestrictions,
      dislikedIngredients,
    },
    scoreContext: {
      householdServings,
      pantryItems: readPantry(database),
      packageEstimates: options.packageEstimates ?? [],
      dealSignals: options.dealSignals ?? [],
      preferredStoreIds: new Set(family.preferredStores.map(({ id }) => id)),
      shoppingDate,
      recentRecipeIds: new Set(planRepository.listRecentRecipeIds(recentSince)),
    },
  });
  if (generated.status === "infeasible") throw new PlanInfeasibleError(generated.reasons);
  return planRepository.saveDraft(generated.plan);
}
