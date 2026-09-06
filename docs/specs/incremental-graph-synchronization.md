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

Normal synchronization must converge under the Journal 2 convergence specification. Reset-to-hostname is a separate controlled replacement operation.

Synchronization is transport-independent semantically. Git is currently one mechanism used to obtain stable hostname snapshots; Git identity/ancestry does not participate in graph conflict resolution.

## Preconditions

For normal synchronization of one source host:

- receiver and source snapshots are stable;
- synchronization/lifecycle exclusion is held as required by the locking specs;
- source and receiver use exactly compatible database/schema versions;
- both persisted states satisfy legacy graph invariants and Journal 2 graph/journal consistency;
- source staging metadata and identifier lookups are parseable and bijective;
- corrupt identifier reuse or malformed NodeKeys are rejected.

A pre-Journal-2 and Journal-2 database are not directly semantically merged. Exact version compatibility is required.

## Semantic identity

Synchronization operates over semantic `NodeKey`.

`NodeIdentifier` is physical storage identity only. Different replicas may use different identifiers for the same semantic node. Physical identifier selection is performed after Journal 2 semantic planning and does not determine the winner.

`ComputedValue` equality does not determine semantic value identity in normal synchronization. Value occurrence identity comes only from Journal 2 `ValueId`.

## Normal synchronization pipeline

A normal synchronization cycle follows this lifecycle:

1. acquire the required synchronization/exclusive lifecycle boundary;
2. checkpoint the active local database according to the repository lifecycle;
3. exchange/fetch transport snapshots as needed;
4. stage one stable source hostname snapshot;
5. validate exact database/schema compatibility and persisted invariants;
6. construct an inactive target from the local receiver snapshot;
7. run Journal 2 full semantic synchronization `receiver <- source`;
8. project/rebuild unchanged legacy graph sublevels from the resulting semantic plan;
9. validate final graph/journal consistency;
10. durably flush the target and atomically cut it over as active;
11. reopen/rebind active database state where the lifecycle requires it;
12. clear source staging state;
13. continue with other source hosts or report per-host failures according to the existing synchronization caller contract.

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

Incremental synchronization may later replace the complete source scan with the cursor/change-index protocol from `incremental-graph-journal-api.md`.

It is valid only when the receiver has a stored cursor proving that it incorporated that source through the cursor coordinate in the same source journal incarnation.

If the cursor is invalid or unavailable, run full synchronization.

For valid cursors, the incremental result must be observably equivalent to running full synchronization from the same starting snapshots.

## Semantic merge versus physical application

Journal 2 semantic synchronization first chooses/normalizes per-NodeKey semantic state.

Only afterward is the plan lowered to physical storage:

- choose/allocate final `NodeIdentifier`s without semantic effect;
- copy the complete selected payload/timestamp record for adopted present values;
- delete legacy records for final tombstones;
- write `freshness` from Journal 2 projection;
- rebuild `valid` exactly from Journal 2 certificate projection;
- rebuild a bijective final identifier lookup;
- update the new journal sublevel atomically with those writes.

The representation of every existing sublevel remains unchanged.

## No hidden values

If semantic normalization determines that a cached value cannot safely remain available as `oldValue`, synchronization must remove its legacy materialization and author/preserve sufficient tombstone authority to prevent lower old values from resurrecting.

It must not copy that payload into the journal or another synchronization-only store.

## Freshness and validity

Synchronization does not merge boolean `freshness` flags or raw `valid` arrays as independent authorities.

Their existing representations are rewritten in the target according to the Journal 2 projection of the final semantic summaries.

This is not a representation change: the final records remain exactly the same boolean/array formats used by the existing graph.

Journal 2 metadata explains which value/input occurrences and invalidations justify those records.

## Timestamps

Normal synchronization which adopts a foreign `ValueId` copies the complete selected value/timestamp record from the source carrying that occurrence.

It does not construct a hybrid record, compare payloads for identity, or stamp merge execution time as the semantic value modification time.

## Failure atomicity

A failed source merge must not expose a partially applied graph/journal target as active.

If the implementation constructs the inactive target in stages, failure leaves the previous active replica unchanged and discards/reuses the inactive slot only according to the database lifecycle.

A failure after a completed active cutover follows the existing lifecycle's explicit post-cutover failure semantics; callers must not infer rollback merely from an error returned after publication.

## Reset-to-hostname

Reset-to-hostname does not call the normal semantic merge.

It:

1. selects one validated source snapshot;
2. constructs the reset target legacy graph under the lifecycle's exclusive replacement protocol;
3. optionally uses `ComputedValue` equality only to avoid rewriting already-equal receiver payload bytes;
4. increments the local Journal 2 incarnation;
5. bootstraps a new local journal explanation of the resulting graph as specified by `incremental-graph-journal-reset.md`;
6. validates projection equality;
7. atomically cuts over.

Source journal history/cursors are not installed as receiver history.

## Transport rules

Transport snapshots must preserve the bytes of the legacy graph and Journal 2 sublevel being staged. They need not preserve source filesystem paths or Git ancestry as semantic facts.

A stable staged snapshot is interpreted solely by its persisted IncrementalGraph database version, schema, graph records, and Journal 2 state.

## Correctness target

With no continuing graph-changing operations and fair repeated synchronization across a finite connected set of supported replicas:

- synchronization-authored normalization eventually stops creating new negative authority;
- all replicas converge to observably equivalent legacy IncrementalGraph states;
- subsequent synchronization is a semantic no-op;
- local journal histories and local physical identifiers are not required to become byte-for-byte identical.