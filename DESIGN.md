# Meal-planning CLI: domain and UX design

## Scope

A Bun/TypeScript CLI creates an accepted Monday–Sunday dinner plan and its grocery list. Recipes may come only from:

`valdemarsro.dk`, `gourministeriet.dk`, `spisbedre.dk`, `juliebruun.com/category/opskrifter`, `juliekarla.dk`, and `mummum.dk`.

The local plan is authoritative. TilbudsTrolden adds deal scoring and store-grouped shopping data but may never silently reschedule meals.

## Commands

```text
mealplan init
mealplan config show|edit
mealplan recipes search <query> [--source <host>]
mealplan recipes show <recipe-id>
mealplan plan create [--week YYYY-MM-DD] [--no-deals]
mealplan plan show [--week YYYY-MM-DD] [--json]
mealplan plan replace <day> [--with <recipe-id>] [--week YYYY-MM-DD]
mealplan shopping show [--week YYYY-MM-DD] [--by-store] [--json]
mealplan shopping refresh-deals [--week YYYY-MM-DD]
```

`--week` resolves any date to its ISO week (Monday start). `init` records household size, dietary restrictions, preferred stores, pantry staples, and the late-arriving child. `plan create` finds candidates, applies constraints, optionally scores deals, previews the plan, and saves only after confirmation. Human-readable output is default; stable JSON supports automation.

Each plan row shows recipe and source link, active/total time, serving mode, vegetarian status, leftovers/prep links, and deal confidence. Hard validation errors are separate from warnings.

## Planning constraints

### Hard constraints

| Day | Rule |
|---|---|
| Monday | Normal-effort; total cooking time `<= 60 min`. |
| Tuesday | Normal-effort; supports staggered serving and `keep-warm`. |
| Wednesday | Normal-effort; supports the late child via `reheat` or `assemble-later`. |
| Thursday | `easy` and total cooking time `<= 30 min`. |
| Friday | Extra time available; slow/higher-effort meals are allowed. |
| Saturday | Shopping event for the following Monday–Sunday week. Dinner remains unconstrained unless configured otherwise. |
| Sunday | Either yields dinner plus at least two future household meals, or defines ingredient-prep tasks linked to later meals. |
| Week | At least one vegetarian dinner; every recipe meets household dietary restrictions and uses an allowed source. |

“Normal” means the household baseline (default: not `hard`); it is not an unstated time limit. Unknown time, serving suitability, ingredients, or Sunday yield cannot prove a hard constraint and therefore excludes the recipe until corrected.

A plan week starts Monday. Its main shopping date is the immediately preceding Saturday. Sunday prep may target the following week.

### Soft objectives, in order

1. Respect likes/dislikes and avoid rejected recipes.
2. Prefer valid, high-confidence offers at configured stores.
3. Reuse ingredients and pantry stock to reduce waste.
4. Avoid recent repetition and vary cuisine/protein.
5. Reduce estimated cost and unnecessary store visits.

Deals rank only already-valid candidates; they never relax schedule or dietary rules.

## TilbudsTrolden integration

Wrap `tilbudstrolden-mcp` behind a `DealsGateway`:

- Setup: `list_stores`, `update_household`, `get_household`, `update_pantry`.
- Ranking: synchronize recipe metadata with `add_recipe`; use `score_recipes`, `search_deals`, or `deals_this_week`.
- Shopping: call `generate_shopping_list` for the exact accepted recipe set. Do **not** delegate scheduling to `plan_and_shop`, because the CLI owns day constraints and plan identity.
- Store offer ID, store, price, currency, validity, confidence, and retrieval time. Offers invalid on shopping day or low-confidence matches are shown as warnings, not guaranteed savings.
- Aggregate scaled ingredients, subtract pantry stock, and retain each day's quantity contribution. Offline/`--no-deals` mode still produces an unpriced list.

## Single-day replacement

```text
$ mealplan plan replace thu
Replacing Thursday only: “Old recipe”
Reason (optional): dislike

1. New recipe · 25 min · easy · vegetarian · Netto offer
2. New recipe · 20 min · easy
Choose: 1

Thursday: Old recipe -> New recipe
Other days: unchanged (6/6)
Shopping delta: - 500 g …, + 2 …
Accept? [y/N]
```

Replacement is an atomic constrained transaction:

1. Load the accepted revision and pin the other six `DayPlan` records by stable ID and content hash.
2. Exclude the disliked recipe and show only target-day-valid candidates.
3. Revalidate whole-week rules with only the target day unlocked. If it is the sole vegetarian meal or Sunday batch/prep meal, its replacement must preserve that role.
4. Preview exactly one changed day and the derived grocery delta.
5. On confirmation, create a new revision, copy unaffected days byte-for-byte, replace the target, regenerate the list, and verify all six hashes.
6. If persistence or MCP/list generation fails, keep the prior plan and list active. No automatic rebalancing is allowed.

## Data model

```ts
type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";
type ServingMode = "immediate" | "keep-warm" | "reheat" | "assemble-later";

type Recipe = {
  id: string;                  // stable source ID/hash, never title/index
  title: string;
  sourceUrl: string;
  sourceHost: AllowedSource;
  servings: number;
  ingredients: Ingredient[];
  activeMinutes: number | null;
  totalMinutes: number | null;
  complexity: "easy" | "normal" | "hard";
  vegetarian: boolean;
  servingModes: ServingMode[];
  yieldHouseholdMeals: number; // dinner only = 1; Sunday batch requires >= 3
  prepTasks: PrepTask[];
  attribution: { author?: string; fetchedAt: string };
};

type DayPlan = {
  id: string;
  date: string;
  day: Day;
  recipeId: string;
  servingsToCook: number;
  prepTaskIds: string[];
  consumesFromDayPlanIds: string[];
  constraintEvidence: string[];
  contentHash: string;
};

type WeeklyPlan = {
  id: string;
  weekStart: string;
  shoppingDate: string;        // preceding Saturday
  status: "draft" | "accepted" | "superseded";
  revision: number;
  parentRevisionId?: string;
  days: Record<Day, DayPlan>;
};

type GroceryContribution = {
  dayPlanId: string;
  recipeId: string;
  ingredientId: string;
  quantity: number;
  unit: string;
};

type GroceryItem = {
  normalizedIngredient: string;
  required: GroceryContribution[];
  pantryDeduction?: { quantity: number; unit: string };
  purchaseQuantity: number;
  unit: string;
  deal?: {
    offerId: string;
    store: string;
    price: number;
    currency: string;
    validFrom: string;
    validUntil: string;
    confidence: "high" | "medium" | "low";
    retrievedAt: string;
  };
};

type PlanRevision = {
  id: string;
  planId: string;
  revision: number;
  changedDay: Day | null;
  reason?: string;
  priorDayHashes: Partial<Record<Day, string>>;
  createdAt: string;
};
```

## Acceptance criteria

1. `bun run … plan create --week <date>` produces exactly seven dated dinners for the resolved Monday–Sunday week and a shopping date on the preceding Saturday.
2. The validator proves Monday `<=60`; Tuesday `keep-warm`; Wednesday `reheat|assemble-later`; Thursday `easy && <=30`; at least one vegetarian dinner; and Sunday total yield `>=3` household meals or prep tasks linked to future meal IDs.
3. Every recipe has an allowlisted URL, attribution, ingredients, and metadata sufficient to prove its assignment; missing data never passes by assumption.
4. Deal data affects ranking only. Every accepted plan remains valid with deals unavailable or `--no-deals`.
5. The grocery list derives from exactly the accepted assignments, scales servings/leftovers, aggregates normalized ingredients, and subtracts pantry quantities.
6. Displayed deals include store, price/currency, validity, retrieval time, and confidence; an offer invalid on shopping day is not counted as savings.
7. Replacing one day creates one revision where that recipe ID changes and all six other `DayPlan.contentHash` values remain identical.
8. Replacement preserves day and whole-week rules, including the sole vegetarian or Sunday batch/prep role.
9. The CLI previews the one-day and grocery deltas; cancellation changes neither active plan nor list.
10. Replacement is atomic: any regeneration/persistence failure leaves the prior accepted revision and list active.
11. A rejected recipe is excluded from that replacement and remembered for future ranking without changing current assignments.
12. Plan and shopping commands emit stable JSON and non-zero exit codes on validation/integration failures.
