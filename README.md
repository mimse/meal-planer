# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

The Phase 0 integration-evidence milestone and Phase 1 local setup are complete. The first Phase 2 increment adds durable, validated recipe-ingestion persistence with deterministic deduplication and preserved source evidence. Recipe probing/synchronization, source adapters beyond the existing inspection path, recipe CLI commands, and meal planning remain later work.

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
bun run src/cli.ts sources enable|disable|remove <source-id>
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

Recipe-source IDs are stable identifiers; omit `--id` to derive one from the URL. Supported configuration adapters are `auto`, `jsonld`, `microdata`, and `spisbedre-inertia`. Duplicate IDs and canonical base URLs are rejected. A source with imported recipes may be disabled, but removal is blocked so recipe provenance remains valid. Source addition still saves configuration only: it does not probe, fetch, extract, or synchronize recipes. `sources test` and `sources sync` remain Phase 2 work and are intentionally absent rather than reporting a fabricated compatibility result. Store dealer IDs are likewise deliberately left unresolved until deal-provider integration; setup makes no live MCP calls.

The database path is resolved in this order:

1. Global `--database <path>`.
2. `MEALPLAN_DATABASE`.
3. `$XDG_DATA_HOME/mealplaner/mealplan.sqlite`, or `~/.local/share/mealplaner/mealplan.sqlite` when `XDG_DATA_HOME` is unset.

Relative explicit or environment paths are resolved from the current working directory. Parent directories are created only by commands that use the database.

See `PLAN.md` for the implementation plan, `DESIGN.md` for the domain and CLI design, and `docs/phase-0.md` for verified integration findings.
