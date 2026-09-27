# Meal Planer

A local, family-aware meal-planning CLI for Denmark, built with TypeScript and Bun.

The Phase 0 integration-evidence milestone documented in `PLAN.md` is complete: the repository contains working recipe and pinned TilbudsTrolden MCP tracer paths, contract-tested structured provider responses, and compact deterministic fixtures for all six built-in recipe sources. Production source adapters, persistence, and meal planning remain later-phase work.

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
