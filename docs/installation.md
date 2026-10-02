# Installation and upgrades

## Requirements

- Git
- Bun 1.4 or newer
- Node.js 18 or newer, including npm
- Linux with glibc, `/proc` mounted, and a filesystem supporting `renameat2(RENAME_NOREPLACE)` for hardened backup/restore

TilbudsTrolden is a pinned Node.js sidecar, so Node remains required even though the main CLI runs on Bun.

Linux is the verified Phase 7 platform. Hardened backup/restore is Linux-only; macOS, Windows, and non-glibc Linux are not supported for these commands. Other CLI commands may work there, but are not verified by this delivery.

## Install from Git

```sh
git clone --recurse-submodules https://github.com/mimse/meal-planer.git
cd meal-planer
bun run setup:runtime
bun link
mealplan --help
```

`setup:runtime` installs the frozen Bun dependencies, installs and builds the pinned TilbudsTrolden submodule, builds `dist/cli.js`, and performs an isolated MCP compatibility smoke check. It is safe to rerun after an interrupted setup.

If global linking is undesirable, run the built CLI directly:

```sh
bun run /absolute/path/to/meal-planer/dist/cli.js --help
```

## Runtime layout

The supported Phase 6 distribution is the Bun project plus its pinned, built sidecar. A compiled Bun executable is experimental because it does not contain the Node.js sidecar or its runtime dependencies.

Production sidecar lookup uses this order:

1. `MEALPLAN_TILBUDSTROLDEN_DIR` when explicitly set.
2. `vendor/tilbudstrolden-mcp` found above the source or bundled CLI location.

An override must point to a built TilbudsTrolden 0.5.3 directory containing `package.json`, `dist/server.js`, and `node_modules`.

## Upgrade

Create a backup first, then update the project and pinned submodule:

```sh
mealplan backup create "$HOME/mealplan-backups/before-upgrade-$(date +%Y%m%d)"
git pull --ff-only
git submodule update --init --recursive
bun run setup:runtime
bun run verify
```

The application migrates a restored or active database only after validating its migration ledger. Keep the pre-upgrade bundle until normal planning and shopping commands have been checked.

## Development verification

```sh
bun run test:unit
bun run test:property
bun run test:integration
bun run test:contract
bun run test:e2e
bun run typecheck
bun run build
bun run smoke:runtime
```

`bun run verify` runs all application tests, type checking, and the Bun bundle build. CI additionally installs, builds, and tests the pinned vendor project.
