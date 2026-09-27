# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

The Phase 0 integration-evidence milestone is complete, and the first Phase 1 vertical slice now provides persistent local setup and family configuration. Recipe ingestion, pantry commands, and meal planning remain later-phase work.

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
bun run src/cli.ts recipes inspect <recipe-url> --json
bun run src/cli.ts integrations verify-deals --json
```

`setup` and `family edit` prompt interactively when no mutation flags are supplied. For automation, pass repeatable JSON objects rather than delimiter-separated values:

```sh
bun run src/cli.ts --database ./state/mealplan.sqlite setup \
  --member '{"id":"alex","name":"Alex","kind":"adult","servings":1}' \
  --member '{"id":"sam","name":"Sam, Jr.","kind":"child","servings":0.75}' \
  --household-dietary-restriction 'No peanuts, tree nuts; sesame' \
  --household-disliked-ingredient 'Olives, capers; anchovies'

bun run src/cli.ts --database ./state/mealplan.sqlite family edit \
  --upsert-member '{"id":"alex","name":"Alexandra","kind":"adult","servings":1.25}' \
  --upsert-rule '{"memberId":"alex","kind":"disliked_ingredient","value":"Fennel, raw"}'
```

Use `--update-rule '{"id":"<existing-id>","memberId":null,"kind":"dietary_restriction","value":"new text"}'`, `--remove-member <id>`, and `--remove-rule <id>` for updates and removals; stable rule IDs are available from `family show --json`. Setup defaults to REMA 1000, Netto, and SuperBrugsen, the seven planned day profiles, and all six built-in recipe sources. Rerunning setup replaces setup-managed members, rules, day profiles, stores, and recipe sources while retaining pantry items. Store dealer IDs are deliberately left unresolved until deal-provider integration; setup makes no live MCP calls.

The database path is resolved in this order:

1. Global `--database <path>`.
2. `MEALPLAN_DATABASE`.
3. `$XDG_DATA_HOME/mealplaner/mealplan.sqlite`, or `~/.local/share/mealplaner/mealplan.sqlite` when `XDG_DATA_HOME` is unset.

Relative explicit or environment paths are resolved from the current working directory. Parent directories are created only by commands that use the database.

See `PLAN.md` for the implementation plan, `DESIGN.md` for the domain and CLI design, and `docs/phase-0.md` for verified integration findings.
