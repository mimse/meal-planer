# Mealplaner — implementation plan

## 1. Product goal

Build a local, interactive command-line meal planner in TypeScript, run with Bun. It creates a family-specific weekly dinner plan, imports recipes from configurable websites, lets one meal be replaced without changing the rest of the week, and generates a deal-aware grocery list through TilbudsTrolden MCP.

The CLI should remain useful when recipe sites or the deals service are unavailable: saved recipes and plans still work, while unavailable deal information is clearly marked.

## 2. Working assumptions

- Denmark is the initial market; the design keeps TilbudsTrolden's DK/NO/SE/FI support open.
- Household size, family members, dietary restrictions, dislikes, preferred stores, and pantry staples are collected during `setup`, rather than hard-coded.
- A plan covers Monday through Sunday and is normally created on Friday or Saturday for the following week.
- Grocery shopping happens on Saturday after the plan and grocery list have been finalized. If planning is done on Saturday, the CLI treats it as a same-day plan-and-shop flow.
- Preferred shops are REMA 1000, Netto, and SuperBrugsen. Deals and shopping suggestions must be limited to those shops unless the user explicitly changes the configuration.
- Sunday favors either a batch meal producing at least one additional family meal or prep linked to later meals. Sunday leftovers can carry into the following week's plan.
- At least one vegetarian dinner per week is a hard rule.
- Minimizing avoidable food waste is a primary optimization goal: favor recipes that share ingredients, use expected package remainders, consume pantry stock, and reuse planned leftovers.
- Recipe discovery and planning are deterministic; an LLM is not required.

## 3. Weekly rules

Represent schedule needs as data so they can later be edited without code changes.

| Day | Hard constraints | Preferences |
| --- | --- | --- |
| Monday | Total time <= 60 minutes | Normal family meal |
| Tuesday | Suitable for holding warm or reheating | Account for one child arriving late |
| Wednesday | Suitable for reheating | Account for one child arriving late |
| Thursday | Total time <= 30 minutes | Low-effort meal because of badminton |
| Friday | None beyond household restrictions | Prefer recipes that benefit from extra cooking time |
| Saturday | Shopping day is tracked separately | Keep dinner configurable rather than assuming no meal |
| Sunday | Batch-cook yield >= 2 meals, or explicit prep links to later meals | Prefer ingredients reused during the week |

Week-wide hard constraints:

- At least one meal tagged `vegetarian`.
- Every meal satisfies all household dietary restrictions.
- Exactly one dinner assignment per planned day.
- A recipe marked `disliked` or temporarily rejected is not selected.
- The same recipe is not repeated unless explicitly allowed.

Week-wide soft constraints, scored in order:

1. Fit the day's time and serving pattern.
2. Minimize predicted waste, especially unused perishable ingredients.
3. Reuse ingredients, package remainders, leftovers, and planned Sunday prep across recipes.
4. Prefer recipes with useful current deals at REMA 1000, Netto, or SuperBrugsen.
5. Avoid recently cooked meals.
6. Vary primary protein and cuisine.
7. Prefer family favorites.

Hard family and schedule rules always win. Among valid plans, the scorer compares expected waste first and deal value second; a bulk deal is penalized when the unused remainder would increase waste. The CLI should show the main reasons for the selected plan, such as "uses the rest of the spinach on Thursday" or "chicken is on offer at REMA 1000."

## 4. CLI experience

Use subcommands for repeatable automation and interactive prompts when arguments are omitted.

```text
mealplan setup
mealplan family show|edit
mealplan pantry show|add|remove

mealplan sources list
mealplan sources add <base-url> [--name <name>] [--adapter auto]
mealplan sources test <source>
mealplan sources sync [source] [--limit <n>]
mealplan sources enable|disable|remove <source>

mealplan recipes search [query] [--source <source>] [--tag <tag>]
mealplan recipes show <recipe>
mealplan recipes import <url>
mealplan recipes like|dislike <recipe>
mealplan recipes edit <recipe>

mealplan plan create [--week next] [--seed <value>]
mealplan plan show [--week next]
mealplan plan replace <day> [--recipe <recipe>]
mealplan plan lock|unlock <day>
mealplan plan accept [--week next]

mealplan shopping-list [--week next] [--refresh-deals]
mealplan history
```

Primary flow:

1. `mealplan setup` collects household, dietary rules, disliked ingredients, preferred stores, pantry staples, and source choices.
2. `mealplan sources sync` discovers and normalizes recipes.
3. On Friday or Saturday, `mealplan plan create --week next` produces a draft and explains why each recipe fits its day.
4. The user accepts the plan or runs `mealplan plan replace thursday`.
5. Replacement candidates are shown with cooking time, relevant tags, source, and reasons for selection.
6. `mealplan shopping-list --refresh-deals` rebuilds the ingredient list and asks TilbudsTrolden for current offers before shopping on Saturday.

The CLI warns when `--week next` is generated after Saturday's shopping window, but it never blocks an explicitly requested plan. The plan stores both `plannedAt` and `shoppingDate`, so offer freshness and expiry can be evaluated against the actual Saturday shopping date.

The initial setup preselects REMA 1000, Netto, and SuperBrugsen. It resolves their live TilbudsTrolden dealer IDs instead of hard-coding IDs. If SuperBrugsen is not returned by the current store directory, the CLI keeps it as a preferred regular-price shop, clearly reports that deal matching is unavailable for it, and never silently substitutes another chain.

## 5. Waste-aware planning

Before comparing valid weekly plans, aggregate ingredient demand across all seven recipes and compare it with pantry quantities, planned leftovers, and known offer/package sizes.

The waste score includes:

- Unused quantity from purchased packages when units can be normalized.
- A higher penalty for short-lived produce, dairy, meat, and fish.
- A penalty for one-off specialty ingredients used by only one recipe.
- A credit when another recipe consumes the expected package remainder.
- A credit for using pantry stock before buying more.
- A credit for Sunday prep or leftovers explicitly consumed by another meal.
- No invented precision: unparseable quantities are retained as text and scored as uncertain.

The planner evaluates complete weeks, not seven independently chosen recipes. Candidate generation first applies hard constraints, then searches combinations using a score such as:

```text
total = schedule fit
      + family preference
      + ingredient reuse
      + current deal value
      - predicted waste
      - recent meal repetition
      - unnecessary store switching
```

Weights live in configuration and can be tuned, but waste reduction outranks deal savings by default. The plan output includes a compact reuse summary and flags ingredients likely to remain unused.

## 6. Atomic meal replacement

Replacement is a first-class operation, not full regeneration.

1. Load the saved plan and target day.
2. Treat all six other day assignments as locked.
3. Find candidates satisfying the target day's constraints and all week-wide hard constraints.
4. Exclude the rejected recipe and optionally record it as `disliked` or `not-this-week`.
5. Preview the replacement, grocery-list delta, deal impact, and predicted-waste impact.
6. On confirmation, update only the target `PlanMeal` record in one database transaction.
7. Rebuild the aggregate grocery list from the seven fixed assignments.

Every plan and meal gets a stable ID. Tests compare the six unaffected records and their content hashes before and after replacement; they must remain byte-for-byte unchanged. If no valid replacement exists, the plan is not modified and the CLI explains which constraint prevented it.

## 7. Extensible recipe sources

### Built-in sources

- Valdemarsro
- Gourministeriet
- SPIS BEDRE
- Julie Bruun
- Julie Karla
- Mummum (`https://mummum.dk/`)

### Adapter contract

```ts
interface RecipeSourceAdapter {
  readonly kind: string;
  canHandle(source: RecipeSource): Promise<boolean>;
  discover(source: RecipeSource, cursor?: string): Promise<DiscoveryPage>;
  fetchRecipe(url: URL): Promise<RawRecipe>;
}
```

Processing pipeline:

1. `discover` obtains recipe URLs from a sitemap, feed, or recipe index.
2. `fetchRecipe` downloads one page with timeout, retry, user-agent, and per-host rate limiting.
3. The generic adapter first looks for Schema.org `Recipe` JSON-LD.
4. A site-specific adapter can override discovery or extraction when generic JSON-LD is insufficient.
5. Normalize servings, raw ingredient lines, cooking time, cuisine, and dietary tags while preserving the original values.
6. Validate the normalized record before storage.
7. Deduplicate by canonical URL first, then by normalized title plus source.
8. Record source, canonical URL, retrieval time, and parser version for provenance and re-imports.

`mealplan sources add` runs a probe before saving a source. A source can be disabled without deleting its imported recipes. Failure of one source must not block other sources or planning from cached recipes.

Initial implementation should support two extension paths:

- Config-only sources using the generic JSON-LD adapter.
- Code adapters registered in an adapter registry for sites needing custom logic.

Do not silently invent missing data. Recipes lacking a reliable duration, ingredients, or dietary classification are flagged `needsReview` and excluded from automatic planning until reviewed. Preserve links and attribution; do not republish full source content.

## 8. Domain model

Use `bun:sqlite` for the application's state and migrations. Important entities:

```ts
type Recipe = {
  id: string;
  sourceId: string;
  sourceUrl: string;
  canonicalUrl: string;
  title: string;
  servings: number | null;
  prepMinutes: number | null;
  cookMinutes: number | null;
  totalMinutes: number | null;
  ingredients: Ingredient[];
  instructions?: string[];
  cuisineTags: string[];
  proteinTag: string | null;
  dietaryTags: string[];
  suitabilityTags: Array<
    "quick" | "keepWarm" | "reheatFriendly" | "batchCook" | "prepAhead"
  >;
  extraMealServings: number;
  preference: "favorite" | "neutral" | "disliked";
  needsReview: boolean;
  parserVersion: string;
  fetchedAt: string;
};

type WeeklyPlan = {
  id: string;
  weekStart: string;
  status: "draft" | "accepted" | "completed";
  plannedAt: string;
  shoppingDate: string;
  meals: PlanMeal[];
  createdAt: string;
};

type PlanMeal = {
  id: string;
  date: string;
  recipeId: string;
  servings: number;
  locked: boolean;
  rationale: string[];
  prepLinks: string[];
};
```

Additional tables/entities: `HouseholdMember`, `HouseholdRule`, `DayProfile`, `RecipeSource`, `Ingredient`, `PantryItem`, `MealHistory`, `RejectedCandidate`, `StorePreference`, `PackageEstimate`, `IngredientRemainder`, and `SchemaMigration`.

Keep raw ingredient text alongside parsed quantities. Danish recipe quantities are not always machine-normalizable, so uncertain conversions must be visible instead of guessed.

## 9. TilbudsTrolden MCP integration

Pin the integration initially to upstream commit `ad18454bb9bb187f7ac51b7ec9f6a0d22555d5cb` (version 0.5.3). At that revision the server exposes stdio MCP, stores data in one JSON file, and returns human-oriented text rather than structured output.

Architecture boundary:

```text
Bun CLI
  -> local planner and SQLite state
  -> TilbudstroldenClient interface
       -> MCP SDK StdioClientTransport
       -> pinned TilbudsTrolden child process
       -> Tjek/etilbudsavis offers
```

Use the official `@modelcontextprotocol/sdk` client. The CLI runs under Bun. For the first supported setup, launch TilbudsTrolden with Node because Node >=18 is its declared runtime; keep Bun execution behind an experimental option even though a local probe at the pinned commit succeeded.

Set `TILBUDSTROLDEN_DATA` to an app-specific absolute path. Never share that file between concurrent server processes. Create its directory and back it up before mutations.

Use these MCP tools:

- `list_stores` to resolve and validate REMA 1000, Netto, and SuperBrugsen, then `update_household` during setup.
- `update_pantry` before list generation.
- `add_recipe` to synchronize eligible recipes before deal scoring and the seven selected recipes before shopping-list generation.
- `score_recipes` to obtain deal coverage and matched-offer estimates for recipe candidates.
- `generate_shopping_list` with the exact selected recipe names and household size.
- Optionally `search_deals` for an explicit product lookup command.

Do not use `plan_and_shop` as the primary planner. Its generic optimizer cannot enforce the family's keep-warm, precise daily time, vegetarian-minimum, Sunday-prep, recent-meal, or atomic-replacement rules. The local planner chooses the meals; TilbudsTrolden performs deal matching and shopping-list calculations.

TilbudsTrolden 0.5.3 returns human-readable text rather than structured data. To make deals safely influence recipe selection, add a small pinned compatibility patch that returns the existing text plus backward-compatible MCP `structuredContent` for `score_recipes` and `generate_shopping_list`. Prefer contributing this upstream; until accepted, keep the patch isolated under `vendor/` and guarded by contract tests. Do not spread Markdown parsing through the planner.

The local planner consumes structured fields such as recipe name, deal coverage, matched-offer estimate, store, package quantity, confidence, and expiry. Only offers from the three configured shops are eligible. Low-confidence matches may inform the displayed alternatives but must not materially improve a recipe's automatic deal score until confirmed.

Render TilbudsTrolden's shopping-list text alongside the CLI's local waste/remainder summary. Preserve its low-confidence matches, regular-price items, and expiry warnings. Keep all access behind a `DealProvider` interface so a future upstream schema or another provider can replace the compatibility patch.

Important safeguards:

- Inspect `listTools()` on startup and report incompatible versions clearly.
- Check MCP `isError` on every call.
- Apply timeouts and one bounded retry for read-only deal calls.
- Validate servings, dates, day numbers, store IDs, and ingredient data locally.
- Explain that totals cover matched offers and may not equal the full checkout price.
- Re-check deals immediately before finalizing Saturday's list; do not use offers that expire before the configured shopping date.
- Do not recommend an unconfigured shop merely because its price is lower.
- If offers are unavailable, output the complete ingredient list without deals rather than failing the plan.

## 10. Suggested project structure

```text
src/
  cli.ts
  commands/
    setup.ts
    sources.ts
    recipes.ts
    plan.ts
    shopping-list.ts
  domain/
    models.ts
    constraints.ts
    planner.ts
    replacement.ts
  application/
    create-plan.ts
    replace-meal.ts
    build-shopping-list.ts
    sync-recipes.ts
  adapters/
    recipes/
      adapter.ts
      registry.ts
      jsonld.ts
      valdemarsro.ts
      gourministeriet.ts
      spisbedre.ts
      juliebruun.ts
      juliekarla.ts
      mummum.ts
    deals/
      deal-provider.ts
      tilbudstrolden-client.ts
  infrastructure/
    database.ts
    migrations.ts
    http.ts
    config.ts
  presentation/
    prompts.ts
    tables.ts
tests/
  fixtures/
  unit/
  integration/
  e2e/
vendor/
  tilbudstrolden-mcp/
```

Recommended dependencies:

- `commander` for commands and non-interactive flags.
- `@clack/prompts` for the interactive setup and replacement flows.
- `zod` for external-data and configuration validation.
- `@modelcontextprotocol/sdk` for the MCP client.
- A focused HTML parser for JSON-LD and site adapters.
- Bun's built-in SQLite and test runner.

## 11. Delivery phases

### Phase 0 — integration spikes

**Current scope:** Phase 0 is complete. The repository contains the CLI shell, pinned-server compatibility probe, recipe fetch/extraction path, source findings, the backward-compatible `structuredContent` patch and contract tests for `score_recipes` and `generate_shopping_list`, and compact deterministic HTML fixtures for all six built-in recipe sources. Phase 2 also has production extraction adapters, persistence, configured-source import and sync services, deterministic recipe search/show, and atomic noninteractive review. Phases 3 and 4 now include production quantities/deal inputs and atomic target-day editing; see the scope and limits below.

- Initialize the Bun/TypeScript CLI.
- Pin and build TilbudsTrolden.
- Verify MCP initialize, `listTools`, `list_stores`, and one live `search_deals` call.
- Resolve REMA 1000, Netto, and SuperBrugsen against the live Danish store directory and record a tested fallback if a chain is unavailable.
- Add and contract-test the minimal structured scoring/shopping response patch needed by the local optimizer.
- Probe each initial recipe source for sitemap/feed discovery and Recipe JSON-LD.
- Save representative HTML fixtures for deterministic tests.
- Decide which sources need custom adapters based on evidence.

Exit criterion: the CLI can connect to the pinned MCP server and extract at least one validated recipe fixture through the adapter contract.

### Phase 1 — local foundation and setup

- Add SQLite migrations and repositories.
- Implement household, pantry, day profiles, and source configuration.
- Build `setup`, `family`, and `pantry` commands.
- Validate all interactive and flag-based input.

Exit criterion: configuration survives process restarts and can be edited non-interactively.

### Phase 2 — recipe ingestion

**Current scope:** The recipe-ingestion vertical slice is implemented. The shared public HTTP(S) transport preserves DNS pinning and redirect revalidation, source discovery/import remain configured-site scoped and bounded, requests are rate-limited per host, and responses use a bounded conditional SQLite cache. Custom source recipe candidates use one conservative decoded path-scope check before recipe fetch and after redirects/extraction, while same-site root robots and sitemap metadata remain discoverable. Exact built-ins are site-scoped: a configured category such as Julie Bruun's `/category/opskrifter/` is a discovery seed, not a recipe URL prefix; the verified fixture is `/flaeskesteg-i-airfryer/`. The extraction registry supports configured `auto`, `jsonld`, `microdata`, and `spisbedre-inertia` modes and all six built-in fixture routes. `sources sync` applies a 1–100 page limit per source, reports attempted URLs and failed attempts separately from distinct persisted recipe IDs, continues across bounded source/recipe failures, and persists each recipe atomically. Source refreshes update extraction defaults and preserve only explicit review overrides recorded in bounded source-evidence metadata; refreshed source ingredients and merged planner fields drive completeness. Stable identity includes normalized source URL within one source in addition to canonical and source/title checks. `recipes import`, `search`, `show`, and noninteractive `review` preserve provenance and enforce the documented planning-critical completeness rule, with duplicate singleton options and guaranteed-incomplete reviewed states rejected before opening SQLite. Phase 3 now normalizes unambiguous measured ingredients and supports reviewed quantities while preserving raw lines and explicit review overrides. `sources test` remains discovery-only. The Phase 2 live-source exit criterion is not declared complete until all six current websites are reverified live. Dedicated like/dislike shortcuts are deferred; preferences remain editable with `recipes review`.

- Build HTTP safety, caching, rate limiting, and the generic JSON-LD adapter.
- Add source registry and source-management commands.
- Add custom adapters only where Phase 0 proves necessary.
- Normalize, validate, deduplicate, and review recipes.

Exit criterion: all six built-in sources either import successfully or report a precise unsupported/blocked reason; a compatible new JSON-LD source can be added without changing the planner.

### Phase 3 — family-aware planner

**Current scope:** Implemented: pure-domain hard constraints, seeded bounded score optimization backed by an exact distinct-recipe feasibility witness, seven distinct recipes with a vegetarian minimum, and infeasibility explanations. Ingredient normalization converts unambiguous metric/piece quantities to g/ml/stk; `recipes review --ingredients-json` supports explicit measured review retained across refresh. Weekly demand uses actual batch production servings, canonical pantry quantities, package remainders, and explicit verified prep/leftover links to saved future meals. `plan create` loads preferred-store shopping-date-valid deals/package estimates through an isolated pinned MCP session; `--no-deals` and provider failure support warned local fallback. Store identity, confidence, offer dates, and structured output are validated. Shopping-window warnings, preference/history signals, waste-first comparison, stable plan/meal IDs/hashes, and create/show/accept persistence are implemented. Identical accepted content is reused without rewriting history. Production bundled-CLI planning was exercised against real deals using explicitly synthetic recipe fixtures; deterministic tests, typecheck, and build verify the implementation.

**Limits:** Score optimization is heuristic, not globally optimal; feasibility is independently proved for the supported daily constraints and vegetarian minimum. Ambiguous ingredient quantities remain unscored with warnings. Free-text dietary matching is not an allergen-safety guarantee. Unknown package perishability uses an explicit conservative assumption. Deal value is reliable matched-ingredient coverage, not monetary savings or a checkout total. Prep reservations bind to one saved Sunday occurrence, and aggregate leftover allocations cannot exceed source yield. Bound endpoints remain protected; there is no atomic detach/revalidation workflow yet. Dedicated like/dislike shortcuts are deferred; use `recipes review --preference`. Final grouped shopping-list generation remains Phase 5 work.

- Implement hard-constraint filtering and soft scoring.
- Aggregate weekly ingredient demand and score expected package remainders, perishability, pantry use, leftovers, and cross-recipe ingredient reuse.
- Incorporate current preferred-store deal coverage after waste and hard constraints.
- Add seeded deterministic selection and infeasibility explanations.
- Track history, favorites, disliked recipes, and Sunday prep links.
- Save draft/accepted plans with stable IDs.

Exit criterion: generated plans satisfy every weekly rule, including at least one vegetarian meal, and provide a tested waste/reuse explanation.

### Phase 4 — replacement workflow

**Current scope:** Implemented: `plan replace` previews ranked target-day candidates with measured ingredient additions/removals, offer changes, and score/waste deltas across six fixed assignments. TTY use prompts for selection, rejection handling, and confirmation; preview/JSON/noninteractive use does not mutate without explicit `--with` and `--yes`. `plan lock|unlock` exposes explicit locks. Confirmation revalidates the entire saved plan, active week identity, recipes, family configuration, pantry, and future prep capacity inside one immediate transaction. Only the target meal changes while its ID and six unaffected records/hashes remain stable. Accepted target history, weekly rejection or persistent dislike override, score, and revision audit update atomically. Tests cover stale evidence, sole vegetarian preservation, disabled/disliked/assigned recipes, locks, rollback, and ignored target updates. Persisted prep endpoints are conservatively blocked until links can be revalidated.

- Implement target-day candidate selection and preview.
- Add `not-this-week` and persistent `disliked` choices.
- Perform replacement transactionally.
- Show ingredient additions/removals, deal changes, and predicted-waste changes after replacement.

Exit criterion: replacing one meal changes exactly one `PlanMeal`; the other six records and hashes are unchanged.

**Verification:** `bun run verify` passes 449 tests, typecheck, and production build. The bundled CLI was exercised from outside the repository against real live deals using explicitly synthetic recipes in isolated SQLite/MCP directories. Saved planning output was read back; acceptance, lock/unlock, read-only preview, and confirmed replacement preserved six raw meal rows and six unaffected history rows. `git diff --check` passes. Changes are uncommitted.

### Phase 5 — deal-aware grocery list

- Implement the isolated MCP client and server lifecycle.
- Map household, the three preferred stores, pantry, and selected recipes into TilbudsTrolden calls.
- Render the final grouped list and deal warnings.
- Show expected package remainders and which later recipe consumes each reusable remainder.
- Add graceful offline/no-deal behavior.

Exit criterion: an accepted plan produces a complete ingredient list and, when live offers are available, includes TilbudsTrolden store/deal matches.

### Phase 6 — hardening and distribution

- Add source fixtures, planner property tests, MCP contract tests, and end-to-end CLI tests.
- Add backup/recovery behavior for local and MCP data.
- Add `--json` for the CLI's own structured outputs; keep upstream MCP text as an explicitly labeled field.
- Compile a standalone executable with `bun build --compile` if MCP child-process packaging remains reliable; otherwise distribute the Bun project plus a setup command for the pinned server.
- Document installation, updating sources, planning, replacement, and troubleshooting.

## 12. Test strategy

Unit tests:

- Every hard and soft constraint.
- Vegetarian minimum.
- Keep-warm/reheat and Thursday time filtering.
- Sunday batch/prep qualification.
- Deterministic seeded plans.
- Replacement invariants and grocery deltas.
- Cross-recipe ingredient aggregation, package remainder estimates, perishability penalties, and pantry consumption.
- A waste-reducing plan beats a nominally cheaper plan that leaves more perishable food unused.
- Deal scoring includes only REMA 1000, Netto, and SuperBrugsen and rejects offers expiring before shopping.
- Ingredient normalization and duplicate detection.

Fixture tests:

- JSON-LD extraction for each supported source.
- Missing/malformed fields.
- Source markup changes produce a clear failure rather than corrupt data.

Integration tests:

- SQLite migrations and transaction rollback.
- MCP initialize and tool-schema compatibility against the pinned server.
- Fake MCP results for success, no deals, low-confidence matches, timeout, and `isError`.
- An opt-in live deal test that is not required for normal CI.

End-to-end tests:

- Fresh `setup` through accepted plan and grocery list in a temporary home/data directory.
- Add and sync a generic source.
- Replace Tuesday and prove the other six meals remain identical.
- Continue producing a non-deal grocery list when MCP is unavailable.

## 13. Acceptance criteria

1. The application starts with `bun run src/cli.ts` and has a documented short command.
2. First-run setup captures household size, restrictions, disliked ingredients, pantry, and day rules, with REMA 1000, Netto, and SuperBrugsen preselected.
3. On Friday or Saturday, the CLI can create the following Monday–Sunday plan and prepare its grocery list for Saturday shopping.
4. A seven-day plan obeys all hard daily and household constraints.
5. Every generated week contains at least one vegetarian dinner.
6. Tuesday and Wednesday meals support a late arrival; Thursday never exceeds 30 minutes.
7. Sunday is explicitly marked as batch cooking or linked preparation.
8. Every recipe shows its original source URL.
9. The six initial sources are configurable, not embedded in planning logic.
10. A new compatible JSON-LD source can be added, tested, enabled, disabled, synced, and removed from the CLI.
11. Replacing one rejected recipe leaves all six other meal assignments unchanged.
12. The grocery list is recalculated after replacement and shows ingredient, deal, and predicted-waste changes.
13. The weekly optimizer prefers shared ingredients and lower expected waste before deal savings, and explains meaningful reuse between recipes.
14. Current deals from only the three preferred shops influence recipe selection when they remain valid for Saturday shopping.
15. Grocery generation calls TilbudsTrolden and preserves store, expiry, regular-price, and low-confidence information.
16. Network or deal-provider failure does not destroy a saved plan and still yields a plain ingredient list.
17. Automated tests cover planning, waste scoring, source parsing, atomic replacement, persistence, MCP compatibility, and the main end-to-end flow.

## 14. Known risks to address early

- Recipe websites can change markup or block automated fetching. Prefer standard JSON-LD, keep fixtures, rate-limit requests, and isolate site adapters.
- Dietary tags inferred from page metadata can be incomplete. Validate ingredients and require review when uncertain.
- TilbudsTrolden 0.5.3 returns text, not structured shopping data. Avoid parsing it as a long-term contract.
- TilbudsTrolden's household restrictions and schedules are stored but not automatically enforced by all planning tools. Enforce them locally.
- Deal prices omit unmatched ingredients and are estimates, not guaranteed basket totals.
- TilbudsTrolden is not currently published to npm. Pin its Git repository revision and provide a reproducible setup step.
