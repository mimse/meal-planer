# Phase 0 integration findings

This document records an initial Phase 0 tracer slice, not completion of all Phase 0 work in `PLAN.md`. The pinned `structuredContent` compatibility patch for `score_recipes` and `generate_shopping_list` and its contract tests remain pending; the current adapter intentionally handles the upstream 0.5.3 text response only at its boundary.

Verified on 2026-09-27. Live offer contents are time-sensitive; adapter behavior and identifiers are pinned where noted.

## TilbudsTrolden MCP

Pinned Git submodule: `vendor/tilbudstrolden-mcp` at commit `ad18454bb9bb187f7ac51b7ec9f6a0d22555d5cb` (server version 0.5.3).

Verification results:

- `npm ci`, build, and all 404 upstream Vitest tests pass under Node 24.
- The Meal Planer MCP client connects over stdio and sees 18 tools.
- Required tools are present: `list_stores`, `update_household`, `update_pantry`, `add_recipe`, `score_recipes`, and `generate_shopping_list`.
- A live `search_deals` call for `mælk` returned five offers.
- The default curated `list_stores` response contains REMA 1000 and Netto but omits SuperBrugsen.
- `list_stores {"all":true}` returns the full Danish directory and resolves the configured stores as:
  - REMA 1000: `11deC`
  - Netto: `9ba51`
  - SuperBrugsen: `0b1e8`

The application must query the full Danish directory during setup instead of relying on the curated default list. Dealer IDs remain runtime-discovered values; the values above are evidence, not hard-coded configuration.

The pinned server returns human-readable text in MCP `content`. Text parsing remains isolated inside the TilbudsTrolden adapter until structured responses are available.

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
