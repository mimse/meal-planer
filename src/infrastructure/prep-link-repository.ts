import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import type { VerifiedPrepLink } from "../domain/planner";
import { createPlanRepository } from "./plan-repository";
import { createRecipeRepository, parseRecipeId } from "./recipe-repository";

const idSchema = z.string().regex(/^prep:[a-f0-9]{64}$/);
const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value;
});
const inputSchema = z.object({
  sourceRecipeId: z.string().regex(/^recipe:[a-f0-9]{64}$/),
  targetMealId: z.string().regex(/^meal:[a-f0-9]{64}$/),
  kind: z.enum(["prep", "leftover"]),
  normalizedIngredient: z.string().trim().min(1).max(300),
  quantity: z.number().finite().positive().max(1_000_000_000),
  unit: z.enum(["g", "ml", "stk"]),
  note: z.string().trim().min(1).max(500),
}).strict();
const rowSchema = inputSchema.extend({ id: idSchema, targetDate: dateSchema }).strict();
export type PrepLinkInput = z.infer<typeof inputSchema>;

export function parsePrepLinkInput(input: unknown): PrepLinkInput {
  const parsed = inputSchema.parse(input);
  return { ...parsed, normalizedIngredient: parsed.normalizedIngredient.normalize("NFKC").toLocaleLowerCase("da-DK").replace(/\s+/gu, " ").trim() };
}
const SELECT = `SELECT l.id, l.source_recipe_id AS sourceRecipeId, l.target_meal_id AS targetMealId,
  l.kind, l.normalized_ingredient AS normalizedIngredient, l.quantity, l.unit, l.note, m.date AS targetDate
  FROM recipe_prep_links l JOIN plan_meals m ON m.id = l.target_meal_id`;

export class PrepLinkRepository {
  constructor(private readonly database: Database) {}

  add(input: PrepLinkInput): VerifiedPrepLink {
    const parsed = parsePrepLinkInput(input);
    const id = `prep:${createHash("sha256").update(JSON.stringify(parsed)).digest("hex")}`;
    return this.database.transaction(() => {
      const existing = this.database.query(`${SELECT} WHERE l.id = ?`).get(id);
      if (existing !== null) return rowSchema.parse(existing);
      const target = this.validate(parsed);
      const allocated = this.database.query<{ quantity: number }, [string, string, string]>(`SELECT COALESCE(SUM(quantity), 0) AS quantity FROM recipe_prep_links WHERE target_meal_id = ? AND normalized_ingredient = ? AND unit = ?`)
        .get(parsed.targetMealId, parsed.normalizedIngredient, parsed.unit)!.quantity;
      if (allocated + parsed.quantity > target.capacity) throw new Error("Prep allocation exceeds target ingredient demand");
      this.database.query(`INSERT INTO recipe_prep_links (id, source_recipe_id, target_meal_id, kind, normalized_ingredient, quantity, unit, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(id, parsed.sourceRecipeId, parsed.targetMealId, parsed.kind, parsed.normalizedIngredient, parsed.quantity, parsed.unit, parsed.note);
      return rowSchema.parse({ id, ...parsed, targetDate: target.date });
    }).immediate();
  }

  listVerifiedForSunday(sunday: string): VerifiedPrepLink[] {
    const parsedSunday = dateSchema.parse(sunday);
    return this.database.transaction(() => {
      const raw = this.database.query(`${SELECT} WHERE m.date > ? ORDER BY l.id`).all(parsedSunday);
      return raw.flatMap((value) => {
        const link = rowSchema.parse(value);
        const otherOccurrence = this.database.query(`SELECT m.id FROM plan_meals m, json_each(m.prep_links) j WHERE j.value = ? AND m.date != ? LIMIT 1`).get(link.id, parsedSunday);
        if (otherOccurrence !== null) return [];
        let target: { date: string; capacity: number };
        try { target = this.validate(link, link.id); } catch { return []; }
        const allocated = this.database.query<{ quantity: number }, [string, string, string]>(`SELECT COALESCE(SUM(quantity), 0) AS quantity FROM recipe_prep_links WHERE target_meal_id = ? AND normalized_ingredient = ? AND unit = ?`)
          .get(link.targetMealId, link.normalizedIngredient, link.unit)!.quantity;
        if (allocated > target.capacity) return [];
        return [link];
      });
    })();
  }

  /** Conservatively retain bound links until an explicit detach/revalidation workflow exists. */
  remove(id: string): void {
    const parsedId = idSchema.parse(id);
    this.database.transaction(() => {
      const referenced = this.database.query<{ count: number }, [string]>(`SELECT COUNT(*) AS count FROM plan_meals m, json_each(m.prep_links) j WHERE j.value = ?`).get(parsedId)!.count;
      if (referenced > 0) throw new Error("Prep link is bound to a saved meal; bound endpoints cannot be removed until an explicit detach/revalidation workflow exists");
      if (this.database.query("DELETE FROM recipe_prep_links WHERE id = ?").run(parsedId).changes === 0) throw new Error(`Prep link does not exist: ${parsedId}`);
    }).immediate();
  }

  private validate(input: PrepLinkInput, existingId = ""): { date: string; capacity: number } {
    const recipes = createRecipeRepository(this.database);
    const source = recipes.get(parseRecipeId(input.sourceRecipeId));
    if (source === null || source.needsReview) throw new Error("Prep source recipe must exist and be reviewed");
    const raw = this.database.query<{ planId: string }, [string]>("SELECT plan_id AS planId FROM plan_meals WHERE id = ?").get(input.targetMealId);
    if (raw === null) throw new Error("Prep target meal does not exist");
    const plans = createPlanRepository(this.database);
    const plan = plans.get(raw.planId)!;
    const active = plans.getForWeek(plan.weekStart);
    if (active?.id !== plan.id || !["draft", "accepted"].includes(plan.status)) throw new Error("Prep target must belong to the active draft or accepted plan");
    const meal = plan.meals.find(({ id }) => id === input.targetMealId)!;
    const target = recipes.get(meal.recipeId);
    if (target === null || target.needsReview || target.servings === null) throw new Error("Prep target recipe must be reviewed with known servings");
    const measured = (ingredients: typeof source.ingredients) => ingredients.filter((ingredient) => !ingredient.uncertain && ingredient.normalizedName === input.normalizedIngredient && ingredient.unit === input.unit && ingredient.quantity !== null).reduce((sum, ingredient) => sum + ingredient.quantity!, 0);
    const sourceQuantity = measured(source.ingredients);
    const targetQuantity = measured(target.ingredients);
    if (sourceQuantity <= 0 || targetQuantity <= 0) throw new Error("Prep ingredient needs measured evidence in both recipes");
    if (input.kind === "prep" && !source.suitabilityTags.includes("prepAhead")) throw new Error("Prep source must be tagged prepAhead");
    if (input.kind === "leftover") {
      const allocated = this.database.query<{ quantity: number }, [string, string, string, string]>(`SELECT COALESCE(SUM(quantity), 0) AS quantity FROM recipe_prep_links WHERE kind = 'leftover' AND source_recipe_id = ? AND normalized_ingredient = ? AND unit = ? AND id != ?`)
        .get(input.sourceRecipeId, input.normalizedIngredient, input.unit, existingId)!.quantity;
      if (source.servings === null || allocated + input.quantity > sourceQuantity * source.extraMealServings / source.servings) {
        throw new Error("Leftover allocation exceeds extra yield ingredient demand");
      }
    }
    const capacity = targetQuantity * meal.servings / target.servings;
    if (input.quantity > capacity) throw new Error("Prep allocation exceeds target ingredient demand");
    return { date: meal.date, capacity };
  }
}

export function createPrepLinkRepository(database: Database): PrepLinkRepository {
  return new PrepLinkRepository(database);
}
