# IncrementalGraph Journal 2

## Status and scope

This specification is the entry point for Journal 2. It is normative together with:

- `incremental-graph-journal-types.md`
- `incremental-graph-journal-emission.md`
- `incremental-graph-journal-projection.md`
- `incremental-graph-journal-sync.md`
- `incremental-graph-journal-compaction.md`
- `incremental-graph-journal-api.md`
- `incremental-graph-journal-reset.md`
- `incremental-graph-journal-migrations.md`
- `incremental-graph-journal-locking.md`
- `incremental-graph-synchronization.md`

Journal 2 adds one new IncrementalGraph sublevel, `journal`. It does not change the representation of any existing sublevel.

The conceptual journal is a local ordered history of events. The persisted journal continuously maintains bounded per-node summaries and indexes alongside raw historical records; canonical compaction may later prune raw history whose future synchronization and iterator meaning is already represented by those maintained records.

The journal is not a durable audit log. Canonical compaction may permanently discard old raw events and high-level operation-grouping detail once their required future synchronization/iterator meaning has been retained in bounded journal state.

## Design boundary

The existing graph representation remains the operational representation:

```text
identifiers_keys_map
values
freshness
timestamps
valid
...
```

No version, causal, provenance, journal, cursor, or synchronization-only field is added to those records. Journal 2 is a sidecar which supplies information that the existing representation cannot express.

In particular, the journal can distinguish two occurrences of equal `ComputedValue` payloads without comparing those payloads, identify the exact input value occurrences against which a cache was certified, retain the current materialization's synchronization-relevant creation time, and retain negative authority after a materialization has been deleted from the legacy graph.

The journal never stores a `ComputedValue` payload or a copy of one. A current present journal state therefore requires the corresponding payload and timestamp record to exist in the unchanged legacy sublevels.

## Local journals

Every writable database has one durable journal writer identity: its `DatabaseFingerprint`. Journal semantic events authored by that database have writer-local history and a monotonically increasing writer-local semantic event sequence along one continuing writer state.

Journal 2 deliberately does **not** make sequence magnitudes globally comparable. Event identity, exact causality, and conflict authority are separate:

```text
JournalEventId(author, localSequence)   // writer-local identity
CausalPrefix                           // exact happened-before
AuthorityTime                          // HLC conflict precedence
```

A local event gets `localSequence + 1` regardless of remote sequence magnitudes. Exact causal observation is represented by the vector context. Deterministic conflict authority is represented by a hybrid logical clock which extends happened-before together with the EventRef tie-breakers and is seeded from legacy `modifiedAt` for value occurrences.

For concurrent authorities, the total order compares causality-adjusted authority time, then writer fingerprint, then writer-local sequence. The final sequence comparison therefore occurs only within one writer.

Normal synchronization does not import source event history into the receiver journal. It may adopt foreign semantic references and bounded foreign metadata into receiver summaries. If this changes receiver state, the receiver records a local adoption event so its own change stream reflects the transition. The adoption event is not a new value occurrence and does not replace or inflate the adopted foreign semantic authority.

Thus:

```text
source journal history != receiver journal history
```

while their graph projections may converge.

## High-level operations and low-level semantic events

Journal 2 records synchronization authority with low-level semantic events such as value, validate, invalidate, delete, and adopt.

It also permits the local historical journal to preserve the identity of the high-level operation which produced those events. A high-level operation gets a small local tagged `OperationRecord`; low-level events produced by it carry that operation ID.

The operation record includes the bounded arguments needed to identify the invocation itself. For example:

```text
pull(K)                       -> subject = K
invalidate(K)                 -> subject = K
synchronize(V,S@I:Q,C,H)      -> source database version/writer/incarnation/local head/causal summary/HLC high-water
reset(V,S@I:Q,C,H)            -> chosen source database version/writer/incarnation/local head/causal summary/HLC high-water
migration(M)                  -> stable MigrationId M
```

For Journal 2 sources, `Q` alone is not enough to identify the synchronization-relevant source state because its causal summary `C` and authority high-water `H` may grow without authoring a new local semantic event. The database version `V` is also independent of those Journal coordinates: a Journal-2-aware migration may advance the database version without changing `Q`, `C`, or `H`. Source-bearing operation records therefore retain the exact source database version together with the bounded source-header fields from the fixed snapshot they consumed.

Journal 2 synchronization and semantic reset require valid compatible Journal 2 source state under the exact graph schema for that database version, so source-bearing operation records always carry the complete Journal 2 source reference defined by the types specification. No separate schema field is required in the operation record because the lifecycle makes database version the interpretation boundary and rejects a source whose graph schema is incompatible with that version's operation.

Conceptually this permits viewing the **direct expansion** of one operation as:

```text
graph.pull K {
    compiled: [
        value(...),
        validate(...),
        invalidate(...)
    ]
}
```

Here `compiled` means the low-level events directly produced under that operation ID. If `pull(K)` recursively invokes another pull, that nested pull may have its own operation ID and its events need not appear in the parent operation's expansion. Journal 2 therefore does not promise one transitive envelope containing every recursively caused event.

A child operation may optionally record `parent: OperationId` for its direct high-level caller. This is only a bounded historical edge; parents never enumerate child lists, and the parent relation has no synchronization or causal authority.

The `compiled` array above is only a conceptual view: it is not stored as one large LevelDB value. The expansion is represented by the list of small low-level events that point to the operation ID.

Operation IDs use a separate local counter and do not participate in semantic authority, causal context, conflict selection, synchronization, or projection. The operation counter remains monotone across reset; `OperationRecord.incarnation` records the journal incarnation in which the operation occurred but is not part of operation identity.

Compaction may discard old operation records independently of the raw events which reference them. If a retained `operation` or `parent` reference names a discarded record, that grouping edge is unavailable to historical readers without making the journal state unsupported.

## Two layers inside the journal sublevel

The journal sublevel contains two conceptual layers.

### Historical layer

The historical layer contains locally authored high-level operation records and low-level semantic events in journal history. Before compaction this is the direct history of supported graph operations and synchronization transitions.

Operation records group semantic events but do not replace them as synchronization authority.

The total size of this uncompacted historical layer is intentionally not bounded. Raw history may accumulate between nondeterministically timed compactions; only individual journal records remain subject to the per-LevelDB-value bound. See `$id-8247698182975014` and `incremental-graph-journal-compaction.md`.

### Compacted synchronization layer

Live authoring and synchronization maintain the bounded synchronization layer on every publication. Canonical compaction does not build or rewrite this layer; it removes raw historical records whose future-relevant meaning these maintained records already carry. The layer contains:

```text
header {
    local counters,
    causalSummary,
    authorityClock,
    ...
}
node summary per represented NodeKey
one current changed-node marker per represented NodeKey
one derived reverse structural-edge record per materialized dependency edge
optional bounded raw-history tail retained by the compacted result
stored source cursors
```

The reverse structural-edge records are local derived acceleration state, not synchronization authority. They exactly index the current materialized structural graph so incremental synchronization can traverse receiver dependents without scanning unrelated nodes; see `incremental-graph-journal-api.md`.

The optional bounded tail above describes what a completed compaction chooses to retain; it is not a bound on raw history accumulated before the next compaction.

These records are journal information, not changes to the legacy graph representation. A compacted node summary is the future-relevant meaning of the historical events for that node; it is not a `ComputedValue` store.

## Core invariants

### J2-INV-1: graph/journal consistency

For every supported persisted database state, the legacy materialized graph must equal the journal projection defined in `incremental-graph-journal-projection.md`, modulo local physical identifier choices explicitly excluded there.

A present journal value occurrence must correspond to exactly one materialized semantic node in the legacy graph. For every present K, the legacy `createdAt` record must equal the node summary's retained `createdAt`. An absent journal state must not have a materialized legacy node and must retain no `createdAt`.

The derived reverse structural-edge index must exactly equal the structural dependency edges among the current materialized nodes: for every materialized N and every `D in inputEdges(N)` it contains `(D,N)`, and it contains no edge whose dependent is not materialized or whose input is not a structural input of that dependent.

### J2-INV-2: atomic publication

A transaction which changes legacy graph state and corresponding journal state publishes both atomically. A transaction may also change synchronization-only journal metadata without changing legacy graph state, but such metadata must never describe a graph transition which was not durably published.

High-level operation records and low-level semantic events belonging to one committed graph transition must obey the same publication boundary.

### J2-INV-3: no payload duplication

Journal keys and values contain no `ComputedValue` payload. Historical payloads are not reconstructible from the journal after the corresponding legacy value has been replaced or deleted.

### J2-INV-4: stable semantic references

A semantic value occurrence has one immutable `ValueId` and one immutable `ValueRef` context/authority time. Normal synchronization preserves all of those fields when the value is copied between databases. Receiver-local adoption event IDs do not become new `ValueId`s.

A successful local computation which changes the semantic value creates a new `ValueId`. A successful computation or cache revalidation which returns the existing semantic value preserves its `ValueId` and original value authority and creates only a new validation certificate. Node-summary `createdAt` is synchronization-relevant materialization metadata but is not part of `ValueId` identity.

### J2-INV-5: causality-respecting deterministic authority

Semantic value/delete authorities and validation certificates have the deterministic total EventRef order specified in the types specification.

Event allocation guarantees:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

The HLC coordinate is a conflict-resolution component. Exact causal tests still use explicit vector context; HLC comparison is not used to infer happened-before. Initial-bootstrap value events with equal legacy `modifiedAt` may share the same HLC `AuthorityTime`; same-writer sequence still makes their complete EventRef authority strictly ordered.

Writer-local journal sequences from different authors are not compared for conflict precedence. Writer fingerprint is the cross-host deterministic tie-break after HLC authority time.

High-level operation IDs are excluded from this authority order.

### J2-INV-6: bounded current meaning

Let:

```text
L = currently present/materialized represented keys
T = retained absent/tombstoned represented keys
N = L + T
```

After canonical compaction, each represented semantic key has only a constant number of future-relevant journal records, each of serialized size `O(R log H)` bits under the assumptions in `$id-6193879998109578`.

The derived reverse structural-edge index adds one constant-size record per materialized dependency edge. Because maximum direct in-degree is bounded, the number of those edges is O(L), so the index contributes only O(L) additional serialized bits.

The retained `createdAt` adds only one `O(log H)` scalar for each present node summary and therefore does not change the asymptotic bound.

Consequently the complete compacted journal has serialized size:

```text
O((L + T) R log H) bits
= O(N R log H) bits
```

`T` may grow with historical unique-key churn. The bound is a pessimistic worst-case bound and does not rely on remote-host acknowledgements or eventual return.

This invariant is deliberately a bound on the canonical **compacted result**, not on every uncompacted committed journal. The raw historical layer may be arbitrarily larger between compactions as accepted by `$id-8247698182975014`.

The proof is in `incremental-graph-journal-compaction.md`.

### J2-INV-7: causal/authority header coherence

The causal and authority header high-water marks are one coupled summary of observed semantic history. For every supported semantic event `E` authored by writer `A`:

```text
E.id.sequence <= header.causalSummary[A]
    => E.authorityTime <= header.authorityClock
```

where the right-hand comparison is the canonical `AuthorityTime` order. This invariant quantifies over semantic events already compacted away as well as retained EventRefs; raw history is not required in order for a supported reader to rely on the header.

Every supported transition which advances `causalSummary` MUST, in the same atomic publication, advance `authorityClock` enough to cover the authority time of every newly represented observed event. Synchronization/source observation, direct EventRef observation, local event allocation, reset, migration from existing Journal 2, same-host restoration, and compaction must preserve this coupling. A transition must never publish a causal coordinate whose corresponding observed authority high-water has been forgotten.

This invariant is maintained by supported transition construction. Validation may reject locally witnessed violations, but is not required to reconstruct compacted-away events merely to re-prove it.

### J2-INV-8: frontier coordinates are causally represented

For every supported node summary `S[K]`, every author `A`, and both retained invalidation frontiers:

```text
S[K].nodeInvalidateFrontier[A]  <= header.causalSummary[A]
S[K].valueInvalidateFrontier[A] <= header.causalSummary[A]
```

Missing coordinates are zero. If a value-scoped frontier is absent because K is absent or has no retained current-value frontier, it contributes only zero coordinates.

A frontier coordinate is a claim that this database represents the corresponding invalidating event of author `A`. Every supported transition which folds a foreign frontier coordinate into a node summary MUST join the corresponding causal-summary coordinate in the same atomic publication. Local authoring, synchronization adoption, reset, migration from existing Journal 2, same-host restoration, and compaction must preserve this invariant.

Together with J2-INV-7, this guarantees that every retained frontier coordinate is both causally represented by the header and covered by its authority high-water knowledge, so `covers(C.event.context, F)` is meaningful for any retained frontier `F`.

### J2-INV-9: retained references are causally represented

Every retained head authority reference (`S[K].head.value` when present, `S[K].head.tombstone` when absent) and, when a certificate is present, `S[K].certificate.event`, satisfies:

```text
E.id.sequence <= header.causalSummary[E.id.author]
E.authorityTime <= header.authorityClock
```

where `E` denotes the retained reference being quantified and the second comparison is the canonical `AuthorityTime` order.

Every supported transition which installs or adopts a retained head or certificate reference MUST join that reference's writer coordinate and authority time into the header in the same atomic publication. Local authoring, synchronization adoption, reset, migration from existing Journal 2, same-host restoration, and compaction preserve this invariant.

Together with J2-INV-7, this makes the header a sufficient high-water summary of every retained semantic authority represented by the database. A consumer which joins a valid source header therefore observes at least the causal coordinate and authority time of every head/certificate reference retained in that source's node summaries.

### J2-INV-10: writer-local causal coordinate ownership

For every supported writable Journal 2 state:

```text
header.causalSummary[header.writer] == header.localJournalCounter
```

with a missing coordinate interpreted as zero. The writer's own causal coordinate is exactly its local event-allocation frontier. Local semantic event publication advances both fields to the same next sequence in one publication; ordinary source observation never raises the local writer coordinate independently.

Before a writable state R joins a source header S, the observing transition MUST require:

```text
S.causalSummary[R.header.writer] <= R.header.localJournalCounter
```

If this fails, S contains evidence of later same-writer history than R can safely continue. The transition rejects the observation rather than raising R's local counter, joining the greater own-writer coordinate, or allocating beneath it. This rule applies even when `S.header.writer != R.header.writer`, because a foreign writer may itself have observed later events from R's writer identity.

Fresh initialization, initial bootstrap, local event allocation, controlled reset, Journal-2-aware migration, synchronization, same-host restoration, and compaction preserve this invariant. Same-host restoration may resume an older authoritative published frontier only under the no-surviving-copy recovery rule in `incremental-graph-journal-reset.md`.

## Supported lifecycle

Correctness guarantees apply to states produced by supported Journal 2 authoring, synchronization, migration, reset, same-host restoration, and canonical compaction. Corrupt, forged, rolled-back, partially installed, or identity-colliding states are outside the semantic model and must be rejected where practical rather than assigned invented meaning.

A same-host first-boot restoration of saved Journal 2 state resumes the exact previously published writer state, including writer-local counters, incarnation, causal summary, authority-clock high-water mark, node summaries, and valid saved cursors. It does **not** mint a reset baseline merely because local live files were absent. A same-host saved state which predates Journal 2 may instead be restored as legacy state and then migrated through the normal migration gate before Journal 2 synchronization/reset is available.

Arbitrary rollback to an older same-writer snapshot is unsupported whenever later same-writer event/operation identities, incarnation state, or authority may survive outside that snapshot. Catastrophic same-host recovery may abandon a newer local-only tail only under the publication-before-propagation/no-surviving-copy rule defined by the lifecycle and reset specifications.

Controlled semantic reset is different: it requires a valid compatible Journal 2 source, intentionally replaces an already-established logical database, increments the local journal incarnation, deletes receiver-local source cursors, and mints a fresh reset baseline as specified by `incremental-graph-journal-reset.md`.

A migration whose input already contains Journal 2 also deletes all receiver-local stored source cursors atomically with the migrated state. It preserves the represented synchronization-relevant negative authority required by `incremental-graph-journal-migrations.md`; the ordinary materialized-node migration scope is not permission to discard retained tombstones or invalidation frontiers. The migration itself separately specifies whatever per-node Journal 2 transformations its schema/database change requires.

## Full sync before incremental sync

The normative semantic synchronization operation is full synchronization. It scans the complete current journal/graph semantic domain and does not require cursors.

Ordinary synchronization is between distinct Journal writer identities. Same-writer continuation is handled by restoration, while controlled reset may consume an older/equal same-writer source only under the additional allocator/incarnation preconditions in `incremental-graph-journal-reset.md`.

The journal change index and cursor machinery are an optimization. Incremental source discovery uses the private `possibleMaybeChanges(sourceSnapshot, cursor)` asynchronous iterator; it is not part of the public IncrementalGraph/computor API and does not materialize the complete changed-node range in RAM. A local reverse structural-edge index lets the receiver traverse only the dependent closure reached from changed nodes instead of scanning unrelated materialized nodes merely to discover reverse dependencies.

For a valid cursor, incremental synchronization must be observationally equivalent to the full operation from the same source and receiver states.

Receiver reset and migration from an already-Journal-2 state explicitly clear stored source cursors when they invalidate the receiver-side invariant those cursors certify. The next synchronization with each source falls back to full synchronization and may establish a fresh cursor after success. Incremental synchronization otherwise acquires required source payload/`modifiedAt` records while consuming `possibleMaybeChanges` from the same fixed caller-owned source snapshot; present-head `createdAt` travels inside the yielded node summary. Every handshake also transfers source causal and HLC authority header high-water state.

Journal 2 does not impose a synchronization-only provenance restriction on retained `oldValue`. A selected present `ValueId` is already a supported cached value of that semantic node. If its final inputs differ from the certificate basis, projection makes the node stale and removes incompatible validity edges; the ordinary next pull may then invoke the computor with the final inputs and that retained cache as `oldValue`. The computor's normal `Unchanged` contract decides whether the value can be reused for those current inputs. Consequently mixed replica provenance, concurrency, multiple inputs, and `"unknown"` bootstrap bases do not by themselves justify cache deletion.

Structural dependency closure remains separate: if a selected present node has a finally absent required input, synchronization must remove the non-materializable cache and author sufficient tombstone authority as specified by the full-sync normalization rules.

The current end-to-end synchronization complexity assumption is recorded by `$id-3572255392439745` in `docs/intent-records/synchronization-performance.md`; it is separate from the correctness equivalence above.

## Rejection conditions

Journal 2 uses the following canonical named rejection conditions so lifecycle incompatibility, failed preconditions, corruption/unsupported state, and unsupported manipulation remain distinguishable as required by `database-lifecycle.md` §14 rule 10. Implementations MUST surface these as distinguishable conditions; when represented as errors, the names below are the canonical error `.name` values.

| Condition | Meaning |
| --- | --- |
| `JournalWriterIdentityCollision` | An ordinary synchronization source claims the receiver's durable Journal writer identity but is not a valid same-host restoration or controlled-reset input. Ordinary sync rejects it rather than merging two histories into one writer dimension. This condition MUST be distinguishable from legitimate same-writer restoration/reset paths. |
| `JournalOwnWriterCoordinateError` | A source claims `causalSummary[receiver.writer] > receiver.localJournalCounter`, demonstrating later same-writer event history than the receiver can safely continue. |
| `JournalUncoveredReferenceError` | A retained source head/certificate EventRef is not covered by the source header as required by J2-INV-9. |
| `JournalEventIdentityConflictError` | Two retained/raw claims available to the transition use the same `JournalEventId` but disagree on immutable semantic event identity, including detectable same-`ValueId` payload/`modifiedAt` disagreement. |
| `JournalTimestampParseError` | A legacy `createdAt` or `modifiedAt` required for Journal bootstrap/projection cannot be converted by the canonical Journal timestamp conversion. |
| `JournalProjectionMismatchError` | A constructed migration/reset/synchronization target fails required graph/journal projection or physical-consistency validation before cutover. |
| `JournalResetSourceError` | A reset source is journal-less, pre-Journal-2, version/schema-incompatible, violates same-writer provenance, or is ahead of the receiver where the reset preconditions forbid that. |
| `JournalStructuralIndexError` | The required reverse structural-edge index is missing, malformed, or inconsistent with the materialized structural graph. |

These names classify Journal-specific failure conditions; they do not turn unsupported external manipulation into supported state or require exhaustive detection of corruption which is not locally observable. A transition which can directly detect one of these conditions must not silently relabel it as a successful no-op or arbitrary generic merge conflict.

## Transport independence

Git branches, hashes, commits, repository ancestry, checkpoint names, and transport ordering do not participate in journal identity or semantics. They may transport stable snapshots, but all journal reasoning uses only Journal 2 state and the IncrementalGraph schema.
