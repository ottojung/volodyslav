# IncrementalGraph database fingerprint

## Purpose

The database fingerprint is the durable identity of one continuing local
database writer. It serves two related roles:

- as the namespace suffix in node identifiers (`<base36-index>-<fingerprint>`),
  making independently allocated physical identifiers distinct across hosts; and
- under Journal 2, as `JournalAuthor`, the namespace of semantic event IDs, one
  dimension of causal summaries, and the deterministic cross-writer authority
  tie-break.

Each independently continuing writer history MUST have a distinct fingerprint
through every supported lifecycle transition. The fingerprint is stored in
replica-global metadata and is generated once during first database
initialization. It never changes during the continuing lifetime of that writer
history; same-host restoration resumes the saved identity rather than creating a
new writer.

A fingerprint collision between distinct writer histories is therefore a
Journal 2 identity collision, not merely a physical identifier collision. If
such a collision is detected, the states are unsupported for synchronization
and the operation MUST fail rather than merging their event sequences or causal
summary dimensions as one writer.

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

Fresh fingerprint generation is correctness-critical because the resulting
value may become a durable Journal 2 writer identity which survives indefinitely
in other replicas' `JournalEventId`s and `CausalPrefix` dimensions.

A fresh fingerprint MUST be generated from at least 128 bits of independent
nondeterministic entropy, and its encoded identity space MUST contain at least
`2^128` possible values. Expanding a smaller random seed through a deterministic
PRNG does not increase the effective entropy of the resulting fingerprint; in
particular, a generator whose only nondeterministic input is a 32-bit seed does
not satisfy this requirement.

The fingerprint is generated exactly once:

1. **Fresh first boot**: No `r/global/fingerprint` exists and no `r/`
   snapshot data is available. A new fingerprint satisfying the entropy and
   uniqueness requirements above is generated.

2. **First-boot restore from snapshot**: No live database exists. The
   snapshot's `r/global/fingerprint` becomes the live database fingerprint —
   it is imported alongside the rest of the replica data via the standard
   scan-from-filesystem path.

   This path exists for a host recovering its **own** previously-synchronized
   state (see `database-lifecycle.md` §4.2). The fingerprint is preserved
   because the host is resuming its own allocation namespace and Journal writer
   history.

3. **Reset/import into an existing live database**: The live database already
   has a local fingerprint. The pre-import local fingerprint is explicitly
   written back into the target replica's global sublevel before the replica
   pointer switch, so the live database preserves its local identity.

### Cross-host snapshot cloning is unsupported

Taking a rendered snapshot from one host and using it to bootstrap a second,
concurrently-writing host is outside the supported lifecycle model (see
`database-lifecycle.md` §10). If performed anyway, the two hosts would share
the same Journal writer identity and could allocate the same `JournalEventId`
coordinates or collapse distinct causal histories into one `CausalPrefix`
dimension. This is unsupported even when their physical node-identifier
allocations have not yet produced an `IdentifierLookupConflictError`.

New hosts obtain a distinct fingerprint through the fresh-creation path
(`database-lifecycle.md` §4.3). There is no supported "clone this database
onto a new concurrently-writing host" transition.

## Format

The fingerprint is a lowercase ASCII string of at least 9 characters and is
runtime validated against the full-string pattern `/^[a-z]{9,}$/`. Fresh
Journal 2 generation must additionally satisfy the 128-bit identity-space and
entropy requirement above; the syntax minimum alone is not a sufficient
generation rule.

Any persisted fingerprint loaded from active replica metadata, replica-switch
target metadata, a rendered snapshot used for restore/reset, or the standalone
snapshot migration path must satisfy the syntax pattern. Missing or malformed
values fail hard instead of being silently accepted or replaced.

## Lifecycle

- Created once on first initialization of the active replica.
- Persisted in the active replica's global sublevel under key `"fingerprint"`.
- Loaded into `RootDatabase._computed.fingerprint` on every database open
  (from the currently active replica).
- Available to all identifier allocation code paths through `_computed`.
- Used as the Journal 2 `JournalAuthor` and therefore never reassigned to an
  independent continuing writer history.
- Never overwritten by sync, reset, or import once a live DB exists.
- On first boot from a downloaded/restored snapshot, the snapshot's
  `r/global/fingerprint` becomes the local allocation/Journal writer identity.
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

- **Normal sync merge**: A host's staged snapshot contains that source writer's
  fingerprint. The local active replica keeps its own fingerprint; the remote
  fingerprint is represented only as foreign Journal author identity and is not
  adopted as the local writer. Distinct normal-sync replicas MUST have distinct
  writer fingerprints.

- **Reset/import into existing live DB**: The snapshot may contain a remote
  fingerprint. After import, the live database preserves its pre-import local
  fingerprint by explicitly writing it back to the target replica before the
  replica pointer switch.

- **First-boot restore**: There is no existing local fingerprint. The
  snapshot's `r/global/fingerprint` becomes the local allocation fingerprint
  and Journal writer identity. This is the supported path for a host recovering
  its own prior synchronized state. Cross-host snapshot cloning is unsupported
  (see Generation above).

Through supported lifecycle transitions, every independently-created and
independently-continuing writer history has a distinct fingerprint. This is what
makes both physical node identifiers and Journal 2 writer-scoped identities
safe to use across hosts.
