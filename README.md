# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

Phases 0–7 implement integration evidence, durable local setup and recipe ingestion, family-aware weekly planning, atomic one-day replacement, accepted-plan grocery aggregation, verified backup/recovery, planner property checks, MCP contract checks, project distribution hardening, source archival, explicit Friday/Saturday cycle coverage, and a deterministic public-CLI acceptance workflow. The Phase 2 live-source exit criterion has not been reverified against all six current websites.

## Installation

The supported distribution is the Bun project plus its pinned Node.js TilbudsTrolden sidecar. A standalone compiled executable remains experimental because it does not package that sidecar or its dependencies.

```sh
git clone --recurse-submodules https://github.com/mimse/meal-planer.git
cd meal-planer
bun run setup:runtime
bun link
mealplan --help
```

See `docs/installation.md` for upgrades, relocated installations, requirements, and verification.

## Development

Requires Bun 1.4 or newer and Node.js 18 or newer.

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
bun run vendor:install
bun run verify
bun run smoke:runtime
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
bun run src/cli.ts plan create [--week next|YYYY-MM-DD] [--seed <value>] [--no-deals] [--json]
bun run src/cli.ts plan show [--week next|YYYY-MM-DD] [--json]
bun run src/cli.ts plan accept [--week next|YYYY-MM-DD] [--json]
bun run src/cli.ts plan replace <day> [--week next|YYYY-MM-DD] [--preview] [--no-deals] [--json]
bun run src/cli.ts plan replace <day> --with <recipe-id> --yes [--rejection not-this-week|disliked|none] [--no-deals] [--json]
bun run src/cli.ts plan lock|unlock <day> [--week next|YYYY-MM-DD] [--json]
bun run src/cli.ts shopping-list [--week next|YYYY-MM-DD] [--refresh-deals|--no-deals] [--json]
bun run src/cli.ts backup create <new-bundle-directory> [--mcp-data <persistent-json>] [--json]
bun run src/cli.ts backup restore <bundle-directory> --to <new-state-directory> [--json]
bun run src/cli.ts recipes prep-link <recipe-id> --target-meal <id> --ingredient <name> --quantity <n> --unit g|ml|stk --note <text> [--kind prep|leftover] [--json]
bun run src/cli.ts recipes remove-prep-link <link-id>
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

Recipe-source IDs are stable identifiers; omit `--id` to derive one from the URL. Supported configuration adapters are `auto`, `jsonld`, `microdata`, and `spisbedre-inertia`. The production extraction registry maps the six built-ins to four generic JSON-LD adapters, Valdemarsro microdata, and SPIS BEDRE Inertia; `auto` selects those custom adapters by host and otherwise falls back to JSON-LD. Extracted output is bounded and runtime-validated before use. Duplicate IDs and canonical base URLs are rejected. A source with imported recipes may be disabled. `sources remove` deletes an unreferenced source but archives a referenced source, disabling and hiding it from active listing, sync, and planning while preserving imported recipes and provenance. Re-adding the same stable ID and original base URL reactivates it; rebinding that ID to another URL is refused. Source addition saves configuration only. `sources test` probes bounded discovery without extracting or persisting; `sources sync` imports from one enabled source or every enabled source in source-ID order. Its `--limit` is a per-source recipe-page maximum from 1 to 100 (default 50), and one recipe or source failure does not discard successful imports. `attempted` counts recipe-page URL attempts, `failed` counts failed attempts, and `imported` counts distinct persisted recipe IDs per source, so aliases can make `attempted` differ from `imported + failed`; aggregate imports sum those per-source distinct counts. Per-source status is `completed` only with zero failures, `partial` for mixed success and failure, and `failed` for discovery failure or when every attempted import fails. Sync reuses one conditional cache and host limiter, emits bounded failures, and exits nonzero if any source or recipe fails.

`recipes import` accepts only HTTP(S) URLs without credentials, fragments, or malformed percent escapes that match one enabled configured source (or an explicit `--source`) and its site/path policy. Custom recipe candidates and imports are restricted to their configured base path using a single conservative path validator that rejects encoded separators, traversal, decoded backslashes, and double-decode ambiguity; same-site root `robots.txt` and sitemap routes remain fetchable metadata. Exact built-in source identities are host-scoped because their verified recipe pages are not necessarily descendants of their discovery seed: Julie Bruun's configured `/category/opskrifter/` base is a category seed, while the verified fixture is `/flaeskesteg-i-airfryer/`. Arbitrary same-site pages still must pass the full validated Recipe extractor before persistence. Fetches retain DNS pinning, redirect revalidation, host/SNI, response-size limits, configured-source scope, and cache/rate-limit behavior.

Imports preserve raw extraction payload, ingredient order, and raw lines exactly. Unambiguous metric and explicit piece quantities normalize to `g`, `ml`, and `stk`, including kg/l conversion, decimal commas, and fractions. Ranges, approximate quantities, packages, cups/spoons, and implicit counts remain uncertain rather than being guessed. `recipes review --ingredients-json` accepts an array of `{rawText, normalizedName, quantity, unit, uncertain}` objects; it replaces the reviewed ingredient list without changing the raw source payload. Source refresh updates extracted defaults and provenance while preserving explicitly reviewed fields, including ingredients. The bounded `reviewOverrides` list tracks those edits. Identity resolution includes normalized source URLs within one source; incomplete refreshed evidence reopens review. Review can replace or clear classification tags, servings, and durations; duplicate singleton flags and guaranteed-incomplete `--mark-reviewed` combinations fail before SQLite opens. Preferences use `recipes review --preference favorite|neutral|disliked`; dedicated like/dislike shortcuts are not implemented. `recipes inspect` remains a generic JSON-LD diagnostic and does not persist. Setup makes no live MCP calls; planning resolves store dealer IDs afresh.

## Weekly planning

After setup and recipe import/review, use `plan create --week next --seed family` to save a Monday–Sunday draft. `next` resolves to the following Monday using the Copenhagen calendar; Friday and Saturday both select the immediately following Monday and its preceding Saturday shopping date. An explicit date selects its containing week. `plan show` prefers the current draft, and `plan accept` persists acceptance and records the scheduled recipes in meal history. Generating another draft replaces the previous draft for that week without deleting accepted plans. Selection is deterministic for identical inputs and seed; timestamps and persisted plan IDs can differ between CLI runs.

Candidates exclude unreviewed, disabled-source, disliked, and rejected-for-this-week recipes and must satisfy configured time, serving-mode, easy-meal, dietary, and extra-yield rules. Every generated week contains seven distinct recipes and at least one vegetarian/vegan meal. Set Sunday batch yield with `recipes review <id> --extra-meal-servings <n>`; this is the number of extra servings beyond dinner, not the number of additional meals. Production demand includes those servings. A `prepAhead` tag alone cannot substitute for batch yield: create an explicit measured `recipes prep-link` to a real saved future meal. Links validate active target membership, reviewed compatible ingredient evidence, total target allocation, and aggregate leftover allocations against source yield. Saving binds each reservation to one Sunday cooking occurrence; other weeks and weekday occurrences cannot claim it again. Linked endpoints are conservatively protected from replacement, and referenced links cannot be removed. An atomic detach/revalidation workflow is not implemented yet; do not create links you expect to edit through replacement.

The scorer aggregates measured ingredient quantities, rewards reuse and pantry consumption, and ranks waste before offer coverage, recent-use avoidance, variety, and favorites. `plan create` fetches live deals and package estimates from the pinned MCP server in an isolated private session. Only configured chains, valid shopping-date offers, and reliable matches contribute. Offer value means matched-ingredient coverage, not monetary savings or a complete checkout total. Uncertain quantities and unknown perishability assumptions are warned explicitly. Provider failures fall back to local planning; `--no-deals` disables lookup entirely. Past shopping dates produce a warning. An exact distinct-recipe feasibility witness protects hard constraints from beam pruning; score optimization remains heuristic, not globally optimal. Dietary classification and literal ingredient matching are not a certified allergen check: review ingredient evidence and do not rely on free-text restrictions for medical safety.

## Replacing one meal

`plan replace thursday --week next` offers ranked candidates interactively on a terminal, shows ingredient additions/removals and deal/waste deltas, asks how to record the rejected recipe, and requires confirmation. `--preview`, `--json` without `--yes`, and noninteractive invocations are read-only. For automation, preview first, then use `--with <recipe-id> --yes`. `--rejection not-this-week` is the default; `disliked` persists a preference override across source refresh, and `none` stores no rejection. Use `plan lock|unlock <day>` for explicit locks.

Confirmation checks the full original plan, current-week identity, and live recipe/configuration/prep evidence inside one SQLite transaction. Exactly one meal changes; its stable ID and the other six records/hashes are preserved. Accepted target history, the score, rejection state, and revision audit update atomically. Changed or locked targets, stale previews, and invalid candidates fail without partial writes. The next `shopping-list` invocation reaggregates the accepted seven assignments, including a confirmed replacement; an unaccepted new draft does not replace the accepted shopping plan.

## Grocery lists

Run `shopping-list --week next --refresh-deals` after accepting the plan. Every invocation rebuilds from the accepted meals and fetches fresh offers by default; `--refresh-deals` makes that intent explicit, and `--no-deals` performs no provider I/O. Invalid/repeated week arguments and contradictory refresh/offline flags fail before SQLite opens. Lists are read-only derived output, not cached inventory records: generating a list never consumes pantry stock or changes meals/history, and a concurrent change to accepted assignments, recipes, pantry, household or relevant prep evidence refuses the stale result.

Quantities use each saved meal's actual production servings, including Sunday's extra batch portions. Compatible measured pantry quantities are deducted once per ingredient/unit; incompatible units remain separate and uncertain raw lines stay visible for review, with their source recipes and URLs. Extra ingredient prep adds demand to its bound Sunday producer; leftovers already included in batch servings are not added twice. Incoming prep/leftover quantities are deducted only when a unique earlier accepted Sunday producer and current evidence validate the saved target link. Those are planned transfers, not proof that food was cooked or safely stored; warnings request verification. Pantry quantities describe current user-maintained stock and are not automatically reserved across different weeks.

The isolated pinned MCP session receives the household, configured live store identities, pantry and exactly seven scaled saved meal payloads. Upstream name-only pantry skipping is disabled; local quantitative deductions remain authoritative. Output groups valid preferred-store matches, regular-price/unmatched purchases and fully pantry/prep-covered ingredients. Offers include package and unit-price evidence when known, validity dates, confidence and retrieval time. High-confidence measured pack evidence drives local pack counts, estimated costs, final remainder and the named later recipes consuming earlier package remainders. Storage life is not inferred. Low-confidence, unknown-pack and unknown-price offers require review and never contribute automatic price estimates. Provider/schema/startup/timeout failures retain the complete local list with explicit warnings.

`--json` writes one structured list to stdout; warnings also go to stderr. Its `totals.isComplete` means every purchase has a matched estimate, not that a checkout price is guaranteed. The subtotal always excludes unknown regular prices and is never a checkout total. Raw TilbudsTrolden text is retained under `provider` as clearly labelled unfiltered diagnostics; human recommendations use validated structured matches rather than reproducing possibly expired or unconfigured offers from that text.

The database path is resolved in this order:

1. Global `--database <path>`.
2. `MEALPLAN_DATABASE`.
3. `$XDG_DATA_HOME/mealplaner/mealplan.sqlite`, or `~/.local/share/mealplaner/mealplan.sqlite` when `XDG_DATA_HOME` is unset.

Relative explicit or environment paths are resolved from the current working directory. Parent directories are created only by commands that use the database.

Operational guides:

- `docs/installation.md`: install, upgrade, runtime layout, and verification.
- `docs/source-management.md`: add, test, synchronize, review, disable, and remove sources.
- `docs/workflows.md`: setup through accepted plan, replacement, and grocery list.
- `docs/backup-and-recovery.md`: verified bundle creation and new-directory restore.
- `docs/troubleshooting.md`: sidecar, source, database, planner, and shopping failures.

See `PLAN.md` for the implementation plan, `DESIGN.md` for the domain and CLI design, and `docs/phase-0.md` for verified integration findings.
