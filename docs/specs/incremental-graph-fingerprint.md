# IncrementalGraph database fingerprint

## Purpose

The database fingerprint is the local allocation fingerprint of the live
database. It serves as the namespace suffix in node identifiers
(`<base36-index>-<fingerprint>`), making independently allocated physical node
identifiers distinct across hosts even when the same local index values are
allocated.

The fingerprint is stored in replica-global metadata and is generated once
during first database initialization. It never changes during the lifetime of a
live database except by same-host restoration of that database's own saved
state.

Journal 2 does **not** use `DatabaseFingerprint` as `JournalAuthor`.
`DatabaseFingerprint` remains legacy physical-allocation metadata with its
existing format and generation rules. Journal 2 introduces its own independently
generated durable writer identity in the new journal sublevel; see
`incremental-graph-journal-types.md`.

This separation is intentional. A physical node-identifier namespace and a
semantic causal-history writer namespace have different correctness roles, and
Journal 2 must not retroactively promote existing fingerprints into permanent
semantic event-author identities.

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

   This path exists for a host recovering its **own** previously-synchronized
   state (see `database-lifecycle.md` §4.2). The fingerprint is preserved
   because the host is resuming its own physical allocation namespace.

3. **Reset/import into an existing live database**: The live database already
   has a local fingerprint. The pre-import local fingerprint is explicitly
   written back into the target replica's global sublevel before the replica
   pointer switch, so the live database preserves its local allocation
   identity.

The existing generator's entropy is not promoted into a Journal 2 semantic
identity guarantee. In particular, Journal 2's stronger writer-identity
requirements apply to `JournalAuthor`, not to `DatabaseFingerprint`.

### Cross-host snapshot cloning is unsupported

Taking a rendered snapshot from one host and using it to bootstrap a second,
concurrently-writing host is outside the supported lifecycle model (see
`database-lifecycle.md` §10). If performed anyway, the two hosts would share
a fingerprint and could allocate colliding physical identifiers. Sync merge
may detect this as an `IdentifierLookupConflictError` when the same identifier
maps to different semantic keys and fail for the affected host rather than
assigning invented meaning to the collision.

New hosts obtain their own fingerprint through the fresh-creation path
(`database-lifecycle.md` §4.3). There is no supported "clone this database
onto a new concurrently-writing host" transition.

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

Journal 2 lifecycle transitions preserve or create `JournalAuthor` separately;
they do not change these fingerprint rules.

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
  fingerprint. The local active replica keeps its own fingerprint; the remote
  host fingerprint is not adopted as the local physical allocation namespace.
  Journal semantic identity is determined by the source's `JournalHeader.writer`
  instead.

- **Reset/import into existing live DB**: The snapshot may contain a remote
  fingerprint. After import, the live database preserves its pre-import local
  fingerprint by explicitly writing it back to the target replica before the
  replica pointer switch. Its Journal writer identity is preserved separately
  according to the Journal 2 reset specification.

- **First-boot restore**: There is no existing local fingerprint. The
  snapshot's `r/global/fingerprint` becomes the local allocation fingerprint.
  This is the supported path for a host recovering its own prior synchronized
  state. If the snapshot already contains Journal 2, its saved `JournalAuthor`
  is restored independently. If it predates Journal 2, the migration gate mints
  a new Journal author without changing this fingerprint.

Through the supported lifecycle transitions, the fingerprint remains the
physical node-allocation namespace it was designed to be. Journal 2 does not
rely on fingerprint collision resistance for semantic event identity.
