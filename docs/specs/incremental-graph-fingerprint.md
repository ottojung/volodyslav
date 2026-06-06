# IncrementalGraph database fingerprint

## Purpose

The database fingerprint is a machine-local stable identifier that makes
node identifiers globally namespaced. It is generated once during first
database initialization and never changes during the lifetime of a live
database.

## Storage location

```
rendered/r/global/fingerprint
```

In the LevelDB live database, this lives at the active replica's global
sublevel under the key `"fingerprint"`.

## Generation

The fingerprint is generated with `random.basicString(capabilities)` using
the project's seeded PRNG. It is generated exactly once:

1. On first boot of a truly fresh database (no `r/global/fingerprint` exists
   and no `r/` snapshot data is available), a new fingerprint is generated.

2. On first boot / initialization from a downloaded/restored snapshot, the
   fingerprint from that snapshot is imported into the live replica's global
   sublevel alongside the rest of the replica data.

3. Once a live database exists, sync/reset/import paths must not overwrite
   its local replica-global `fingerprint`.

## Format

The fingerprint is a lowercase ASCII string of at least 9 characters,
matching `/^[a-z]{9,}$/`. It is not validated at runtime — the format
exists only as a specification invariant. The existing code style treats
node identifiers as nominal strings and does not validate the documented
format at conversion boundaries.

## Lifecycle

- Created once on first initialization of the active replica.
- Persisted in the active replica's global sublevel at `r/global/fingerprint`.
- Loaded into `RootDatabase._computed.fingerprint` on every database open
  (from the currently active replica).
- Available to all identifier allocation code paths through `_computed`.
- Never overwritten by sync, reset, or import once a live DB exists.
- On first boot from a downloaded/restored snapshot, the snapshot's
  `r/global/fingerprint` is imported along with the rest of the replica
  data via the standard scan-from-filesystem path.
- On non-first-boot reset, the local fingerprint is written back to the
  target replica's global sublevel before the replica switch, preserving
  the local identity.

## Render and scan

- `rendered/r/global/fingerprint` is included in rendered filesystem snapshots
  alongside other global metadata (version, identifiers_keys_map,
  last_node_index).
- `scanFromFilesystem` imports the fingerprint as part of the replica's
  global sublevel.

## Not synchronized

The fingerprint is local machine metadata. It is not transferred between
hosts during synchronization. On a non-first-boot reset that imports a
remote snapshot, the local fingerprint is restored into the target replica
before the replica pointer switch. Each machine has its own fingerprint,
which is what makes node identifiers globally unique across hosts even when
the same local index values are allocated.
