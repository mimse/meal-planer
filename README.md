# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

The implementation is starting with an initial tracer slice for the integration risks documented in `PLAN.md`: recipe JSON-LD extraction and the pinned TilbudsTrolden MCP boundary. It does not complete Phase 0; notably, the planned TilbudsTrolden `structuredContent` compatibility patch and its contract tests are still pending.

## Development

Requires Bun 1.4 or newer and Node.js 18 or newer.

```sh
bun install --frozen-lockfile
bun run vendor:install
bun test
bun run typecheck
bun run build
bun run src/cli.ts --help
```

The first working tracer commands are:

```sh
bun run src/cli.ts recipes inspect <recipe-url> --json
bun run src/cli.ts integrations verify-deals --json
```

See `PLAN.md` for the implementation plan, `DESIGN.md` for the domain and CLI design, and `docs/phase-0.md` for verified integration findings.
