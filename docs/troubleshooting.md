# Troubleshooting

## The pinned deal server is missing or unbuilt

Run:

```sh
git submodule update --init --recursive
bun run setup:runtime
```

The runtime requires TilbudsTrolden 0.5.3, its built `dist/server.js`, installed Node dependencies, and `node` on `PATH`.

For a relocated project distribution, point to the built sidecar directory:

```sh
export MEALPLAN_TILBUDSTROLDEN_DIR=/absolute/path/to/vendor/tilbudstrolden-mcp
mealplan integrations verify-deals --json
```

An invalid override fails closed and is not silently replaced with another checkout.

## MCP compatibility or startup failure

Run the production resolver check:

```sh
mealplan integrations verify-deals --json
```

If startup, timeout, identity, or schema validation fails, `plan create` and `shopping-list` retain local behavior and emit an offline warning. They do not erase or reschedule a saved plan. Re-run `bun run setup:runtime` after updating the project or submodule.

## Commands behave differently outside the project directory

Use the built `mealplan` link or an absolute path to `dist/cli.js`. The production sidecar resolver is based on the bundle location, not the current working directory. Set `MEALPLAN_TILBUDSTROLDEN_DIR` only when the sidecar is stored elsewhere.

## Database location or setup errors

Path precedence is:

1. `--database <path>`
2. `MEALPLAN_DATABASE`
3. `$XDG_DATA_HOME/mealplaner/mealplan.sqlite`
4. `~/.local/share/mealplaner/mealplan.sqlite`

`family show`, recipe reads, and plan reads never initialize missing state. Run `mealplan setup` against the intended path. Do not point mealplan at an unrelated SQLite file.

For suspected corruption, do not rerun setup over the file. Preserve it, restore the newest verified bundle into a new directory, and activate the recovered path as described in `backup-and-recovery.md`.

## A source is partial, failed, or blocked

Use a bounded JSON retry:

```sh
mealplan sources test <source-id> --json
mealplan sources sync <source-id> --limit 5 --json
```

Typical causes are robots/sitemap changes, markup drift, non-public DNS, redirects outside configured scope, unsupported content types, or incomplete Recipe metadata. Successful imports survive partial failures. Do not weaken URL safety checks.

## A recipe cannot be planned

Inspect it for `needsReview`, missing duration, servings, dietary classification, ingredients, serving mode, easy classification, or Sunday yield/prep evidence:

```sh
mealplan recipes show <recipe-id>
mealplan recipes review <recipe-id> [review options] --mark-reviewed
```

The planner reports blocking hard constraints and does not assume missing evidence is safe.

## Shopping totals look incomplete

Only reliable matched offers contribute automatic estimates. Unknown regular prices, low-confidence matches, uncertain quantities, and unknown package evidence remain explicit. The displayed subtotal is a matched-offer estimate, never a checkout total.
