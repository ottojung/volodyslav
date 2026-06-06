# IncrementalGraph database fingerprint

## Purpose

The database fingerprint is a machine-local stable identifier that makes
node identifiers globally namespaced. It is generated once during first
database initialization and never changes during the lifetime of a live
database.

## Storage location

```
rendered/_meta/fingerprint
```

In the LevelDB live database, this lives at `_meta/fingerprint` in the
root-level `_meta` sublevel.

## Generation

The fingerprint is generated with `random.basicString(capabilities)` using
the project's seeded PRNG. It is generated exactly once:

1. On first boot of a truly fresh database (no `_meta/fingerprint` exists and
   no `r/` snapshot data is available), a new fingerprint is generated.

2. On first boot / initialization from a downloaded/restored snapshot, the
   fingerprint from that snapshot is imported into the live `_meta` sublevel
   before the database starts serving requests.

3. Once a live database exists, sync/reset/import paths must not overwrite
   its local `_meta/fingerprint`.

## Format

The fingerprint is a lowercase ASCII string of at least 9 characters,
matching `/^[a-z]{9,}$/`. It is not validated at runtime — the format
exists only as a specification invariant. The existing code style treats
node identifiers as nominal strings and does not validate the documented
format at conversion boundaries.

## Lifecycle

- Created once on first initialization.
- Persisted in `_meta/fingerprint`.
- Loaded into `RootDatabase._computed.fingerprint` on every database open.
- Available to all identifier allocation code paths through `_computed`.
- Never overwritten by sync, reset, or import once a live DB exists.
- If a reset/recovery path destroys the live database entirely (e.g. full
  database deletion and re-initialization from a snapshot), the fingerprint
  from that snapshot is imported.

## Render and scan

- `rendered/_meta/fingerprint` is included in rendered filesystem snapshots
  alongside `rendered/_meta/current_replica`.
- `scanFromFilesystem` into the `_meta` sublevel imports the fingerprint
  when the database is being initialized from a snapshot.

## Not synchronized

The fingerprint is local machine metadata. It is not transferred between
hosts during synchronization. Each machine has its own fingerprint, which
is what makes node identifiers globally unique across hosts even when the
same local index values are allocated.
