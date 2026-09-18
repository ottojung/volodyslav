# IncrementalGraph Journal 3 Types

## Primitive identities

```text
JournalAuthor   = DatabaseFingerprint
JournalSequence = positive arbitrary-precision integer

JournalRecordId = {
    author: JournalAuthor,
    sequence: JournalSequence
}

JournalFrontier = Map<JournalAuthor, JournalSequence>

AuthorityPhysicalTime = fixed-width non-negative epoch milliseconds
AuthorityLogicalTime  = non-negative arbitrary-precision integer
AuthorityTime = {
    physical: AuthorityPhysicalTime,
    logical: AuthorityLogicalTime
}
```

Missing frontier coordinates mean zero.

A writer A owns one contiguous stream:

```text
A:1, A:2, ..., A:n
```

A supported committed stream contains no holes.

## Retained JournalReplica

Conceptually:

```text
JournalReplica = Map<JournalAuthor, Array<JournalRecord>>
```

where every array is exactly one immutable prefix.

The physical key/value layout is implementation-defined, but it must support ordered per-writer range iteration without requiring the complete journal in RAM.

A supported retained journal satisfies:

1. record `(A,q)` has `id.author == A` and `id.sequence == q`;
2. for every retained A, every sequence `1..frontier[A]` exists;
3. one `JournalRecordId` identifies one journal record across compatible supported states, as required by `$id-2567281946348705`;
4. every retained semantic-event context is a causally closed frontier covered by the retained journal;
5. every retained record is encoded in the one canonical format selected by the replica's current `global/version`.

## Single current record format

Journal records do not carry a per-record format/version discriminator.

The existing database `global/version` value selects the representation of the entire active replica, including journal records and journal-derived metadata. A supported current replica therefore never contains a mixture of old/new journal record formats and ordinary replay never upcasts or downcasts individual records.

A version migration which changes journal representation rewrites every retained record into the target version's canonical format before target cutover. That rewrite may change/add/remove representation fields, but for every pre-existing record it preserves:

- `JournalRecordId`;
- the historical semantic fact represented by that ID;
- causal context/authority meaning;
- ValueId and other cross-record reference identity.

The rewrite contract is total over the **retained source-version record domain**, not merely over nodes which still exist in the target schema. Historical ValueEvents, NodeKeys, validation bases, and other records for a node family removed from the target graph must still have one deterministic target-format representation. Target-schema membership is not a prerequisite for preserving historical bytes/meaning. If a source->target migration cannot define such a total deterministic rewrite, that database-version migration is unsupported and must fail before cutover.

The old active replica and the inactive migration target may temporarily use different whole-database formats while migration is in progress. Each replica itself remains homogeneous.

## Record classes

Core Journal 3 records are:

```text
JournalRecord = SemanticEvent | WriterStateRecord
```

High-level operation/tracing records may be added later as additional immutable non-semantic record classes.

Every record starts with:

```text
JournalRecordBase = {
    id: JournalRecordId
}
```

All local record classes consume writer-local stream positions. Therefore `JournalSequence` is a log coordinate, not a count of semantic value changes.

## Semantic EventRef
Semantic events additionally carry:

```text
EventRef = {
    id: JournalRecordId,
    context: JournalFrontier,
    authorityTime: AuthorityTime
}
```

`context` and `authorityTime` are immutable event meaning.

Two current-format representations claiming one semantic event ID must agree on:

- context;
- authority time;
- node;
- event kind;
- every kind-specific semantic field.

Disagreement is a writer fork/corruption error, not a graph conflict.

## Value identity

```text
ValueId = JournalRecordId
```

A `ValueId` is valid only when its record is a `ValueEvent`.

One ValueId denotes exactly one immutable semantic value occurrence for one semantic `NodeKey`.

Because `ValueId = JournalRecordId`, ValueId inherits `$id-2567281946348705`: across compatible supported states, the same ValueId identifies the same ValueEvent/value occurrence, and distinct ValueEvents cannot share one ValueId.

Payload equality never creates ValueId equality.

## Timestamp representation

```text
CreationTime = fixed-width canonical whole-millisecond epoch instant
ModifiedTime = fixed-width canonical whole-millisecond epoch instant
```

Canonical conversion from legacy timestamp strings is pure/timezone-independent.

Supported records reject malformed or non-exactly-representable timestamps and value occurrences with:

```text
createdAt > modifiedAt
```

Physical time is fixed-width for asymptotic accounting. History growth appears in journal sequence and HLC logical coordinates.

## SemanticEventBase

```text
SemanticEventBase = JournalRecordBase & {
    context: JournalFrontier,
    authorityTime: AuthorityTime,
    node: NodeKey
}
```

Core semantic events are:

```text
SemanticEvent =
    | ValueEvent
    | DeleteEvent
    | ValidateEvent
    | InvalidateEvent
```

## ValueEvent

```text
ValueEvent = SemanticEventBase & {
    kind: "value",
    nodeIdentifier: NodeIdentifier,
    payload: ComputedValue,
    createdAt: CreationTime,
    modifiedAt: ModifiedTime,
    reason: "compute" | "bootstrap" | "reset" | "migration"
}
```

`ValueEvent.id` is the exact ValueId.

The event is replay-complete: replay must not read mutable `values`/`timestamps` to discover this occurrence's payload/timestamps.

For a continuing materialization lineage, local semantic replacement normally preserves the current `createdAt` and `NodeIdentifier` while creating a new payload/`modifiedAt` occurrence.

Deletion ends that materialization lineage. Later materialization from semantic absence follows ordinary graph rules for a new creation time/identifier allocation.

Synchronization copies a foreign ValueEvent unchanged. Receipt does not create another local ValueEvent.

Reset/bootstrap/migration may create a new ValueEvent carrying an already-existing physical NodeIdentifier only when the applicable lifecycle rule genuinely creates or replaces the semantic value occurrence. The new event ID is then a distinct ValueId. Proof/freshness-only changes and whole-Journal representation rewriting preserve the existing ValueId.

## NodeIdentifier uniqueness basis

Journal 3 relies on the existing NodeIdentifier allocation contract rather than establishing uniqueness by rescanning historical ValueEvents. The normative uniqueness requirement is `$id-4173361406347342`.

Conceptually a locally allocated NodeIdentifier combines:

```text
(DatabaseFingerprint, local allocation index)
```

The database-fingerprint intent explicitly accepts the negligible probability of two independently-created hosts receiving the same fingerprint. Within one continuing fingerprint namespace, a local allocation index is never reallocated while the earlier allocation can exist in, or later enter, supported retained history.

During normal operation and every supported transition of an existing database, `last_node_index` is monotone. Continuation-safe restoration of a completely absent installation is the deliberate exception: restoration may return to an older writer prefix and reconstruct the allocator watermark from that prefix. Indices allocated only in the discarded local suffix may be reallocated exactly when `incremental-graph-journal-lifecycle.md` §4.1 guarantees that the old suffix cannot later enter supported retained history.

Therefore NodeIdentifiers are treated as unique across every set of histories that can coexist in or later join supported retained state, under the project's accepted fingerprint-collision assumption plus this allocation rule.

This is a **supported-history uniqueness** invariant, not a "never physically issued twice" invariant over allocations confined to history that is permanently discarded by a continuation-safe lifecycle transition.

Restoration and migration must reconstruct the allocator watermark required by the retained local-writer history before that writer may allocate again. Observable reuse of one physical identifier for incompatible semantic nodes within supported retained history remains corruption, but historical replay does not need a second independent uniqueness mechanism beyond the allocator/fingerprint invariant.

## DeleteEvent

```text
DeleteEvent = SemanticEventBase & {
    kind: "delete",
    reason: "operation" | "reset" | "migration" | "sync"
}
```

DeleteEvent is semantic absence authority for its NodeKey.

It never erases old ValueEvents/payloads from history.

## Self-describing validation basis

A replay log must preserve what one historical validation actually claimed without requiring future software to recover the graph schema which happened to be active when that validation was authored.

Therefore validation bases name semantic input nodes explicitly:

```text
ValidationBasisValue = ValueId | "unknown"

ValidationBasisEntry = {
    input: NodeKey,
    value: ValidationBasisValue
}

ValidationBasis = Array<ValidationBasisEntry>
```

A basis has at most one entry for each semantic input NodeKey.

For a normal Journal-3-native validation under current schema with distinct direct edges:

```text
inputEdges(K) = [D0, D1, ...]
```

its basis contains exactly one entry for every current direct input:

```text
[
    { input: D0, value: currentValueId(D0) },
    { input: D1, value: currentValueId(D1) },
    ...
]
```

The displayed `D0,D1,...` order is illustrative only.

### Canonical NodeKey order

For the current database format, persisted `ValidationBasis` entries are ordered by the canonical persisted semantic identity of their NodeKey:

```text
nodeKeyOrder(A,B) =
    lexicographicCompare(
        nodeKeyStringToString(serializeNodeKey(A)),
        nodeKeyStringToString(serializeNodeKey(B))
    )
```

using the same JavaScript string lexicographic ordering as the current `compareNodeKeyStringByNodeKey` storage comparator.

This is deliberately the order of canonical persisted `NodeKeyString` identities, not the separate typed `compareNodeKey()` ordering. The ordering is independent of graph-schema input position.

If a future database version changes NodeKey representation/order, migration rewrites all retained affected journal records into that version's one canonical representation; current replay is not required to retain an eternal per-record v1 ordering rule.

Replay meaning is keyed by the explicit `input` NodeKey. Canonical NodeKey ordering gives one stable serialization/meaning for the current database representation without possessing the historical schema that authored the certificate.

The current schema is used separately to determine whether the certificate's explicit input-key set is complete/applicable to the current node interpretation.

`"unknown"` is restricted to controlled bootstrap/reset/migration baselines which must reproduce an intentionally missing legacy validity proof when the exact historical occurrence against which that proof was absent is unavailable.

`"unknown"` never equals a ValueId and therefore produces no incoming validity edge.

A normal compute/unchanged/cache-revalidate certificate must not use `"unknown"`.

## ValidateEvent

```text
ValidateEvent = SemanticEventBase & {
    kind: "validate",
    value: ValueId,
    basis: ValidationBasis,
    reason: "compute" | "unchanged" | "cache-revalidate" | "bootstrap" | "reset" | "migration"
}
```

A validation applies only to its named value occurrence.

Its `value` must name a retained ValueEvent for the same semantic node and must causally precede the validation as specified by `incremental-graph-journal-well-formedness.md`.

Every non-unknown basis entry must name a causally prior retained ValueEvent whose semantic node equals that entry's explicit `input` NodeKey.

A newly computed changed value normally authors its ValueEvent before this ValidateEvent. `Unchanged`/cache revalidation author a new validation for the existing ValueId without a new ValueEvent.

## Invalidation scopes

```text
InvalidateScope =
    | { kind: "node" }
    | { kind: "value", value: ValueId }
    | { kind: "proof", value: ValueId, input: NodeKey }
```

The three scopes deliberately represent different semantic facts.

### Node scope

Node-scoped invalidation is independent of the selected value occurrence.

It represents direct/explicit invalidation of the node's incoming cache proof. A validation clears its effect only when the validation causally observes/covers that invalidation.

Because the invalidation is node-wide, a concurrent certificate for another value occurrence which did not observe it is also ineligible. This is intentional for true explicit invalidation and is why maintenance-only proof weakening must not use node scope.

### Value scope

Value-scoped invalidation marks one exact cached occurrence stale without removing its incoming validity proof by itself.

It represents persistent freshness transitions such as propagated invalidation, synchronization propagation, or stale baseline state.

It stops applying when another ValueId becomes the selected current occurrence.

### Proof scope

Proof-scoped invalidation is an occurrence-and-input-specific **proof-edge barrier**:

```text
{ kind: "proof", value: V, input: D }
```

It means that the incoming proof edge `D -> K` for exact occurrence V no longer counts unless a validation which causally observes the barrier explicitly re-establishes that edge.

The barrier is evaluated per basis entry rather than making the whole certificate ineligible. Thus concurrent maintenance on the same V composes monotonically: barriers for different inputs remove the union of those proof edges, while an unrelated retained edge remains usable. Two replicas which independently remove the same input proof do not invalidate each other's otherwise identical target certificates merely because the barriers are concurrent.

A proof-edge barrier does **not** by itself mean V carries a persistent stale flag independent of proof. Persistent freshness uses value scope. It also does not affect certificates for another ValueId selected later or concurrently.

Core Journal 3 uses proof scope for maintenance-only proof weakening in bootstrap/reset/migration. Ordinary explicit invalidation remains node-scoped.

## InvalidateEvent

```text
InvalidateEvent = SemanticEventBase & {
    kind: "invalidate",
    scope: InvalidateScope,
    reason: "explicit" | "propagated" | "sync" | "bootstrap" | "reset" | "migration"
}
```

`reason` is historical/debugging classification. Replay behavior comes from scope, causality, selected value, input edge, and certificates.

A value-scoped or proof-scoped invalidation must name a causally prior retained ValueEvent for the same semantic node. A proof scope's `input` is a semantic NodeKey naming the incoming proof edge being retired; it need not name a currently selected input occurrence.

## WriterStateRecord

Host-local allocation metadata must also be replayable.

Core Journal 3 defines:

```text
WriterStateRecord = JournalRecordBase & {
    kind: "writer-state",
    lastNodeIndex: non-negative integer
}
```

A writer-state record is authored only in its own writer stream.

Within one supported retained writer stream, `lastNodeIndex` records are monotone nondecreasing. Continuation-safe absent restoration may discard an unrecoverable suffix and later reuse its writer coordinates; only the retained/restored stream participates in this monotonicity check.

Foreign writer-state records are retained/relayed but never replace the receiver's own `last_node_index`.

When a local publication durably advances the local allocation watermark, that publication records a writer-state value sufficient for replay to reconstruct the resulting watermark.

## Causal context

For distinct semantic events E and F:

```text
happenedBefore(E,F) iff
    E.id.author == F.id.author
        ? E.id.sequence < F.id.sequence
        : E.id.sequence <= F.context[E.id.author]
```

Same-writer semantic order follows immutable writer-stream order even when non-semantic records lie between two events.

For ordinary Journal authoring, a semantic event's `context` is a **causally closed journal frontier** describing every journal record the event's writer semantically observed before that event, extended with earlier records from the same atomic publication.

For semantic event F with:

```text
F.id = (W,q)
```

its own-writer coordinate is exact:

```text
F.context[W] == q - 1
```

because a writer necessarily observes its complete already-committed local prefix and every earlier record allocated in the same serialized publication.

Cross-writer coordinates must themselves be closed under the causal observations of the included semantic events. Formally, for every retained semantic event E such that:

```text
E.id.sequence <= F.context[E.id.author]
```

F must include everything E had observed:

```text
for every writer A:
    E.context[A] <= F.context[A]
```

Therefore if:

```text
happenedBefore(E,F)
happenedBefore(F,G)
```

then:

```text
happenedBefore(E,G)
```

for every supported journal. `happenedBefore` is a genuine transitive partial order, not merely a direct-observation relation.

Every context coordinate must be retained in a supported journal. A context which points at retained records but omits a causal predecessor of an included semantic event is malformed even though all of its numerical coordinates are individually in range.

### Historical bootstrap conversion exception

The initial conversion of a pre-Journal legacy value occurrence is the only case where **migration execution read order is not itself semantic observation**.

A `ValueEvent(reason="bootstrap")` produced from legacy state represents the historical value occurrence, not a new value write performed at upgrade time. Therefore the bootstrap rules in `incremental-graph-journal-migrations.md` may intentionally omit canonical bootstrap records from a joining legacy ValueEvent's cross-writer context so a pre-existing divergent legacy occurrence remains concurrent with the canonical occurrence.

The resulting context must still satisfy all structural Journal rules:

- exact own-writer prefix `q-1`;
- transitive closure over every coordinate it does include;
- no impossible references;
- authority extending every actual happened-before predecessor.

No ordinary pull, synchronization, reset, or Journal-aware migration may use this exception. Bootstrap Validate/Invalidate records authored after legacy value conversion use normal complete causal observation of the value records they reference.

## Ordinary authority allocation

Each writable database maintains an observed semantic-authority high-water H equal to at least the greatest `AuthorityTime` among semantic events it has observed. H is persisted as committed-pair metadata and is not derived from retained history during routine open.

For an ordinary new semantic event choose `seedPhysical`:

- exact `modifiedAt` for ValueEvent;
- operation/publication wall-clock instant for other events.

Allocate:

```text
p = max(seedPhysical, H.physical)

if p > H.physical:
    nextAuthorityTime = { physical: p, logical: 0 }
else:
    nextAuthorityTime = {
        physical: p,
        logical: H.logical + 1
    }
```

Then advance H to at least that authority.

The high-water is allocator state, not independent semantic authority. Every local publication and maintenance cutover updates/persists it atomically with the selected Journal/projection pair so routine open reads it without scanning retained history, as required by `$id-7429043816351276`.

Reconstruction from retained semantic events is reserved for explicit rebuild, absent restoration, bootstrap, and migration/maintenance transitions whose contracts permit history-sized work; it is not the ordinary-open path.

Journal 3 imposes no maximum-clock-skew rejection rule.

## Pre-Journal bootstrap ValueEvent authority exception

Only ValueEvents converting pre-Journal legacy occurrences as defined by `incremental-graph-journal-migrations.md` may allocate:

```text
authorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

without first joining migration execution time or an already-read canonical foreign high-water.

This applies both to the canonical creator's baseline ValueEvents and to a late joiner's genuinely different legacy ValueEvents.

The exception is valid because:

1. these events represent pre-existing legacy value versions whose `modifiedAt` is the conflict-version coordinate;
2. each writer enumerates its bootstrap ValueEvents in nondecreasing `(modifiedAt, canonical NodeKey)` order;
3. equal-time same-writer events remain strictly ordered by writer-local sequence in the total EventRef authority order;
4. a joining legacy ValueEvent does not claim happened-before over the canonical conflicting occurrence merely because migration read it;
5. later bootstrap Validate/Invalidate events return to ordinary HLC allocation after high-water is raised to include the canonical cut and all bootstrap ValueEvents they causally observe.

No ordinary pull, sync, reset, or later Journal-aware migration may use this exception.

## Total semantic authority order

Conflict precedence compares EventRefs by:

```text
authorityCompare(E,F):
    1. authorityTime.physical numerically
    2. authorityTime.logical numerically
    3. id.author lexicographically
    4. id.sequence numerically
```

Sequence is compared only after author equality (because distinct writers have distinct author strings at step 3).

For every supported pair:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

Ordinary HLC allocation guarantees this across observed writers and unequal/successive authority coordinates; bootstrap's equal-time same-writer case is completed by step 4.

Concurrent events are deterministically ordered by this rule. The order is conflict authority, not guaranteed real-world chronology.

## Publication ordering

One atomic local publication allocates a contiguous writer sequence range in deterministic order extending semantic dependency/happened-before constraints.

At minimum:

- a ValueEvent precedes each same-publication ValidateEvent naming its new ValueId;
- every same-publication input ValueEvent referenced by a validation basis precedes that validation;
- a root/direct change precedes propagated invalidations caused by it;
- a dependency structural deletion precedes dependent deletions authored solely because of that absence;
- a record never references a same-publication record allocated after it.

When semantics do not constrain two records, use a stable operation-specific ordering, normally canonical NodeKey then record kind.

Final sequence allocation occurs during serialized publication finalization as defined by the Journal API/locking specs, so failed transactions leave no durable holes.

## Frontier join

For compatible frontiers F and G:

```text
join(F,G)[A] = max(F[A], G[A])
```

A numerical frontier is meaningful only together with actual immutable records through every coordinate.

If two causally closed prefix journals have agreeing overlap, the union represented by the componentwise max is causally closed.

At retained-information level, compatible prefix union is:

- idempotent;
- commutative;
- associative.
