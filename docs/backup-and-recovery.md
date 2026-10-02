# Backup and recovery

## What is backed up

The SQLite application database is authoritative and contains household configuration, pantry, recipe provenance and review fields, plans, history, replacements, and cache state.

Normal deal-enabled planning uses fresh private TilbudsTrolden sessions that are deleted on close. They are derived scratch data and are recorded as `ephemeral-regenerated` rather than backed up.

If TilbudsTrolden is also used independently with a persistent JSON store, include that exact file explicitly.

## Create a backup

Application state only:

```sh
mealplan backup create /safe/path/mealplan-backup
```

Application state plus an independently managed persistent MCP store:

```sh
mealplan backup create /safe/path/mealplan-backup \
  --mcp-data "$HOME/.tilbudstrolden.json"
```

The destination must not already exist. Creation writes a private staged directory, snapshots live SQLite state coherently with `VACUUM INTO`, runs SQLite integrity and foreign-key checks, compares the complete schema including the migration tracking table against the recorded migrations, verifies that a copy can safely advance, validates optional MCP data against the pinned 0.5.3 schema, and computes SHA-256 checksums. Publication uses Linux `renameat2(RENAME_NOREPLACE)` anchored to an open parent-directory descriptor, checks that the published directory is the staged inode, and detects parent redirection. A concurrent destination is never replaced. See the private-parent requirement and race limits below.

Bundle contents are fixed:

```text
manifest.json
mealplan.sqlite
tilbudstrolden.json   # only when explicitly included
```

Do not add, remove, or edit files inside a bundle.

## Restore

Restore always publishes a new directory:

```sh
mealplan backup restore /safe/path/mealplan-backup \
  --to /safe/path/recovered-state
```

The destination directory must not exist. This prevents replacing a database that another CLI process may still have open and avoids stale SQLite journal sidecars.

Activate the restored database:

```sh
export MEALPLAN_DATABASE=/safe/path/recovered-state/mealplan.sqlite
mealplan family show
mealplan plan show --week next
```

If the bundle included persistent MCP data for standalone use:

```sh
export TILBUDSTROLDEN_DATA=/safe/path/recovered-state/tilbudstrolden.json
```

Normal mealplan planning sessions deliberately do not reuse that file.

## Restore validation

Before publishing output, restore rejects:

- unsupported or malformed manifests;
- missing, extra, non-regular, or symlinked bundle files;
- database or MCP checksum mismatches;
- corrupt SQLite pages or foreign keys;
- invalid or inconsistent migration ledgers;
- malformed or out-of-contract MCP JSON;
- restore destinations inside the bundle, including symlink aliases;
- an existing restore destination.

A failed restore removes files through its anchored staging descriptor and never recursively deletes a redirected destination. The fully validated directory becomes visible atomically, so readers cannot observe a partially published restore.

## Limits

Hardened backup/restore is supported on Linux with glibc and `/proc` mounted. Use a private destination parent directory that other users cannot modify. Publication checks the staged directory's filesystem identity before and after its no-replace rename, and restore checks the current locations of the opened source and destination directories. A process with permission to mutate those directories can still move entries during or after these checks; no pathname-based API can guarantee their continued location against such an actor.

Failed operations clear their own staged files through the open directory descriptor but intentionally leave an empty staging directory (or an empty published directory if publication was rejected afterward). Removing a directory by a mutable parent/name pair could delete a concurrent replacement. Inspect these empty directories and remove them manually from a private parent when safe.

The SQLite snapshot and an optional independently operated MCP JSON file cannot be captured in one cross-file transaction. Their capture time is recorded, but the bundle does not claim they are one point-in-time distributed snapshot.
