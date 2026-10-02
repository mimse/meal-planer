# Source management

## List and inspect sources

Setup enables the six built-in Danish recipe sources. List their stable IDs before changing them:

```sh
mealplan sources list
mealplan sources list --json
```

Built-in identities are site-scoped. Custom sources are restricted to their configured base path for recipe pages and redirects.

## Add a compatible source

```sh
mealplan sources add https://recipes.example/ \
  --id example-recipes \
  --name "Example Recipes" \
  --adapter jsonld
mealplan sources test example-recipes
mealplan sources sync example-recipes --limit 25
```

Use `auto` or `jsonld` for a standard Schema.org Recipe source. `sources test` checks bounded discovery only; it does not extract or persist recipes. `sources sync` performs extraction and persistence.

## Interpret synchronization results

- `completed`: every attempted recipe page imported successfully.
- `partial`: some recipes imported and some attempts failed.
- `failed`: discovery failed or every attempted recipe import failed.

`attempted` counts recipe-page URLs, while `imported` counts distinct persisted recipe IDs. Canonical aliases can therefore make those totals differ. Any partial or failed source causes a non-zero command exit so automation cannot mistake partial work for success.

Retry a failed source with a small limit and JSON output:

```sh
mealplan sources sync example-recipes --limit 5 --json
```

Failures are isolated per source and recipe; successful imports remain committed.

## Review refreshed recipes

Search for records reopened for review after source changes:

```sh
mealplan recipes search --needs-review
mealplan recipes show <recipe-id>
mealplan recipes review <recipe-id> [review options] --mark-reviewed
```

A refresh updates source-owned evidence and preserves only explicit review overrides. Never mark a recipe reviewed unless servings, ingredient evidence, at least one duration, and dietary classification are complete.

## Enable, disable, and remove

```sh
mealplan sources disable example-recipes
mealplan sources enable example-recipes
mealplan sources remove example-recipes
```

Disabling a source prevents new planning candidates without deleting imported recipes or provenance. Removal is blocked while imported recipes reference the source.

## Safety boundaries

Recipe fetches allow only public HTTP(S) destinations, pin validated DNS addresses to sockets, revalidate every redirect, enforce configured source scope, limit response sizes, and require HTML. Do not bypass these checks to make a blocked source import; use the reported unsupported or blocked reason to diagnose the source instead.
