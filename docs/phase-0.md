# Phase 0 integration findings

This document records the completed Phase 0 integration-evidence milestone in `PLAN.md`: the tracer CLI paths, pinned MCP contract, source probes, and deterministic representative recipe fixtures. Production ingestion adapters, persistence, and planning remain later-phase work.

Verified on 2026-09-27. Live offer contents are time-sensitive; adapter behavior and identifiers are pinned where noted.

## TilbudsTrolden MCP

Pinned Git submodule: `vendor/tilbudstrolden-mcp` at fork commit `cf01aac46efb5808d2cdffd6c2c19b96bb0ceabf`, based on upstream commit `ad18454bb9bb187f7ac51b7ec9f6a0d22555d5cb` (server version 0.5.3).

Verification results:

- `npm ci`, build, and all 405 provider Vitest tests pass under Node 24.
- The Meal Planer MCP client connects over stdio and sees 18 tools.
- Required tools are present: `list_stores`, `update_household`, `update_pantry`, `add_recipe`, `score_recipes`, and `generate_shopping_list`.
- `score_recipes` and `generate_shopping_list` advertise validated output schemas and return structured data alongside unchanged text content.
- The Meal Planer adapter validates the advertised schemas and every received structured field, preserves the provider text, and stamps receipt time locally.
- A live `search_deals` call for `mælk` returned five offers.
- The default curated `list_stores` response contains REMA 1000 and Netto but omits SuperBrugsen.
- `list_stores {"all":true}` returns the full Danish directory and resolves the configured stores as:
  - REMA 1000: `11deC`
  - Netto: `9ba51`
  - SuperBrugsen: `0b1e8`

The application must query the full Danish directory during setup instead of relying on the curated default list. Dealer IDs remain runtime-discovered values; the values above are evidence, not hard-coded configuration.

The pinned server retains human-readable MCP `content` for compatibility. Meal Planer consumes `structuredContent` for scoring and shopping-list data and does not parse the text into domain values.

## Recipe-source probes

All six representative pages and their public discovery endpoints returned HTTP 200.

| Source | Representative page | Discovery | Extraction |
| --- | --- | --- | --- |
| Valdemarsro | https://www.valdemarsro.dk/kage-med-rabarber/ | `sitemap_index.xml` → `post-sitemap*.xml` | Schema.org Recipe microdata fallback; no Recipe JSON-LD on the tested page |
| Gourministeriet | https://gourministeriet.dk/frikadeller-med-perlebygsalat-broccoli-og-feta/ | flat `sitemap.xml` | generic Recipe JSON-LD |
| SPIS BEDRE | https://spisbedre.dk/opskrifter/3-slags-pindemadder | paginated `/opskrifter/sitemap.xml?page=N` | source adapter for Inertia `#app[data-page]` → `props.recipe` |
| Julie Bruun | https://juliebruun.com/flaeskesteg-i-airfryer/ | `sitemap_index.xml` → `post-sitemapN.xml` | generic Recipe JSON-LD |
| Julie Karla | https://www.juliekarla.dk/opskrift-bladbeder-figner-pinjekerner/ | `sitemap.xml` → `post-sitemap.xml` | generic Recipe JSON-LD |
| Mummum | https://mummum.dk/opskrift-paa-nemme-croutoner/ | production `sitemap_index.xml` → `post-sitemap*.xml` | generic Recipe JSON-LD |

The built-in registry in `src/adapters/recipes/sources.ts` records these adapter decisions. The generic extractor was also exercised live against the Gourministeriet page: 4 servings, 60 total minutes, 22 ingredient lines, and 8 instruction steps were extracted.

Compact reduced snapshots live in `tests/fixtures/recipes/`, with capture provenance recorded alongside them. Fixture contracts bind every snapshot to its built-in registry entry and extraction kind. The four JSON-LD sources run through `extractRecipeJsonLd`; Valdemarsro's single Recipe microdata scope and SPIS BEDRE's grouped Inertia payload are validated as deterministic evidence only. Their production adapters remain Phase 2 work.

## Reproduction

```sh
git submodule update --init --recursive
bun install --frozen-lockfile
npm ci --prefix vendor/tilbudstrolden-mcp
npm run build --prefix vendor/tilbudstrolden-mcp
bun run test
bun run typecheck
bun run build
bun run src/cli.ts integrations verify-deals --json
bun run src/cli.ts recipes inspect <recipe-url> --json
```
