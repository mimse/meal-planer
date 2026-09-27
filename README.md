# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

The implementation is starting with Phase 0 tracer slices for the integration risks documented in `PLAN.md`: recipe extraction and the pinned TilbudsTrolden MCP boundary. The provider fork now exposes contract-tested structured scoring and shopping-list responses alongside its legacy text. Representative recipe fixtures remain before Phase 0 is complete.

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

The first working tracer commands are:

```sh
bun run src/cli.ts recipes inspect <recipe-url> --json
bun run src/cli.ts integrations verify-deals --json
```

See `PLAN.md` for the implementation plan, `DESIGN.md` for the domain and CLI design, and `docs/phase-0.md` for verified integration findings.
