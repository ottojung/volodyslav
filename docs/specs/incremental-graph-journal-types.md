# IncrementalGraph Journal 2 Types

## Primitive identities

```text
JournalAuthor            = DatabaseFingerprint
JournalSequence          = positive arbitrary-precision integer
JournalIncarnation       = positive arbitrary-precision integer
JournalEventId           = { author: JournalAuthor, sequence: JournalSequence }
CausalPrefix             = Map<JournalAuthor, JournalSequence>

CreationTime             = fixed-width canonical epoch-millisecond instant
AuthorityPhysicalTime    = fixed-width non-negative integer epoch milliseconds
AuthorityLogicalTime     = non-negative arbitrary-precision integer
AuthorityTime            = {
    physical: AuthorityPhysicalTime,
    logical: AuthorityLogicalTime
}

LocalOperationSequence   = positive arbitrary-precision integer
OperationId              = {
    author: JournalAuthor,
    sequence: LocalOperationSequence
}
DatabaseVersion          = bounded exact persisted global/version identity
MigrationId              = {
    fromVersion: DatabaseVersion,
    toVersion: DatabaseVersion
}
OperationTag             = bounded stable operation tag
```

`canonical(t)` is the Journal 2 conversion from one persisted legacy timestamp string to its exact epoch-millisecond instant. The input must be a valid ISO timestamp representing an instant exactly on a whole-millisecond boundary within the fixed-width non-negative epoch-millisecond domain used by `CreationTime` and `AuthorityPhysicalTime`. The conversion is a pure function of the persisted timestamp value: timezone-equivalent spellings of the same instant map to the same integer, and no hostname, local timezone, wall clock, locale, or current time participates.

A timestamp is rejected as malformed Journal state if it is unparseable, represents an instant before the Unix epoch, lies outside the fixed-width representable epoch-millisecond range, or contains sub-millisecond precision that is not exactly representable in that domain. Journal 2 does not clamp or round such input. Supported Volodyslav writers use the existing millisecond-precision ISO timestamp representation, so this rejection rule does not alter timestamps produced by the supported lifecycle.

`CreationTime` is the exact instant represented by a legacy `createdAt` after `canonical(t)`. `CreationTime` and `AuthorityPhysicalTime` are physical real-time values accounted as fixed-width `O(1)` serialized space under `$id-5823796411086523`. `CreationTime` is not an HLC coordinate or semantic event authority; `AuthorityPhysicalTime` is only the physical coordinate of `AuthorityTime`.

`DatabaseVersion` and `OperationTag` are fixed/bounded serialized primitive identifiers. They are not arbitrary user payload strings. `DatabaseVersion` is the exact database-version identity used by the lifecycle compatibility boundary.

A `MigrationId` is the exact ordered database-version transition `{ fromVersion, toVersion }`. It is available from the migration lifecycle itself and is stable across replicas without a separate migration registry, callback-derived tag, or ordering-dependent allocation. Two implementations which claim the same `MigrationId` are claiming to implement the same declared version transition. If migration semantics change incompatibly, the target `DatabaseVersion` must change rather than inventing a second hidden migration identity for the same version pair.

Missing coordinates in a `CausalPrefix` mean zero.

A journal cursor is meaningful only inside one `(sourceFingerprint, incarnation)` pair.

## Local sequence, causal context, and authority clock

Every writable database persists:

```text
localJournalCounter   : JournalSequence | 0
localOperationCounter : LocalOperationSequence | 0
causalSummary         : CausalPrefix
authorityClock        : AuthorityTime
journalIncarnation    : JournalIncarnation
```

Along one continuing writable history, both local counters are monotone, including across controlled reset. Same-host restoration is a recovery boundary: it may resume the authoritative previously published writer state and abandon a newer local-only tail only under the no-surviving-copy rule in `incremental-graph-journal-reset.md`. A numeric coordinate from such an abandoned tail may be allocated again only because no supported surviving state can contain the abandoned use of that coordinate. `OperationRecord.incarnation` records the journal incarnation in which an operation occurred; operation-sequence uniqueness does not depend on restarting the counter in a new incarnation.

Every supported writable Journal 2 state satisfies the writer-coordinate invariant:

```text
causalSummary[localFingerprint] == localJournalCounter
```

where a missing local causal coordinate means zero. The local writer's causal coordinate is therefore owned by its event allocator, not learned from another state.

The three event-ordering mechanisms have deliberately separate jobs:

- `JournalEventId.sequence` is a writer-local identity/order coordinate;
- `CausalPrefix` records exact happened-before knowledge across writers;
- `AuthorityTime` is a hybrid logical-clock coordinate used for deterministic conflict precedence.

A journal sequence from one writer is never numerically compared with a journal sequence from another writer for conflict authority.

### Observation

Before a writable database observes a source Journal 2 header, it MUST require:

```text
source.causalSummary[localFingerprint] <= localJournalCounter
```

If the source claims a greater coordinate for the observer's own writer identity, the observing operation fails before modifying local state. Such a source demonstrates same-writer history beyond the observer's allocation frontier; generic observation must not repair that condition by copying the greater coordinate into `causalSummary` or `localJournalCounter`. Supported same-host continuation/recovery is handled by the restoration rules, not by importing a later local-writer coordinate through observation.

After that precondition holds, observation joins:

```text
causalSummary := componentwiseMax(causalSummary, source.causalSummary)
authorityClock := maxAuthorityTime(authorityClock, source.authorityClock)
```

Because the source's coordinate for `localFingerprint` is no greater than `localJournalCounter`, this join leaves the observer's own causal coordinate unchanged and preserves the writer-coordinate invariant.

By J2-INV-9, every retained head/certificate reference in a supported source summary is already covered by that source header. A retained reference which is not covered indicates unsupported state; the observing transition rejects it rather than repairing the header by joining the reference.

Observation alone need not author a semantic event. The retained `authorityClock` is a high-water mark, not itself semantic graph authority.

Journal 2 deliberately defines no `MaxAuthoritySkew` or equivalent comparison with the observer's local wall clock. A far-future persisted timestamp or already-supported observed authority may raise `authorityClock` far ahead of local time; such skew may distort later concurrent conflict preference but is not by itself an unsupported-state condition. See `$id-3817813711344897`.

### Local semantic event allocation

Before authoring a local semantic journal event, allocate only the next writer-local sequence:

```text
nextSequence = localJournalCounter + 1
id = { author: localFingerprint, sequence: nextSequence }
context = causalSummary before publication
```

There is deliberately no `max(causalSummary[*])` term in `nextSequence`. Remote coordinates remain remote coordinates, and the observation precondition above prevents a remote/source header from advancing the local writer's causal coordinate beyond the allocator counter.

Except for the initial-bootstrap value rule below, every event also receives an `authorityTime` by advancing the persisted HLC. Let `seedPhysical` be:

- for a `ValueEvent`, `canonical(modifiedAt)` for the exact legacy value occurrence;
- for other locally authored semantic events, the operation/publication wall-clock time supplied by the existing datetime capability, converted to the same epoch-millisecond domain.

Advance the persisted HLC from its current high-water mark:

```text
p = max(seedPhysical, authorityClock.physical)

if p > authorityClock.physical:
    nextAuthorityTime = { physical: p, logical: 0 }
else:
    nextAuthorityTime = {
        physical: p,
        logical: authorityClock.logical + 1
    }
```

The event receives `authorityTime = nextAuthorityTime`.

After ordinary event publication:

```text
localJournalCounter = nextSequence
causalSummary[localFingerprint] = nextSequence
authorityClock = nextAuthorityTime
```

This advances the local counter and its owned causal coordinate together and therefore preserves the writer-coordinate invariant.

#### Initial bootstrap value authority

A `ValueEvent(reason="bootstrap")` authored by the initial pre-Journal-2 migration uses a deterministic authority time derived only from that value occurrence:

```text
nextAuthorityTime = {
    physical: canonical(modifiedAt),
    logical: 0
}
```

The event still receives the ordinary next writer-local sequence and causal context. Publication updates:

```text
localJournalCounter = nextSequence
causalSummary[localFingerprint] = nextSequence
authorityClock = maxAuthorityTime(authorityClock, nextAuthorityTime)
```

The bootstrap migration enumerates values by ascending `(modifiedAt, NodeKey)`, so bootstrap value authority never decreases in that writer's allocation order. Two bootstrap value events from the same writer MAY nevertheless have exactly the same `AuthorityTime` when their `modifiedAt` values tie. Their `EventRef`s are still strictly ordered because `authorityCompare` falls through to the equal author and then the increasing writer-local sequence. Therefore J2-INV-5 still holds, while J2-INV-7 needs only `event.authorityTime <= header.authorityClock` and also remains satisfied.

This exception prevents an unrelated bootstrap-only key from changing the authority time assigned to a shared value occurrence merely by appearing earlier in the local enumeration. It applies only to the initial bootstrap value pass. Reset and ordinary local authoring continue to use the general causality-adjusted HLC advance rule.

Multiple semantic events in one atomic transaction receive increasing local sequences in the deterministic semantic topological order specified by the emission specification. Ordinary later semantic events advance the HLC again; equal-time initial bootstrap value events may instead share an `AuthorityTime` while their complete EventRef authority still increases by writer-local sequence.

This is a hybrid logical clock in the sense relevant to Journal 2: ordinary concurrent value conflicts are normally ordered by their legacy modification times, while causal observation can push authority time forward so the authority order never contradicts happened-before.

Clock skew can therefore influence concurrent conflict selection. Journal 2 assumes non-adversarial persisted timestamps under the database lifecycle and does not claim that authority order is perfect physical-time recency. In particular, a sufficiently far-ahead timestamp or observed authority high-water mark can cause later events to derive authority primarily from the HLC high-water state rather than from their own `modifiedAt`; Journal 2 intentionally does not reject supported state solely for this condition.

High-level operation IDs use the separate `localOperationCounter`. Allocating an operation ID does **not** change `localJournalCounter`, `causalSummary`, `authorityClock`, semantic event authority, or happened-before. This separation is required so operation grouping cannot affect synchronization outcomes.

## Event references and immutable event identity

Every semantic authority reference is:

```text
EventRef = {
    id: JournalEventId,
    context: CausalPrefix,
    authorityTime: AuthorityTime
}
```

The context and authority time are immutable semantic metadata of the original event. Copying a reference through synchronization never changes them.

A `JournalEventId` identifies exactly one immutable semantic journal event. Any two supported representations which claim the same `JournalEventId` MUST agree on:

- immutable `context` and `authorityTime`;
- the event's `node` and semantic event `kind`; and
- every kind-specific semantic body field: `reason`, `value` and `basis` for validation, invalidation `scope`, and `source`/`adopted` information for adoption as applicable.

The optional `operation` grouping reference is historical-only metadata and is not part of this semantic event-identity invariant.

A compacted representation need not retain every raw event body merely to re-prove this invariant. But whenever a supported transition has two retained/raw structures which expose semantic claims about the same event ID, detectable disagreement means corrupt/unsupported state and MUST be rejected rather than resolved by authority tie-break, payload equality, or arbitrary choice.

In particular, two retained validation certificates whose `event.id` is equal MUST have the same event context/authority time, current-value target, and exact basis. Likewise, one `ValueId` cannot denote different nodes or different semantic value occurrences on different replicas.

## Exact happened-before

For distinct event references `E` and `F`:

```text
happenedBefore(E,F) iff
    E.id.author == F.id.author
        ? E.id.sequence < F.id.sequence
        : E.id.sequence <= F.context[E.id.author]
```

Cross-writer sequence magnitudes are used here only as coordinates inside the corresponding writer's vector-clock dimension. A larger sequence from another author does not by itself prove happened-before.

## Total authority order

Semantic conflict selection uses a total order over `EventRef`s:

```text
authorityCompare(E,F):
    compare E.authorityTime.physical and F.authorityTime.physical numerically;
    on equality compare E.authorityTime.logical and F.authorityTime.logical numerically;
    on equality compare E.id.author and F.id.author lexicographically;
    on equality compare E.id.sequence and F.id.sequence numerically
```

The final sequence comparison occurs only after writer fingerprints are equal, so it is strictly writer-local.

Because every local event joins all authority times it causally observes before advancing its HLC, except that equal-time initial-bootstrap events remain ordered by their same-writer sequence:

```text
happenedBefore(E,F)
    => authorityCompare(E,F) < 0
```

for all supported semantic events.

Thus exact causal knowledge has priority semantically: the HLC plus the remaining EventRef tie-breakers are constructed so the total comparator extends happened-before. Concurrent events fall back to their causality-adjusted physical time, then writer fingerprint, then writer-local sequence.

## Value identity

```text
ValueRef = EventRef
ValueId  = JournalEventId
```

A locally authored semantic value occurrence uses the ID of its `value` event as its `ValueId`.

The value payload is not part of `ValueRef` and is never journaled.

For supported state, one `ValueId` denotes one exact semantic value occurrence at one semantic `NodeKey`. Every replica currently materializing that `ValueId` must therefore hold the same exact payload and `modifiedAt` for that occurrence and preserve the same immutable `ValueRef.context` and `ValueRef.authorityTime`. This includes identity-preserving Journal-2-aware migrations: if a migration keeps a `ValueId`, its migration contract must guarantee replica-stable transformation of that payload and `modifiedAt`. Ordinary synchronization need not compare payloads to verify this invariant.

The legacy `createdAt` field is node-scoped metadata rather than value-occurrence identity. It is not compared, copied, or validated as part of `ValueId`; it is retained as `CreationTime` in `NodeJournalSummary` and merged by the materialization-lineage rule in `incremental-graph-journal-sync.md` and `incremental-graph-journal-projection.md`.

## Certificate basis

The graph schema determines one ordered list of distinct direct semantic input edges for every concrete node:

```text
inputEdges(K) = [D0, D1, ...]
```

The maximum list length is assumed bounded for the storage bound.

A certificate basis has one entry per `inputEdges(K)`:

```text
BasisEntry = ValueId | "unknown"
```

`"unknown"` is a bounded sentinel used by bootstrap, reset, or migration when a supported baseline transition must represent an absent incoming validity proof but the historical value occurrence against which it was last valid is unavailable.

```text
ValidationCertificate = {
    event: EventRef,
    value: ValueId,
    basis: Array<BasisEntry>
}
```

The certificate's own causal context is the clearing evidence for invalidations it genuinely observed. Separate `clearsThrough` metadata is unnecessary in Journal 2.

For a fixed current value, only the greatest certificate by `authorityCompare(certificate.event, ...)` is semantically active. If two represented certificates have the same `event.id`, the immutable-event-identity rule above requires their `value` and `basis` to be identical; disagreement is unsupported state, not a certificate tie to resolve. Lower certificates remain historical until compaction but are not consulted by projection or synchronization.

## Invalidation scopes

```text
InvalidateScope =
    | { kind: "node" }
    | { kind: "value", value: ValueId }
```

- node-scoped invalidation is authority independent of the selected current value; it includes ordinary explicit/direct invalidation and conservative bootstrap/migration invalidation roots, and breaks incoming proof until covered by a later certificate;
- value-scoped invalidation marks one cached value stale while preserving its incoming proof where still compatible.

Compacted summaries store invalidation frontiers instead of individual old invalidates:

```text
nodeInvalidateFrontier  : CausalPrefix
valueInvalidateFrontier : CausalPrefix
```

The value-specific frontier exists only for the currently selected present `ValueId`. It is discarded when that value can no longer become current.

## Semantic state head

```text
PresentHead = {
    kind: "present",
    value: ValueRef
}

AbsentHead = {
    kind: "absent",
    tombstone: EventRef
}

SemanticHead = PresentHead | AbsentHead
```

The head authority reference is `value` for present state and `tombstone` for absent state.

When two heads compete, compare those `EventRef`s with `authorityCompare`; the greater authority wins. If two heads expose the same `JournalEventId`, the immutable-event-identity rule requires them to describe the same semantic event/node/head meaning; disagreement is unsupported state. A normal synchronization adoption preserves the winning foreign head exactly; the local adoption event does not become the new head.

## Per-node compacted summary

```text
NodeJournalSummary = {
    node: NodeKey,
    head: SemanticHead,

    nodeInvalidateFrontier: CausalPrefix,

    // Present only when head.kind == "present".
    certificate?: ValidationCertificate,
    valueInvalidateFrontier?: CausalPrefix,
    createdAt?: CreationTime,

    // Local change-index coordinate, never imported as semantic authority.
    lastLocalChange: JournalSequence
}
```

The `certificate`, when present, must name the current `head.value.id`. `createdAt` is present exactly when the head is present. It is the materialization-lineage creation timestamp carried by the current present head: ordinary local value changes and identity-preserving migrations which keep K continuously materialized carry that timestamp forward, deletion clears it, and a later materialization from absence starts a new timestamp. Synchronization chooses the winning head first and combines `createdAt` only between copies of that same selected head. Thus the timestamp is node/materialization metadata inherited by a succession of local heads, not part of `ValueId` and not Journal event authority.

The two invalidation vectors and the contexts inside the current value/certificate dominate the summary size. `authorityTime` contains one fixed-width `O(1)` physical coordinate and one `O(log H)` logical coordinate, so it costs `O(log H)` bits overall. `createdAt` contributes one fixed-width `CreationTime`, hence `O(1)` serialized bits under `$id-5823796411086523`. With `R >= 1` and `H >= 2`, these scalar terms are subsumed by the `O(R log H)` summary bound. Under bounded NodeKey and in-degree assumptions, one summary is therefore `O(R log H)` bits.

## High-level operation records

Journal 2 preserves a lightweight distinction between a high-level local operation and the low-level semantic events produced by that operation.

A source-bearing operation uses:

```text
OperationSourceRef = {
    databaseVersion: DatabaseVersion,
    writer: JournalAuthor,
    incarnation: JournalIncarnation,
    through: JournalSequence | 0,
    causalSummary: CausalPrefix,
    authorityClock: AuthorityTime
}
```

Journal 2 source-bearing operations require a valid Journal 2 source snapshot. `databaseVersion` is the exact database version under which that source snapshot was interpreted by the operation. The remaining fields record the synchronization-relevant Journal 2 header state of the same stable source snapshot: `through` identifies the source's local semantic head, while `causalSummary` and `authorityClock` capture causal/authority knowledge which may grow without advancing that local head.

Together these fields identify the supported source invocation state relevant to synchronization/reset history. A Journal-2-aware migration may change `databaseVersion` while preserving the writer, incarnation, journal counter, causal summary, and authority clock, so version is not derivable from the Journal header coordinates and MUST be recorded separately.

No separate graph-schema field is required in `OperationSourceRef`. Under `database-lifecycle.md`, database version is the compatibility boundary identifying the interpretation of synchronized graph state, and a supported synchronization/reset source must independently satisfy the exact graph-schema precondition for that version. A snapshot whose persisted graph scheme does not match the schema accepted for its database version is not a supported source invocation merely because its Journal header fields match.

Operation records are a tagged union:

```text
OperationRecordBase = {
    id: OperationId,
    incarnation: JournalIncarnation,

    // Optional direct high-level caller. This is historical structure only.
    parent?: OperationId
}

OperationRecord =
    | OperationRecordBase & {
        kind: "pull",
        subject: NodeKey
      }
    | OperationRecordBase & {
        kind: "invalidate",
        subject: NodeKey
      }
    | OperationRecordBase & {
        kind: "synchronize",
        source: OperationSourceRef
      }
    | OperationRecordBase & {
        kind: "reset",
        source: OperationSourceRef
      }
    | OperationRecordBase & {
        kind: "migration",
        migration: MigrationId
      }
    | OperationRecordBase & {
        kind: "other",
        tag: OperationTag,
        subject?: NodeKey
      }
```

`OperationRecord.incarnation` is the local journal incarnation in which that high-level operation was recorded. It is historical metadata and is not part of `OperationId` equality. Because `localOperationCounter` is monotone across controlled reset, `{ author, sequence }` is already a unique operation identity along the continuing writer history.

An operation record is local historical/debugging structure. It is **not** synchronization authority, has no causal authority of its own, and is never imported as semantic state. A source-bearing operation record may nevertheless store source causal/authority high-water metadata as bounded historical invocation metadata.

The tagged fields identify the high-level invocation itself rather than only its operation kind. In particular, synchronization/reset records identify their source database version and synchronization-relevant snapshot state, and migration records identify the exact source-to-target database-version transition being run.

`parent`, when present, names the direct high-level caller known to the implementation. It does not imply semantic happened-before, does not affect event authority, and does not require the parent record to enumerate children. Parent recording is optional because independently committing nested operations need not share one publication transaction; Journal 2 does not require a complete transitive call tree.

A high-level operation may compile into arbitrarily many low-level semantic events. The operation record MUST NOT contain an array of all compiled events because that could make one LevelDB value proportional to graph size. Instead each low-level event produced directly by the operation carries the same optional `operation: OperationId` reference. The conceptual expansion is recovered from the event list by grouping those small records while the referenced operation record remains available.

Nested operations may have distinct operation IDs. The specification does not require one parent operation record to enumerate all recursively nested operation IDs.

Compaction may discard old operation records independently of retained raw events. If a retained `operation` or `parent` reference names a record already discarded by compaction, that grouping edge is simply unavailable to historical readers. Operation grouping has no role in the compacted synchronization meaning.

## Historical semantic events

All raw low-level semantic events have this base:

```text
JournalEventBase = {
    id: JournalEventId,
    context: CausalPrefix,
    authorityTime: AuthorityTime,
    node: NodeKey,
    operation?: OperationId
}
```

Kinds:

```text
ValueEvent = JournalEventBase & {
    kind: "value",
    reason: "compute" | "bootstrap" | "reset" | "migration"
}

DeleteEvent = JournalEventBase & {
    kind: "delete",
    reason: "sync-discard" | "reset" | "migration"
}

ValidateEvent = JournalEventBase & {
    kind: "validate",
    value: ValueId,
    basis: Array<BasisEntry>,
    reason: "compute" | "unchanged" | "cache-revalidate" | "bootstrap" | "reset" | "migration"
}

InvalidateEvent = JournalEventBase & {
    kind: "invalidate",
    scope: InvalidateScope,
    reason: "explicit" | "propagated" | "sync" | "bootstrap" | "reset" | "migration"
}

AdoptEvent = JournalEventBase & {
    kind: "adopt",
    source: JournalAuthor,
    // Bounded semantic metadata sufficient to fold the adopted node summary.
    adopted: NodeJournalSemanticPart
}
```

`InvalidateEvent.reason` records why the event was authored; `scope` determines its projection semantics. Initial bootstrap uses both scopes for each legacy-stale node: a conservative node-scoped `reason="bootstrap"` invalidation is authored before that node's bootstrap certificate, and a value-scoped `reason="bootstrap"` invalidation is authored after the certificate to preserve stale freshness. Reset stale-baseline invalidations are value-scoped. Journal-2-aware migration may author either node-scoped or value-scoped `reason="migration"` invalidations according to the migration semantics specified in `incremental-graph-journal-migrations.md`.

`NodeJournalSemanticPart` is `NodeJournalSummary` without `node` and `lastLocalChange`; it therefore includes the present-head `createdAt` field. A change to `createdAt` is a semantic-part change for incremental change discovery even though `createdAt` itself carries no Journal event authority.

An `AdoptEvent` is local history but creates no new foreign value, certificate, invalidation, tombstone, or creation-time authority. It records that bounded source semantic state became represented by this database.

The optional `operation` field has no effect on folding, authority, projection, synchronization, compaction correctness, or causality.

## Header and change index

```text
JournalHeader = {
    writer: JournalAuthor,
    journalIncarnation: JournalIncarnation,
    localJournalCounter: JournalSequence | 0,
    localOperationCounter: LocalOperationSequence | 0,
    causalSummary: CausalPrefix,
    authorityClock: AuthorityTime
}
```

`authorityClock` is the greatest HLC authority time authored or observed by this database. It can advance when source causal/authority knowledge is observed even when no local semantic event is authored.

The compacted change index has exactly one live marker per represented node:

```text
ChangedNodeMarker = {
    node: NodeKey,
    sequence: JournalSequence
}
```

The marker sequence equals `NodeJournalSummary.lastLocalChange`. When the node summary changes locally, the old marker is removed and a new marker at the new local semantic-event sequence is inserted atomically.

## Cursor

```text
JournalCursor = {
    source: JournalAuthor,
    incarnation: JournalIncarnation,
    through: JournalSequence | 0
}
```

A cursor is valid only for the same **source** writer and source incarnation. `through` is explicitly that source writer's local journal coordinate. Canonical compaction does not invalidate a cursor. Ordinary synchronization establishes cursors only for a source writer distinct from the receiver's own writer; same-writer continuation is restoration/reset territory rather than an incremental synchronization relationship.

If that source performs controlled reset, its changed source journal incarnation invalidates cursors about it by field comparison.

If the receiver performs controlled reset, its stored cursors about other sources are not invalidated by their fields; the reset protocol explicitly deletes those receiver-local cursor records because the receiver no longer satisfies their incorporated-state invariant.

## Storage-domain restrictions

Journal records contain only bounded primitive tags, NodeKeys, IDs/counters, authority-clock scalars, fixed-width physical-time scalars such as `CreationTime`, causal vectors, bounded input-version arrays, and small operation-grouping records/references. They contain no `ComputedValue`, no copy of `values[id]`, and no graph-wide collection proportional to N or event history in one LevelDB value.
