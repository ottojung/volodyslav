# IncrementalGraph database fingerprint

## Purpose

The database fingerprint is the local allocation fingerprint of the live
database. It serves as the namespace suffix in node identifiers
(`<base36-index>-<fingerprint>`), providing a probabilistically distinct
allocation namespace across independently created hosts even when the same
local index values are allocated.

The canonical type name for this existing value is `DatabaseFingerprint`.
Journal entries use the authoring host's `DatabaseFingerprint` directly; there
is no journal-specific identity or second storage location.

Fresh creation probabilistically chooses a fingerprint for each host. Hosts may,
with low probability, choose the same fingerprint; the protocol does not make
any uniqueness guarantee at creation time. A collision between two
independently valid fresh hosts is not by itself corruption. The fingerprint is stored
in replica-global metadata and is generated once during first database
initialization. It never
changes during the lifetime of a live database.

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

The fingerprint is generated with
`random.basicString(capabilities, DATABASE_FINGERPRINT_LENGTH)` using the
project's seeded PRNG. It is generated exactly once:

1. **Fresh first boot**: No `r/global/fingerprint` exists and no `r/`
   snapshot data is available. A new fingerprint is generated.

2. **First-boot restore from snapshot**: No live database exists. The
   snapshot's `r/global/fingerprint` becomes the live database fingerprint —
   it is imported alongside the rest of the replica data via the standard
   scan-from-filesystem path.

   This path exists for a host recovering its **own** previously-synchronized
   state (see `database-lifecycle.md` §4.2). The fingerprint is preserved
   because the host is resuming its own allocation namespace.

3. **Reset/import into an existing live database**: The live database already
   has a local fingerprint. The pre-import local fingerprint is explicitly
   written back into the target replica's global sublevel before the replica
   pointer switch, so the live database preserves its local identity.

### Cross-host snapshot cloning is unsupported

Taking a rendered snapshot from one host and using it to bootstrap a second,
concurrently-writing host is outside the supported lifecycle model (see
`database-lifecycle.md` §10). If performed anyway, the two hosts would share
a fingerprint and could allocate colliding identifiers.

New hosts obtain a probabilistically chosen fingerprint through the
fresh-creation path
(`database-lifecycle.md` §4.3). There is no supported "clone this database
onto a new concurrently-writing host" transition.

## Format

A `DatabaseFingerprint` is exactly 9 lowercase ASCII letters. Every compliant
implementation MUST generate, persist, import, and validate the one canonical
full-string representation `/^[a-z]{16}$/`; fresh creation uses
`random.basicString(capabilities, DATABASE_FINGERPRINT_LENGTH)`. The fingerprint
length is not configurable through the database API.

Every fingerprint loaded from active replica metadata, replica-switch target
metadata, a rendered snapshot used for restore/reset, or the standalone
snapshot migration path MUST satisfy this representation. A missing, shorter,
longer, uppercase, non-ASCII, digit-containing, or otherwise malformed value is
invalid persistent state and MUST be rejected rather than accepted, replaced,
or normalized. An implementation with unbounded fingerprint representations is
non-compliant.

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
  remote database fingerprint is not adopted. Merge does not modify the local
  fingerprint.

- **Reset/import into existing live DB**: The snapshot may contain a remote
  fingerprint. After import, the live database preserves its pre-import
  local fingerprint by explicitly writing it back to the target replica
  before the replica pointer switch.

- **First-boot restore**: There is no existing local fingerprint. The
  snapshot's `r/global/fingerprint` becomes the local allocation fingerprint.
  This is the supported path for a host recovering its own prior synchronized
  state. Cross-host snapshot cloning is unsupported (see Generation above).

`DatabaseFingerprint` is a probabilistically chosen durable writer/allocation
identifier. Expected distinctness gives node identifiers probabilistically
distinct namespaces across independently created hosts. An unlucky collision
may alias independently created histories; no uniqueness guarantee is made at
creation time, and the collision does not by itself make either standalone
database corrupt.

The journal and synchronization model assumes that each
`DatabaseFingerprint` in the interpreted author-coordinate universe denotes
one durable writer history. A collision between independent writer histories
can alias
`JournalEntryId`, `journalCoverage`, causal-prefix coordinates, and
iterator progress and issuance-coverage coordinates, and `NodeIdentifier` allocation namespaces. When that
premise is violated, the normal uniqueness, portability, causal, and
convergence guarantees do not apply across the aliased histories. The protocol
does not promise to detect or repair such a collision.

## Journal authorship identity

The durable fingerprint is the author coordinate of every locally authored `JournalEntryId` and every local coverage coordinate. It does not impose cross-author order. Supported restart, self-restoration, and migration preserve the fingerprint with journal, coverage, and allocator; rollback under the same identity is unsupported. Controlled reset retains the receiver fingerprint and does not import source journal or coverage.
