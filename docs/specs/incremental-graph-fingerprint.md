# IncrementalGraph database fingerprint

## Purpose

The database fingerprint is the local allocation fingerprint of the live
database. It serves as the namespace suffix in node identifiers
(`<base36-index>-<fingerprint>`), making them globally unique across hosts
even when the same local index values are allocated.

It is stored in replica-global metadata and is generated once during first
database initialization. It never changes during the lifetime of a live
database.

## Storage location

```
rendered/r/global/fingerprint
```

In the LevelDB live database, this lives at the active replica's global
sublevel under the key `"fingerprint"`.

Storing the fingerprint in `r/global` rather than `_meta` means
restore/import/reset paths only need to scan `rendered/r/` and do not
require a special `rendered/_meta/` scan path for this feature.

## Generation

The fingerprint is generated with `random.basicString(capabilities)` using
the project's seeded PRNG. It is generated exactly once:

1. **Fresh first boot**: No `r/global/fingerprint` exists and no `r/`
   snapshot data is available. A new fingerprint is generated.

2. **First-boot restore from snapshot**: No live database exists. The
   snapshot's `r/global/fingerprint` becomes the live database fingerprint —
   it is imported alongside the rest of the replica data via the standard
   scan-from-filesystem path.

3. **Reset/import into an existing live database**: The live database already
   has a local fingerprint. The pre-import local fingerprint is explicitly
   written back into the target replica's global sublevel before the replica
   pointer switch, so the live database preserves its local identity.

## Format

The fingerprint is a lowercase ASCII string of at least 9 characters and is
runtime validated against the full-string pattern `/^[a-z]{9,}$/`. Any
persisted fingerprint loaded from active replica metadata, replica-switch
target metadata, a rendered snapshot used for restore/reset, or the standalone
snapshot migration path must satisfy this pattern. Missing or malformed values
fail hard instead of being silently accepted or replaced.

## Lifecycle

- Created once on first initialization of the active replica.
- Persisted in the active replica's global sublevel under key `"fingerprint"`.
- Loaded into `RootDatabase._computed.fingerprint` on every database open
  (from the currently active replica).
- Available to all identifier allocation code paths through `_computed`.
- Never overwritten by sync, reset, or import once a live DB exists.
- On first boot from a downloaded/restored snapshot, the snapshot's
  `r/global/fingerprint` becomes the local allocation fingerprint.
- On non-first-boot reset, the pre-import local fingerprint is written back
  to the target replica's global sublevel before the replica switch.

## Render and scan

- `rendered/r/global/fingerprint` is included in rendered filesystem snapshots
  alongside other global metadata (version, identifiers_keys_map,
  last_node_index).
- `scanFromFilesystem` imports the fingerprint as part of the replica's
  global sublevel.

## Relationship to sync and merge

The fingerprint is included in rendered snapshots and may be staged from
remote hosts during sync/reset. However:

- **Normal sync merge**: A host's staged snapshot may contain a different
  fingerprint. The local active replica keeps its own fingerprint; the
  remote host fingerprint is not adopted. Merge does not modify the local
  fingerprint.

- **Reset/import into existing live DB**: The snapshot may contain a remote
  fingerprint. After import, the live database preserves its pre-import
  local fingerprint by explicitly writing it back to the target replica
  before the replica pointer switch.

- **First-boot restore**: There is no existing local fingerprint. The
  snapshot's `r/global/fingerprint` becomes the local allocation fingerprint.

Each machine thus has its own allocation fingerprint for its lifetime. This
is what makes node identifiers globally unique across hosts even when the
same local index values are allocated.
