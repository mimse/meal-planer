# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

The Phase 0 integration-evidence milestone and Phase 1 local setup are complete. Phase 2 includes durable recipe ingestion, safe bounded discovery, source synchronization, deterministic search/show, and noninteractive review. The first Phase 3 slice adds a seeded weekly planner, waste/reuse scoring, persisted drafts, acceptance, and meal-history tracking. Phase 3 is not complete: explicit preparation links, production ingredient normalization, and live package/deal inputs remain outstanding. The Phase 2 live-source exit criterion has not been reverified against all six current websites.

## Development

Requires Bun 1.4 or newer and Node.js 18 or newer.

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run vendor:install
bun run test
bun run typecheck
bun run build
bun run src/cli.ts --help
```

The implemented commands are:

```sh
bun run src/cli.ts setup
bun run src/cli.ts family show [--json]
bun run src/cli.ts family edit
bun run src/cli.ts pantry show [--json]
bun run src/cli.ts pantry add [--item <json> ...]
bun run src/cli.ts pantry remove [name ...]
bun run src/cli.ts sources list [--json]
bun run src/cli.ts sources add <base-url> [--id <id>] [--name <name>] [--adapter <adapter>]
bun run src/cli.ts sources test <source-id> [--json]
bun run src/cli.ts sources sync [source-id] [--limit <n>] [--json]
bun run src/cli.ts sources enable|disable|remove <source-id>
bun run src/cli.ts recipes search [query] [--source <source-id>] [--tag <dietary-tag>] [--needs-review] [--limit <n>] [--json]
bun run src/cli.ts recipes show <recipe-id> [--json]
bun run src/cli.ts recipes import <recipe-url> [--source <source-id>] [--json]
bun run src/cli.ts recipes review <recipe-id> [review options] [--mark-reviewed] [--json]
bun run src/cli.ts plan create [--week next|YYYY-MM-DD] [--seed <value>] [--json]
bun run src/cli.ts plan show [--week next|YYYY-MM-DD] [--json]
bun run src/cli.ts plan accept [--week next|YYYY-MM-DD] [--json]
bun run src/cli.ts recipes inspect <recipe-url> --json
bun run src/cli.ts integrations verify-deals --json
```

`setup` and `family edit` prompt interactively when no mutation flags are supplied. For automation, pass repeatable JSON objects rather than delimiter-separated values:

```sh
bun run src/cli.ts --database ./state/mealplan.sqlite setup \
  --member '{"id":"alex","name":"Alex","kind":"adult","servings":1}' \
  --member '{"id":"sam","name":"Sam, Jr.","kind":"child","servings":0.75}' \
  --household-dietary-restriction 'No peanuts, tree nuts; sesame' \
  --household-disliked-ingredient 'Olives, capers; anchovies' \
  --pantry-item '{"name":"Rice","quantity":"500 g"}'

bun run src/cli.ts --database ./state/mealplan.sqlite family edit \
  --upsert-member '{"id":"alex","name":"Alexandra","kind":"adult","servings":1.25}' \
  --upsert-rule '{"memberId":"alex","kind":"disliked_ingredient","value":"Fennel, raw"}'

bun run src/cli.ts --database ./state/mealplan.sqlite pantry add \
  --item '{"name":"Chickpeas","quantity":"2 cans"}' \
  --item '{"name":"Rice","quantity":"ca. 500 g"}'

bun run src/cli.ts --database ./state/mealplan.sqlite pantry remove Rice Chickpeas

bun run src/cli.ts --database ./state/mealplan.sqlite sources add https://recipes.example/ \
  --id example-recipes --name 'Example Recipes' --adapter auto
bun run src/cli.ts --database ./state/mealplan.sqlite sources disable example-recipes
```

Use `--update-rule '{"id":"<existing-id>","memberId":null,"kind":"dietary_restriction","value":"new text"}'`, `--remove-member <id>`, and `--remove-rule <id>` for updates and removals; stable rule IDs are available from `family show --json`. Setup defaults to REMA 1000, Netto, and SuperBrugsen, the seven planned day profiles, and all six built-in recipe sources. Interactive setup can collect pantry staples, and `--pantry-item` is repeatable for automation. Rerunning setup replaces setup-managed members, rules, day profiles, stores, and recipe sources; it never deletes pantry items, and supplied pantry items are validated together and upserted by normalized name in the same setup transaction.

`pantry add` and `pantry remove` prompt when mutation arguments are omitted. Pantry names use Unicode- and whitespace-normalized identity while display names and quantity text are retained. Multi-item additions and removals are atomic, and removing any unknown name fails without deleting known items.

Recipe-source IDs are stable identifiers; omit `--id` to derive one from the URL. Supported configuration adapters are `auto`, `jsonld`, `microdata`, and `spisbedre-inertia`. The production extraction registry maps the six built-ins to four generic JSON-LD adapters, Valdemarsro microdata, and SPIS BEDRE Inertia; `auto` selects those custom adapters by host and otherwise falls back to JSON-LD. Extracted output is bounded and runtime-validated before use. Duplicate IDs and canonical base URLs are rejected. A source with imported recipes may be disabled, but removal is blocked so recipe provenance remains valid. Source addition saves configuration only. `sources test` probes bounded discovery without extracting or persisting; `sources sync` imports from one enabled source or every enabled source in source-ID order. Its `--limit` is a per-source recipe-page maximum from 1 to 100 (default 50), and one recipe or source failure does not discard successful imports. `attempted` counts recipe-page URL attempts, `failed` counts failed attempts, and `imported` counts distinct persisted recipe IDs per source, so aliases can make `attempted` differ from `imported + failed`; aggregate imports sum those per-source distinct counts. Per-source status is `completed` only with zero failures, `partial` for mixed success and failure, and `failed` for discovery failure or when every attempted import fails. Sync reuses one conditional cache and host limiter, emits bounded failures, and exits nonzero if any source or recipe fails.

`recipes import` accepts only HTTP(S) URLs without credentials, fragments, or malformed percent escapes that match one enabled configured source (or an explicit `--source`) and its site/path policy. Custom recipe candidates and imports are restricted to their configured base path using a single conservative path validator that rejects encoded separators, traversal, decoded backslashes, and double-decode ambiguity; same-site root `robots.txt` and sitemap routes remain fetchable metadata. Exact built-in source identities are host-scoped because their verified recipe pages are not necessarily descendants of their discovery seed: Julie Bruun's configured `/category/opskrifter/` base is a category seed, while the verified fixture is `/flaeskesteg-i-airfryer/`. Arbitrary same-site pages still must pass the full validated Recipe extractor before persistence. Fetches retain DNS pinning, redirect revalidation, host/SNI, response-size limits, configured-source scope, and cache/rate-limit behavior. Imports preserve raw extraction payload and provenance, keep ingredient order, and leave normalized ingredient name, quantity, and unit null rather than guessing. New recipes use extraction defaults. Source reimports refresh extraction-owned defaults and evidence while preserving only planner fields explicitly changed or cleared through `recipes review`; the bounded `reviewOverrides` provenance list is retained with source evidence. Identity resolution also matches normalized source URLs within the same configured source, so changed titles and canonical URLs update one row without cross-source source-URL merges. Refreshed source ingredients and merged planner fields determine completeness; incomplete evidence reopens review, and refresh never clears an existing review decision. `recipes review` can replace or explicitly clear classification tags, servings, and durations while preserving extraction provenance and ordered evidence; repeated singleton flags and guaranteed-incomplete `--mark-reviewed` combinations fail before the database opens. Clearing planning-critical evidence sets `needsReview`, and `--mark-reviewed` enforces completeness atomically. `recipes like`/`dislike` remain deferred to Phase 3; use `recipes review --preference favorite|disliked` meanwhile. The existing `recipes inspect` command remains a generic JSON-LD diagnostic and does not persist. Store dealer IDs are likewise deliberately left unresolved until deal-provider integration; setup makes no live MCP calls.

## Weekly planning

After setup and recipe import/review, use `plan create --week next --seed family` to save a Monday–Sunday draft. `next` resolves to the following Monday using the Copenhagen calendar; an explicit date selects its containing week. Shopping is dated the Saturday before the planned Monday. `plan show` prefers the current draft, and `plan accept` persists acceptance and records the scheduled recipes in meal history. Generating another draft replaces the previous draft for that week without deleting accepted plans. Selection is deterministic for identical inputs and seed; timestamps and persisted plan IDs can differ between CLI runs.

Candidates exclude unreviewed, disabled-source, and disliked recipes and must satisfy configured time, serving-mode, easy-meal, dietary, and extra-yield rules. Every generated week contains seven distinct recipes and at least one vegetarian/vegan meal. Set Sunday batch yield with `recipes review <id> --extra-meal-servings <n>`; this is the number of extra servings beyond dinner, not the number of additional meals. A `prepAhead` tag alone does not establish an explicit prep link and cannot substitute for batch yield yet. Preferences can be set with `recipes review <id> --preference favorite|neutral|disliked`; dedicated like/dislike shortcuts are not implemented.

The scorer aggregates reliably normalized ingredient quantities, rewards reuse and pantry consumption, and ranks waste before deal value. Package estimates and deal signals are supported by the application/domain APIs, but CLI planning does not yet fetch them. Imported ingredients currently retain uncertain raw lines, so their quantities are not guessed or scored and appear as warnings. Dietary classification and literal ingredient matching are not a certified allergen check: review ingredient evidence and do not rely on free-text restrictions for medical safety. The bounded beam search is heuristic, not an exhaustive optimizer. Explicit Sunday prep/leftover links, ingredient normalization, live deals, shopping-window warnings, replacement, and shopping-list generation remain future work.

The database path is resolved in this order:

1. Global `--database <path>`.
2. `MEALPLAN_DATABASE`.
3. `$XDG_DATA_HOME/mealplaner/mealplan.sqlite`, or `~/.local/share/mealplaner/mealplan.sqlite` when `XDG_DATA_HOME` is unset.

Relative explicit or environment paths are resolved from the current working directory. Parent directories are created only by commands that use the database.

See `PLAN.md` for the implementation plan, `DESIGN.md` for the domain and CLI design, and `docs/phase-0.md` for verified integration findings.
