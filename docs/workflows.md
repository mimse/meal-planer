# Planning workflow

## 1. Configure the household

```sh
mealplan setup
mealplan family show
mealplan pantry show
```

For automation, use the JSON-valued setup flags documented in the main README. Setup defaults to REMA 1000, Netto, SuperBrugsen, all seven day profiles, and the six built-in recipe sources.

## 2. Import and review recipes

```sh
mealplan sources sync --limit 50
mealplan recipes search --needs-review
mealplan recipes show <recipe-id>
mealplan recipes review <recipe-id> [review options] --mark-reviewed
```

The planner excludes recipes whose evidence cannot prove the configured hard constraints.

## 3. Create and accept next week

```sh
mealplan plan create --week next --seed family
mealplan plan show --week next
mealplan plan accept --week next
```

`next` means the following Monday–Sunday week in the Copenhagen calendar. The shopping date is the preceding Saturday. Plan creation saves a draft; shopping always uses the accepted plan.

Use `--no-deals` for deterministic offline planning. Provider failure also falls back to local planning with a warning and never relaxes household or day constraints.

## 4. Replace one meal

Preview interactively:

```sh
mealplan plan replace tuesday --week next
```

Automate in two steps:

```sh
mealplan plan replace tuesday --week next --preview --json
mealplan plan replace tuesday --week next \
  --with <recipe-id> --yes --rejection not-this-week --json
```

A confirmed replacement revalidates the whole accepted snapshot in one transaction, changes only the selected stable meal record, and preserves the other six IDs and hashes. Use `disliked` instead of `not-this-week` only for a persistent preference override.

## 5. Generate groceries

```sh
mealplan shopping-list --week next --refresh-deals
mealplan shopping-list --week next --no-deals --json
```

The list is regenerated from the seven accepted assignments. It scales production servings, applies measured pantry quantities and verified prep links, retains source provenance, and shows matched estimates separately from unknown regular prices. Its subtotal is not a checkout total.

## Automation

Commands that produce structured domain output support `--json`. Warnings remain on stderr so stdout stays parseable. A non-zero exit denotes validation, integration, or partial-source failure; do not ignore it even when stdout contains a report.
