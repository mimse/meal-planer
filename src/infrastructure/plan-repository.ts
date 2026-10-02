import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { z } from "zod";
import { markReviewOverrides } from "../application/recipe-review-overrides";
import { createRecipeRepository } from "./recipe-repository";
import { createPrepLinkRepository } from "./prep-link-repository";
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

export type ReplacementRejection = "not-this-week" | "disliked" | "none";
export type ReplaceMealInput = {
  readonly original: WeeklyPlan;
  readonly day: Day;
  readonly meal: { readonly recipeId: string; readonly servings: number; readonly rationale: readonly string[]; readonly prepLinks: readonly string[] };
  readonly score: WeeklyPlanScore;
  readonly rejection: ReplacementRejection;
  readonly recordedAt: string;
};

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
        this.assertPrepBindingInCurrentTransaction(meal, draft.weekStart);
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

  lock(id: string, day: Day, expectedContentHash: string): WeeklyPlan {
    return this.setLocked(id, day, true, expectedContentHash);
  }

  unlock(id: string, day: Day, expectedContentHash: string): WeeklyPlan {
    return this.setLocked(id, day, false, expectedContentHash);
  }

  setLocked(id: string, day: Day, locked: boolean, expectedContentHash: string): WeeklyPlan {
    const parsedId = planIdSchema.parse(id);
    const parsedDay = daySchema.parse(day);
    const expected = hashSchema.parse(expectedContentHash);
    z.boolean().parse(locked);
    return this.database.transaction(() => {
      const plan = this.getInCurrentTransaction(parsedId);
      if (plan === null) throw new Error("Plan does not exist");
      this.assertCurrentSnapshotInCurrentTransaction(plan);
      const target = plan.meals.find((meal) => meal.day === parsedDay)!;
      if (target.contentHash !== expected) throw new Error("Stale meal content hash");
      if (target.locked === locked) return plan;
      const content = {
        day: target.day, date: target.date, recipeId: target.recipeId, servings: target.servings,
        locked, rationale: [...target.rationale], prepLinks: [...target.prepLinks],
      };
      this.database.query("UPDATE plan_meals SET locked = ?, content_hash = ? WHERE id = ?")
        .run(locked ? 1 : 0, mealContentHash(content), target.id);
      return this.getInCurrentTransaction(parsedId)!;
    }).immediate();
  }

  listRejectedRecipeIds(weekStart: string): string[] {
    return this.database.query<{ recipeId: string }, [string]>(
      "SELECT recipe_id AS recipeId FROM weekly_recipe_rejections WHERE week_start = ? ORDER BY recipe_id",
    ).all(dateSchema.parse(weekStart)).map(({ recipeId }) => recipeIdSchema.parse(recipeId));
  }

  /** Caller must hold a transaction; checks the entire saved snapshot, not just the target. */
  assertCurrentSnapshotInCurrentTransaction(original: WeeklyPlan): WeeklyPlan {
    if (!this.database.inTransaction) throw new Error("An active transaction is required");
    const current = this.getInCurrentTransaction(planIdSchema.parse(original.id));
    if (current === null || JSON.stringify(current) !== JSON.stringify(original)) {
      throw new Error("Stale replacement preview: plan content or status changed");
    }
    if (current.status !== "draft" && current.status !== "accepted") {
      throw new Error("Only the current draft or accepted plan can be modified");
    }
    if (this.getForWeek(current.weekStart)?.id !== current.id) {
      throw new Error("Stale replacement preview: plan is no longer current for its week");
    }
    return current;
  }

  assertReplaceableInCurrentTransaction(plan: WeeklyPlan, day: Day): PlanMeal {
    if (!this.database.inTransaction) throw new Error("An active transaction is required");
    const target = plan.meals.find((meal) => meal.day === daySchema.parse(day));
    if (target === undefined) throw new Error("Target day does not exist");
    if (target.locked) throw new Error("Target meal is locked; unlock it before replacement");
    const linked = this.database.query(`
      SELECT id FROM recipe_prep_links WHERE target_meal_id = ? OR source_recipe_id = ? LIMIT 1
    `).get(target.id, target.recipeId);
    if (target.prepLinks.length > 0 || linked !== null) {
      throw new Error("Target is a preparation link endpoint; links must be revalidated before replacement");
    }
    return target;
  }

  replaceMeal(input: ReplaceMealInput): WeeklyPlan {
    return this.database.transaction(() => this.replaceMealInCurrentTransaction(input)).immediate();
  }

  /** Transaction-safe primitive for application validation + writes under one write lock. */
  replaceMealInCurrentTransaction(input: ReplaceMealInput): WeeklyPlan {
    const current = this.assertCurrentSnapshotInCurrentTransaction(input.original);
    const target = this.assertReplaceableInCurrentTransaction(current, input.day);
    const recordedAt = timestampSchema.parse(input.recordedAt);
    const rejection = z.enum(["not-this-week", "disliked", "none"]).parse(input.rejection);
    const parsed = generatedMealSchema.parse({ ...input.meal, day: target.day, date: target.date });
    const score = scoreSchema.parse(input.score);
    if (current.meals.some(({ recipeId }) => recipeId === parsed.recipeId)) {
      throw new Error("Replacement must not duplicate an assigned recipe");
    }
    this.assertPrepBindingInCurrentTransaction(parsed, current.weekStart);
    const content = {
      day: target.day, date: target.date, recipeId: parsed.recipeId, servings: parsed.servings,
      locked: target.locked, rationale: [...parsed.rationale], prepLinks: [...parsed.prepLinks],
    };
    const hash = mealContentHash(content);
    const update = this.database.query(`
      UPDATE plan_meals SET recipe_id = ?, servings = ?, rationale = ?, prep_links = ?, content_hash = ?
      WHERE id = ? AND content_hash = ?
    `).run(parsed.recipeId, parsed.servings, JSON.stringify(parsed.rationale), JSON.stringify(parsed.prepLinks), hash, target.id, target.contentHash);
    if (update.changes !== 1) throw new Error("Target meal update failed; replacement was not applied");
    this.database.query("UPDATE weekly_plans SET score_summary = ? WHERE id = ?")
      .run(JSON.stringify(score), current.id);
    if (current.status === "accepted") {
      this.database.query(`
        INSERT INTO meal_history (id, recipe_id, cooked_on, plan_id, plan_meal_id, recorded_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_meal_id) DO UPDATE SET recipe_id = excluded.recipe_id, recorded_at = excluded.recorded_at
      `).run(`history:${digest(target.id)}`, parsed.recipeId, target.date, current.id, target.id, recordedAt);
    }
    if (rejection === "not-this-week") {
      this.database.query(`
        INSERT INTO weekly_recipe_rejections (week_start, recipe_id, recorded_at) VALUES (?, ?, ?)
        ON CONFLICT(week_start, recipe_id) DO NOTHING
      `).run(current.weekStart, target.recipeId, recordedAt);
    } else if (rejection === "disliked") {
      const rejected = createRecipeRepository(this.database).get(target.recipeId);
      if (rejected === null) throw new Error("Rejected recipe does not exist");
      const evidence = markReviewOverrides(rejected.sourceEvidence, ["preference"]);
      this.database.query("UPDATE recipes SET preference = 'disliked', source_evidence = ? WHERE id = ?")
        .run(JSON.stringify(evidence), target.recipeId);
    }
    this.database.query(`
      INSERT INTO plan_meal_revisions (plan_id, plan_meal_id, original_hash, replacement_hash,
        original_recipe_id, replacement_recipe_id, rejection, recorded_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(current.id, target.id, target.contentHash, hash, target.recipeId, parsed.recipeId, rejection, recordedAt);
    return this.getInCurrentTransaction(current.id)!;
  }

  /** JSON references reserve a link to one persisted producer, including accepted/history plans. */
  private assertPrepBindingInCurrentTransaction(meal: Pick<PlanMeal, "day" | "date" | "recipeId" | "prepLinks">, weekStart: string): void {
    if (meal.prepLinks.length === 0) return;
    const sunday = new Date(Date.parse(`${weekStart}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
    if (meal.day !== "sun" || meal.date !== sunday || new Date(`${meal.date}T00:00:00Z`).getUTCDay() !== 0 || new Set(meal.prepLinks).size !== meal.prepLinks.length) {
      throw new Error("Saved preparation links require a unique Sunday producer occurrence");
    }
    const validLinks = createPrepLinkRepository(this.database).listVerifiedForSunday(sunday);
    for (const id of meal.prepLinks) {
      const link = validLinks.find((link) => link.id === id);
      const referenced = this.database.query(`SELECT m.id FROM plan_meals m, json_each(m.prep_links) j WHERE j.value = ? LIMIT 1`).get(id);
      if (link === undefined || link.sourceRecipeId !== meal.recipeId || link.targetDate <= meal.date || referenced !== null) {
        throw new Error("Saved preparation links require revalidation and an unclaimed matching source occurrence");
      }
    }
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
