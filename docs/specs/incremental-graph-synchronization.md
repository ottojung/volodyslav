# Specification for IncrementalGraph Synchronization

## Status

This specification defines the lifecycle/transport shell around Journal 2 synchronization.

The semantic merge itself is defined by:

- `incremental-graph-journal-sync.md`
- `incremental-graph-journal-projection.md`
- `incremental-graph-journal-api.md`
- `incremental-graph-journal-reset.md`

The graph's ordinary pull/invalidate semantics remain defined by `incremental-graph.md` and `incremental-graph-flag-based-inverse-validity.md`.

## Scope

Synchronization operates on persisted IncrementalGraph replicas. It may copy or remove cached values, rebuild physical identifiers/validity records, and write Journal 2 metadata. It must never invoke computors.

Normal synchronization must converge under the Journal 2 convergence specification. Reset-to-hostname is a separate controlled replacement operation. Same-host first-boot restoration is a separate recovery transition even if it reuses snapshot-staging/cutover machinery.

Synchronization is transport-independent semantically. Git is currently one mechanism used to obtain stable hostname snapshots; Git identity/ancestry does not participate in graph conflict resolution.

## Preconditions

For normal synchronization of one source host:

- receiver and source snapshots are stable;
- synchronization/lifecycle exclusion is held as required by the locking specs;
- source and receiver use exactly compatible database/schema versions;
- both persisted states satisfy legacy graph invariants and Journal 2 graph/journal consistency;
- source staging metadata and identifier lookups are parseable and bijective;
- corrupt identifier reuse or malformed NodeKeys are rejected.

A pre-Journal-2 and Journal-2 database are not directly semantically merged. Exact version compatibility and valid Journal 2 state are required.

## Semantic identity and authority

Synchronization operates over semantic `NodeKey`.

`NodeIdentifier` is physical storage identity only. Different replicas may use different identifiers for the same semantic node. Physical identifier selection is performed after Journal 2 semantic planning and does not determine the winner.

`ComputedValue` equality does not determine semantic value identity in normal synchronization. Value occurrence identity comes only from Journal 2 `ValueId`.

Conflict authority is the immutable Journal 2 EventRef HLC order. Writer-local journal sequence magnitudes are not compared across hosts. For concurrent value occurrences the HLC is seeded by the value occurrence's legacy `modifiedAt`, with causal advancement as required by Journal 2.

## Normal synchronization pipeline

A normal synchronization cycle follows this lifecycle:

1. acquire the required synchronization/exclusive lifecycle boundary;
2. checkpoint the active local database according to the repository lifecycle;
3. publish the local host's own state by advancing this host's authoritative synchronization branch to include the checkpoint from step 2, before any peer state is fetched or staged; this is the enforcement point for the publication-before-propagation rule in `database-lifecycle.md` §14 rule 13;
4. fetch participating peer host branches from the repository;
5. stage one stable source hostname snapshot;
6. validate exact database/schema compatibility and persisted invariants;
7. construct an inactive target from the local receiver snapshot;
8. run Journal 2 full semantic synchronization `receiver <- source`, joining source causal and HLC authority high-water metadata;
9. project/rebuild unchanged legacy graph sublevels from the resulting semantic plan;
10. validate final graph/journal consistency;
11. when the merge changed a receiver journal node summary, the receiver journal header causal/authority high-water state, or a legacy graph record, durably flush the target and atomically cut it over as active; when none of those changed, leave the active replica pointer unchanged, as required by `database-lifecycle.md` §7.2 step 7;
12. reopen/rebind active database state where the lifecycle requires it;
13. clear source staging state;
14. continue with other source hosts or report per-host failures according to the existing synchronization caller contract.

Advancing the receiver's `causalSummary` or `authorityClock` counts as a merge change requiring cutover even when no node summary or legacy graph record changed, because those retained high-water marks affect future local event allocation. A receiver-local cursor/diagnostic update alone is optimization state and does not make an otherwise no-op semantic merge require active-replica cutover.

Per-host success reporting is implementation-defined diagnostics rather than Journal 2 semantic state. An implementation may report bounded counts or flags such as adopted head/summary changes, receiver-authored normalization events, header-only advancement, and unchanged merges, but synchronization correctness, convergence, and cutover decisions MUST NOT depend on a particular diagnostic summary shape.

Each per-host merge is directional because the receiver alone can author new negative Journal 2 authority during normalization. Directionality does not weaken convergence: fair repeated synchronization is required to propagate those authorities to the other replicas.

## Full sync is normative

The initial Journal 2 synchronization implementation is full synchronization.

For each source it considers the complete current semantic summary domain:

```text
keys(receiver journal node summaries)
union
keys(source journal node summaries)
```

including tombstoned nodes.

The algorithm is exactly `incremental-graph-journal-sync.md`.

No cursor/change index is required for full-sync correctness.

## Incremental sync

Incremental synchronization may replace the complete source scan with the cursor/change-index protocol from `incremental-graph-journal-api.md`.

It is valid only when the receiver has a stored cursor proving that it incorporated that source through the cursor coordinate in the same source journal incarnation.

The cursor coordinate is source-writer-local. Remote sequence magnitudes never advance it.

If the cursor is invalid or unavailable, run full synchronization.

For a valid cursor, synchronization owns one fixed committed source snapshot and consumes the private `possibleMaybeChanges(sourceSnapshot, cursor)` async iterator while that snapshot is alive. The iterator is internal synchronization/journal infrastructure, not part of the public IncrementalGraph/computor API, and it yields bounded changed-node summaries lazily rather than materializing the complete range in RAM.

The incremental result must be observably equivalent to running full synchronization from the same starting snapshots, including retained `CreationTime` changes and transfer of current source `causalSummary` and `authorityClock` even when the async stream yields no changed node.

The current end-to-end synchronization complexity assumption is `$id-3572255392439745` in `docs/intent-records/synchronization-performance.md`. Under that accepted tradeoff, `O(N)` synchronization time is treated as an optimal target until GitHub issue #1607 is assigned; this correctness specification does not assert a stronger change-sensitive time bound.

## Semantic merge versus physical application

Journal 2 semantic synchronization first chooses/normalizes per-NodeKey semantic state.

Only afterward is the plan lowered to physical storage:

- choose/allocate final `NodeIdentifier`s without semantic effect;
- copy the selected occurrence's payload and `modifiedAt`;
- serialize legacy `createdAt` from the merged node summary's canonical `CreationTime`, which is selected by `joinCreation` in `incremental-graph-journal-projection.md`;
- delete legacy records for final tombstones;
- write `freshness` from Journal 2 projection;
- rebuild `valid` exactly from Journal 2 certificate projection;
- rebuild a bijective final identifier lookup;
- update the new journal sublevel atomically with those writes.

The representation of every existing sublevel remains unchanged.

## Cache retention and no hidden values

A selected present cached value remains an ordinary cache of the same semantic node even when synchronization changes one or more of its final inputs. Input/certificate mismatch is represented by stale freshness and missing validity proofs; it does not require moving the payload elsewhere or deleting it merely to protect the `oldValue` contract.

The normal stale-node pull path may later invoke the computor with the final input values and this retained cache as `oldValue`. The computor's existing `Unchanged` rule determines whether the value can be reused under those inputs.

Synchronization removes a cached materialization only when another rule makes it structurally impossible to keep, such as dependency closure when a required direct input is finally absent. If a cache is removed, its payload is not copied into the journal or another synchronization-only hidden store; the required tombstone authority remains in Journal 2 instead.

## Freshness and validity

Synchronization does not merge boolean `freshness` flags or raw `valid` arrays as independent authorities.

Their existing representations are rewritten in the target according to the Journal 2 projection of the final semantic summaries.

This is not a representation change: the final records remain exactly the same boolean/array formats used by the existing graph.

Journal 2 metadata explains which value/input occurrences and invalidations justify those records.

## Timestamps

Normal synchronization which adopts a foreign `ValueId` copies that occurrence's payload and `modifiedAt`. `modifiedAt` belongs to the selected value occurrence and remains the HLC seed associated with that occurrence.

`createdAt` is materialization-lineage synchronization metadata retained as canonical `CreationTime` in the Journal 2 node summary. Synchronization uses the `(head, createdAt)` join defined by `joinCreation`: a greater head wins with its carried creation metadata, and only equal selected present heads combine creation times by taking the earlier instant. Losing heads and absent inputs contribute no creation time.

For a fixed selected head the retained `CreationTime` may only move earlier. If a different greater head later wins, its own retained `CreationTime` replaces the losing head's creation metadata and may be later. Tombstones carry no `createdAt`, so rematerialization after deletion does not inherit creation time from the deleted materialization. Synchronization never substitutes its execution time.

Because `createdAt` is part of `NodeJournalSemanticPart`, both full and incremental synchronization transfer it and a change to it moves the source changed-node marker. The detailed rule is normative in `incremental-graph-journal-sync.md` and `incremental-graph-journal-projection.md`.

## Failure atomicity

A failed source merge must not expose a partially applied graph/journal target as active.

If the implementation constructs the inactive target in stages, failure leaves the previous active replica unchanged and discards/reuses the inactive slot only according to the database lifecycle.

A failure after a completed active cutover follows the existing lifecycle's explicit post-cutover failure semantics; callers must not infer rollback merely from an error returned after publication.

## Reset-to-hostname

Reset-to-hostname on an already-established local database does not call the normal semantic merge.

The selected source MUST be a validated compatible Journal 2 snapshot. A journal-less or pre-Journal-2 snapshot is not a supported semantic reset source.

Reset:

1. selects one validated compatible Journal 2 source snapshot;
2. constructs the reset target legacy graph under the lifecycle's exclusive replacement protocol;
3. optionally uses `ComputedValue` equality only to avoid rewriting already-equal receiver payload bytes;
4. joins the source Journal 2 causal/HLC high-water state;
5. increments the local Journal 2 incarnation while keeping local semantic/operation counters monotone;
6. bootstraps a new local journal explanation of the resulting graph as specified by `incremental-graph-journal-reset.md`;
7. validates projection equality;
8. atomically cuts over.

Source journal history/cursors are not installed as receiver history. Receiver-local stored source cursors are deleted because semantic reset destroys their incorporated-state invariant.

## Same-host first-boot restoration

If local live state is absent and Volodyslav recovers this hostname's own authoritative previously published synchronized snapshot, the semantic transition is **restoration**, not reset-to-hostname.

If the saved state already contains Journal 2, the staging/import/cutover implementation may reuse reset machinery physically, but it must preserve the saved same-writer Journal 2 state exactly, including:

```text
writer
journalIncarnation
localJournalCounter
localOperationCounter
causalSummary
authorityClock
node summaries/EventRefs, including retained CreationTime
changed-node markers
stored source cursors
legacy graph/value/timestamp state
```

It does not mint reset events, increment the incarnation, or delete restored source cursors merely because the local working copy had to be recreated.

If the authoritative same-host saved state predates Journal 2, restoration may install that legacy state as lifecycle recovery. The normal migration gate must then establish Journal 2 before the state participates in Journal 2 synchronization or semantic reset.

Arbitrary rollback to an older same-writer Journal 2 checkpoint is not restoration. A supported Journal 2 restoration must not restore a writer-local counter/HLC state behind later same-writer events which may already exist in supported external state; see the restoration no-reuse invariant in `incremental-graph-journal-reset.md`.

## Transport rules

Transport snapshots must preserve the bytes of the legacy graph and Journal 2 sublevel being staged when Journal 2 is present. They need not preserve source filesystem paths or Git ancestry as semantic facts.

A stable staged Journal 2 snapshot is interpreted solely by its persisted IncrementalGraph database version, schema, graph records, and Journal 2 state.

Transport identity does not replace Journal 2 writer identity or authority semantics. For same-host restoration, the lifecycle separately validates that the snapshot is the authoritative saved state for the same logical host history.

## Correctness target

With no continuing graph-changing operations and fair repeated synchronization across a finite connected set of supported replicas:

- synchronization-authored normalization eventually stops creating new negative authority;
- all replicas converge to observably equivalent legacy IncrementalGraph states, including public creation-time observations;
- subsequent synchronization is a semantic no-op;
- local journal histories and local physical identifiers are not required to become byte-for-byte identical.
