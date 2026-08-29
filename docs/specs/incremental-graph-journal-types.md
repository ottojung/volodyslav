# IncrementalGraph journal types

## Supported state and identity

This specification covers reachable states produced by atomic authoring, receive, migration, controlled reset, restoration, and canonical compaction. Corrupt, forged, rolled-back, partially installed, fingerprint-colliding, or clock-unsupported states are outside its proof domain. Each `DatabaseFingerprint` denotes one durable writer history.

```text
JournalSequence = positive arbitrary-precision integer
CausalCoordinate = non-negative arbitrary-precision integer
CausalPrefix = Map<DatabaseFingerprint,CausalCoordinate>
JournalEntryId = (author:DatabaseFingerprint, sequence:JournalSequence)
JournalEntryBase = {
    author, sequence, causalContext:CausalPrefix,
    nodeName, bindings, time:UnixTimestamp
}
GenerationJournalEntry = JournalEntryBase & {
    kind:"generation", initialFreshness:JournalEntryId
}
DeleteJournalEntry = JournalEntryBase & { kind:"delete", resetLineage?:ResetLineage }
ResetObservationEntry = JournalEntryBase & {
    kind:"reset-observation", absentAnchor:JournalEntryId|null,
    resetLineage:ResetLineage
}
GenerationScopedBase = JournalEntryBase & { generation:JournalEntryId }
EditJournalEntry = GenerationScopedBase & { kind:"edit" }
InvalidateJournalEntry = GenerationScopedBase & {
    kind:"invalidate", mode:"soft"|"hard",
    appliesTo:"generation"|{valueOrigin:JournalEntryId},
    resetLineage?:ResetLineage
}
ValidateJournalEntry = GenerationScopedBase & {
    kind:"validate", clearsThrough:CausalPrefix,
    valueOrigin:JournalEntryId, resetLineage?:ResetLineage
}
ResetLineage = {
    absorbsThrough:CausalPrefix,
    correspondence:ResetCorrespondence|null
}
ResetCorrespondence = {
    consumedGeneration:JournalEntryId,
    consumedValueOrigin:JournalEntryId
}
entryNodeKey(E) = NodeKey(E.nodeName,E.bindings)
```

`JournalEntryId` is an immutable identity and address. A `JournalSequence` has meaning only within its `DatabaseFingerprint` author. No algorithm compares sequence magnitudes from different authors as evidence of temporal, causal, revision, presence, conflict, or destructive precedence. Sequence supports same-author identity, order, frontiers, coverage, cursor progress, and monotonicity only.

`entryNodeKey` uses the normative identity-preserving serializer. `nodeName` and `bindings` are the sole persisted semantic address. Every boundary validates closed shapes, exact references, positive event coordinates, canonical vectors, and arbitrary-precision decimal encoding. Runtime implementations use `BigInt`, never lossy JavaScript `Number` conversion. Zero means missing vector knowledge and is never an event sequence.

## Causal context

`causalContext` is the immutable closed per-author causal prefix observed by the authoring operation before publication. Missing coordinates mean zero. For distinct events:

```text
causallyBefore(E,F) iff
    (E.author=F.author and E.sequence<F.sequence)
    or
    (E.author!=F.author and E.sequence<=F.causalContext[E.author])
```

Every writer persists `causalSummary`, the componentwise maximum of the causal contexts and identities of all events genuinely observed by committed local operations. It differs from `journalCoverage`: a summary proves happened-before knowledge, while coverage proves complete possession of a journal prefix. Import alone changes neither value; a receive, migration, or reset operation advances `causalSummary` only when its stable observed snapshot participates in a committed semantic decision. Reset may therefore learn source causality without importing source journal or coverage.

For every locally authored event E, `E.causalContext` is the transaction's observed causal summary before E. After publication the local summary includes E's identity. Consecutive same-author events carry forward every foreign coordinate componentwise, so learned causality cannot disappear. When an operation observes event F, it joins F's identity and every coordinate in `F.causalContext`; therefore A:10 observed by B:3 and B:3 observed by C:7 implies A:10 is in C:7's context. Compaction preserves `causalSummary` and immutable retained contexts. Repeating an operation with no new semantic decision or newly relevant causal knowledge is silent.

Ordinary graph authoring includes relevant knowledge in the transaction-visible database. Synchronization-authored barriers include the joined authority causing the decision. Migration-authored events include supported source authority used by the decision. Controlled reset includes the validated source snapshot it actually observes. Generation/initial-freshness and edit/post-edit-freshness pairs remain ordered by their common author's local sequences.

## Allocation, coverage, and persistence

`localJournalCounter` is the last coordinate allocated in the local fingerprint namespace. A fresh writer starts at zero and authors sequence 1. Under the allocator mutex each committed event takes the next local successor; imports and foreign coordinates never change the counter. Thus a B writer at B:4 next authors B:5 even after observing A:1000000. After local authoring, `journalCoverage[localFingerprint]=localJournalCounter`. Publication atomically commits graph, journal, counter, local coverage, causal metadata, identifiers, timestamps, and proofs.

`journalCoverage[A]=n` proves complete accounting for A's prefix through A:n despite compaction. `clearsThrough[A]=n` is narrower validation evidence: it proves that one validation may clear applicable A-authored invalidates through A:n. `absorbsThrough[A]=n` is reset semantics: it intentionally absorbs applicable A-authored history through A:n. These vectors are never interchangeable.

Restoration preserves the fingerprint, journal, coverage, local counter, and causal summary. It validates own counter/coverage consistency, positive event coordinates, per-author coverage, context shape and coordinates, references, and same-author monotone foreign-context carry-forward. If A authored through A:10, its next event is greater than 10; foreign magnitudes impose no condition.

## Event and value invariants

A generation records absent-to-present presence and its initial value. It names one later, atomically installed same-author validate or invalidate for the exact generation value origin. Delete records negative presence. Edit records an unequal present-to-present value change in the surviving generation. A stale post-edit value receives a later value-specific soft assertion when reusable proof remains, or hard assertion when recomputation is required. Equal-value operations emit no edit.

Generation-wide invalidates represent explicit semantic invalidation independent of value origin. Initial-stale, post-edit, reset/migration cache-status, proof-loss, and propagated-input assertions name one exact value origin. Validations likewise name the exact value origin they validate. Positive evidence never crosses an edit.

`modifiedAt` is semantic value occurrence time and resolves only causally concurrent semantic value changes. Delete and assertion `time` are their occurrence times. Causality is decided before time; time does not clear invalidations, establish proof, imply reset absorption, determine hardness, or prove observation. Supported executions use synchronized clocks and require causally later semantic events not to have earlier occurrence times. Exact concurrent equal-time conflicts use author fingerprint.

## Reset lineage

`causalContext` records what a reset assertion observed. `absorbsThrough` records source/history coordinates intentionally replaced. `ResetCorrespondence` records the exact source generation/value origin actually compared `isEqual` with the receiver anchor. Causal observation never implies semantic correspondence.

```text
absorbedBy(L,E) iff E.sequence <= L.absorbsThrough[E.author]
```

This comparison is within E's author coordinate. A later event above that author's absorbed prefix remains live irrespective of the reset carrier's author or sequence. Present reset lineage is attached to a retained receiver freshness assertion; present-to-absent lineage is attached to its public delete; absent-to-absent lineage uses an internal no-action reset observation anchored to a delete or explicit null absence. Reset does not import source journal or source coverage.

Assertions are ordered by ordinary event causality. Same-author assertions are ordered by local sequence; cross-author succession is recorded by `causalContext`. Causally maximal concurrent assertions resolve by occurrence time and then author fingerprint. Their `absorbsThrough` vectors may join only as semantic absorption for the same tagged receiver anchor and never prove assertion succession. Exact correspondences remain separately retained.

A reset is settled when the receiver semantic projection, freshness authority, required correspondence, absorption prefix, and causal knowledge relevant to future source union already equal the result of the validated snapshots. Repeating a settled reset emits nothing. Newly relevant observed source absorption or causality is retained even when graph bytes do not change.

## Freshness

```text
applicable(I,O) iff I.appliesTo="generation" or I.appliesTo.valueOrigin=O
invalidateFrontier(J,K,G,O)[A] = greatest applicable invalidate authored by A
hardInvalidateFrontier(J,K,G,O)[A] = greatest applicable hard invalidate authored by A
covers(V,I) iff V and I have the same key and generation
                 and I.sequence <= V.clearsThrough[I.author]
freshnessEffective(V,J,K,G,O) iff V.valueOrigin=O
                 and V alone covers every all-mode frontier member
journalHard iff the hard frontier is nonempty
                 and no applicable V alone covers every hard member
```

Every `greatest` above compares sequences from one author only. Partial validations do not combine. A delayed invalidate beneath a clearing coordinate is cleared; a later same-author invalidate is not. Validations for the same author/key/generation monotonically carry their prior `clearsThrough`, independent of value origin. A soft stale derived value requires complete reusable incoming proof; proof loss and zero-input stale state require hard authority. Hard-to-soft transition requires positive validation clearing the hard frontier before an uncovered soft assertion can represent the state. Imported hard authority is sufficient and is not echoed.

## Projection contracts

Presence selection precedes joined value provenance, coherence classification, and precedence among candidates eligible at that stage. A coherent derived cache may beat a newer unsupported cache; equal-time joined canonical provenance is not reassigned merely because another candidate is coherent. Proof transport is extensional: schema/bindings/direct-input structure must match, all direct-input and output values must be `isEqual`, and source proof must exist. Equality permits transport but never creates proof.

Polling hides raw IDs, generation, modes, causal contexts, and reset metadata. Storage-level `NodeIdentifier` incarnation remains distinct from semantic `NodeKey`; removal retires an identifier and rematerialization allocates another.
