import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  DAYS,
  type Day,
  type GeneratedWeeklyPlan,
  type WeeklyPlanScore,
} from "../domain/planner";

const dateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
const timestampSchema = z.string().datetime({ offset: true });
const planIdSchema = z.string().regex(/^plan:[a-f0-9]{64}$/);
const mealIdSchema = z.string().regex(/^meal:[a-f0-9]{64}$/);
const recipeIdSchema = z.string().regex(/^recipe:[a-f0-9]{64}$/);
const hashSchema = z.string().regex(/^[a-f0-9]{64}$/);
const statusSchema = z.enum(["draft", "accepted", "completed", "superseded"]);
const sqliteBooleanSchema = z.union([z.literal(0), z.literal(1)]);
const daySchema = z.enum(DAYS);
const textArraySchema = z.array(z.string().min(1).max(1_000)).max(100);

const predictedRemainderSchema = z.object({
  normalizedIngredient: z.string().min(1).max(300),
  unit: z.string().min(1).max(100),
  demand: z.number().finite().nonnegative(),
  pantryUsed: z.number().finite().nonnegative(),
  packageQuantity: z.number().finite().positive(),
  packageCount: z.number().int().nonnegative(),
  remainder: z.number().finite().nonnegative(),
  perishability: z.enum(["shelf-stable", "perishable", "short-lived"]),
}).strict();

const scoreSchema = z.object({
  wastePenalty: z.number().finite(),
  remainderPenalty: z.number().finite().nonnegative(),
  oneOffPenalty: z.number().finite().nonnegative(),
  reuseCredit: z.number().finite().nonnegative(),
  pantryCredit: z.number().finite().nonnegative(),
  dealValue: z.number().finite().nonnegative(),
  favoriteCount: z.number().int().nonnegative(),
  historyPenalty: z.number().int().nonnegative(),
  varietyScore: z.number().int().nonnegative(),
  reuseIngredientCount: z.number().int().nonnegative(),
  pantryIngredientCount: z.number().int().nonnegative(),
  predictedRemainders: z.array(predictedRemainderSchema).max(500),
  explanations: z.array(z.string().min(1).max(2_000)).max(1_000),
  warnings: z.array(z.string().min(1).max(2_000)).max(1_000),
}).strict();

const generatedMealSchema = z.object({
  day: daySchema,
  date: dateSchema,
  recipeId: recipeIdSchema,
  servings: z.number().finite().positive().max(1_000_000),
  rationale: textArraySchema,
  prepLinks: textArraySchema,
}).strict();

const generatedPlanSchema = z.object({
  weekStart: dateSchema,
  shoppingDate: dateSchema,
  plannedAt: timestampSchema,
  seed: z.string().min(1).max(500),
  meals: z.array(generatedMealSchema).length(7),
  score: scoreSchema,
}).strict().superRefine((plan, context) => {
  for (const [index, day] of DAYS.entries()) {
    if (plan.meals[index]?.day !== day) {
      context.addIssue({ code: "custom", message: "Plan meals must be in Monday-Sunday order", path: ["meals", index, "day"] });
    }
  }
  if (new Set(plan.meals.map(({ recipeId }) => recipeId)).size !== 7) {
    context.addIssue({ code: "custom", message: "Plan meals must use seven distinct recipes", path: ["meals"] });
  }
});

const planRowSchema = z.object({
  id: planIdSchema,
  weekStart: dateSchema,
  shoppingDate: dateSchema,
  plannedAt: timestampSchema,
  status: statusSchema,
  seed: z.string().min(1).max(500),
  scoreJson: z.string().max(250_000),
}).strict();

const mealRowSchema = z.object({
  id: mealIdSchema,
  day: daySchema,
  date: dateSchema,
  recipeId: recipeIdSchema,
  servings: z.number().finite().positive(),
  locked: sqliteBooleanSchema,
  rationaleJson: z.string().max(100_000),
  prepLinksJson: z.string().max(100_000),
  contentHash: hashSchema,
}).strict();

export type PlanStatus = z.infer<typeof statusSchema>;
export type PlanMeal = {
  readonly id: string;
  readonly day: Day;
  readonly date: string;
  readonly recipeId: string;
  readonly servings: number;
  readonly locked: boolean;
  readonly rationale: readonly string[];
  readonly prepLinks: readonly string[];
  readonly contentHash: string;
};
export type WeeklyPlan = {
  readonly id: string;
  readonly weekStart: string;
  readonly shoppingDate: string;
  readonly plannedAt: string;
  readonly status: PlanStatus;
  readonly seed: string;
  readonly score: WeeklyPlanScore;
  readonly meals: readonly PlanMeal[];
};

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function createPlanId(plan: GeneratedWeeklyPlan): string {
  return `plan:${digest(JSON.stringify(plan))}`;
}

function createMealId(planId: string, day: Day): string {
  return `meal:${digest(`${planId}\0${day}`)}`;
}

function mealContentHash(meal: Omit<PlanMeal, "id" | "contentHash">): string {
  return digest(JSON.stringify(meal));
}

function parseJson(value: string, label: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} contains malformed JSON`);
  }
}

const SELECT_PLAN = `
  SELECT id, week_start AS weekStart, shopping_date AS shoppingDate,
         planned_at AS plannedAt, status, seed, score_summary AS scoreJson
  FROM weekly_plans
`;

export class PlanRepository {
  constructor(private readonly database: Database) {}

  saveDraft(input: GeneratedWeeklyPlan): WeeklyPlan {
    const draft = generatedPlanSchema.parse(input) as GeneratedWeeklyPlan;
    const id = createPlanId(draft);
    return this.database.transaction(() => {
      const existing = this.getInCurrentTransaction(id);
      if (existing !== null) return existing;
      const existingDraft = this.database.query<{ id: string }, [string]>(
        "SELECT id FROM weekly_plans WHERE week_start = ? AND status = 'draft'",
      ).get(draft.weekStart);
      if (existingDraft !== null && existingDraft.id !== id) {
        this.database.query("DELETE FROM weekly_plans WHERE id = ?").run(existingDraft.id);
      }
      this.database.query(`
        INSERT INTO weekly_plans (
          id, week_start, shopping_date, planned_at, status, seed, score_summary
        ) VALUES (?, ?, ?, ?, 'draft', ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          shopping_date = excluded.shopping_date,
          planned_at = excluded.planned_at,
          seed = excluded.seed,
          score_summary = excluded.score_summary
      `).run(
        id,
        draft.weekStart,
        draft.shoppingDate,
        draft.plannedAt,
        draft.seed,
        JSON.stringify(draft.score),
      );
      this.database.query("DELETE FROM plan_meals WHERE plan_id = ?").run(id);
      const insertMeal = this.database.query(`
        INSERT INTO plan_meals (
          id, plan_id, day, date, recipe_id, servings, locked,
          rationale, prep_links, content_hash
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const meal of draft.meals) {
        const content = {
          day: meal.day,
          date: meal.date,
          recipeId: meal.recipeId,
          servings: meal.servings,
          locked: false,
          rationale: [...meal.rationale],
          prepLinks: [...meal.prepLinks],
        };
        insertMeal.run(
          createMealId(id, meal.day),
          id,
          meal.day,
          meal.date,
          meal.recipeId,
          meal.servings,
          0,
          JSON.stringify(meal.rationale),
          JSON.stringify(meal.prepLinks),
          mealContentHash(content),
        );
      }
      const saved = this.getInCurrentTransaction(id);
      if (saved === null) throw new Error(`Saved plan could not be read: ${id}`);
      return saved;
    }).immediate();
  }

  get(id: string): WeeklyPlan | null {
    const parsedId = planIdSchema.parse(id);
    return this.database.transaction(() => this.getInCurrentTransaction(parsedId))();
  }

  getForWeek(weekStart: string): WeeklyPlan | null {
    const parsedWeek = dateSchema.parse(weekStart);
    return this.database.transaction(() => {
      const row = this.database.query<{ id: string }, [string]>(`
        SELECT id FROM weekly_plans
        WHERE week_start = ?
        ORDER BY CASE status
          WHEN 'draft' THEN 0 WHEN 'accepted' THEN 1 WHEN 'completed' THEN 2 ELSE 3
        END, planned_at DESC, id
        LIMIT 1
      `).get(parsedWeek);
      return row === null ? null : this.getInCurrentTransaction(row.id);
    })();
  }

  accept(id: string, recordedAt: string): WeeklyPlan {
    const parsedId = planIdSchema.parse(id);
    const parsedRecordedAt = timestampSchema.parse(recordedAt);
    return this.database.transaction(() => {
      const current = this.getInCurrentTransaction(parsedId);
      if (current === null) throw new Error(`Plan does not exist: ${parsedId}`);
      if (current.status === "accepted") return current;
      if (current.status !== "draft") {
        throw new Error(`Only a draft plan can be accepted: ${parsedId}`);
      }
      this.database.query(`
        UPDATE weekly_plans SET status = 'completed'
        WHERE week_start = ? AND status = 'accepted'
      `).run(current.weekStart);
      this.database.query("UPDATE weekly_plans SET status = 'accepted' WHERE id = ?").run(parsedId);
      const insertHistory = this.database.query(`
        INSERT INTO meal_history (
          id, recipe_id, cooked_on, plan_id, plan_meal_id, recorded_at
        ) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_meal_id) DO NOTHING
      `);
      for (const meal of current.meals) {
        insertHistory.run(
          `history:${digest(meal.id)}`,
          meal.recipeId,
          meal.date,
          current.id,
          meal.id,
          parsedRecordedAt,
        );
      }
      const accepted = this.getInCurrentTransaction(parsedId);
      if (accepted === null) throw new Error(`Accepted plan could not be read: ${parsedId}`);
      return accepted;
    }).immediate();
  }

  listRecentRecipeIds(since: string): string[] {
    const parsedSince = dateSchema.parse(since);
    return this.database.query<{ recipeId: string; latest: string }, [string]>(`
      SELECT recipe_id AS recipeId, MAX(cooked_on) AS latest
      FROM meal_history
      WHERE cooked_on >= ?
      GROUP BY recipe_id
      ORDER BY latest DESC, recipe_id
    `).all(parsedSince).map(({ recipeId }) => recipeIdSchema.parse(recipeId));
  }

  private getInCurrentTransaction(id: string): WeeklyPlan | null {
    const rawPlan = this.database.query<Record<string, unknown>, [string]>(
      `${SELECT_PLAN} WHERE id = ?`,
    ).get(id);
    if (rawPlan === null) return null;
    const row = planRowSchema.parse(rawPlan);
    const score = scoreSchema.parse(parseJson(row.scoreJson, "Plan score"));
    const rawMeals = this.database.query<Record<string, unknown>, [string]>(`
      SELECT id, day, date, recipe_id AS recipeId, servings, locked,
             rationale AS rationaleJson, prep_links AS prepLinksJson,
             content_hash AS contentHash
      FROM plan_meals
      WHERE plan_id = ?
      ORDER BY CASE day
        WHEN 'mon' THEN 1 WHEN 'tue' THEN 2 WHEN 'wed' THEN 3 WHEN 'thu' THEN 4
        WHEN 'fri' THEN 5 WHEN 'sat' THEN 6 WHEN 'sun' THEN 7
      END
    `).all(row.id);
    if (rawMeals.length !== DAYS.length) throw new Error("Persisted plan must contain exactly seven meals");
    const meals = rawMeals.map((rawMeal, index): PlanMeal => {
      const meal = mealRowSchema.parse(rawMeal);
      if (meal.day !== DAYS[index]) throw new Error("Persisted plan meals are not in Monday-Sunday order");
      const rationale = textArraySchema.parse(parseJson(meal.rationaleJson, "Plan meal rationale"));
      const prepLinks = textArraySchema.parse(parseJson(meal.prepLinksJson, "Plan meal prep links"));
      const content = {
        day: meal.day,
        date: meal.date,
        recipeId: meal.recipeId,
        servings: meal.servings,
        locked: meal.locked === 1,
        rationale,
        prepLinks,
      };
      if (meal.id !== createMealId(row.id, meal.day)) throw new Error("Plan meal id does not match its stable identity");
      if (meal.contentHash !== mealContentHash(content)) throw new Error("Plan meal content hash does not match its content");
      return { id: meal.id, ...content, contentHash: meal.contentHash };
    });
    return {
      id: row.id,
      weekStart: row.weekStart,
      shoppingDate: row.shoppingDate,
      plannedAt: row.plannedAt,
      status: row.status,
      seed: row.seed,
      score,
      meals,
    };
  }
}

export function createPlanRepository(database: Database): PlanRepository {
  return new PlanRepository(database);
}
