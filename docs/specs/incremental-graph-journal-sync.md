# IncrementalGraph Journal 2 Synchronization

## Purpose

This specification defines the semantic full synchronization operation for Journal 2. It is independent of Git transport and operates on two stable Journal 2/legacy graph snapshots with the same database/schema version.

The source is read-only. The receiver may publish a new inactive replica and cut over atomically according to the existing database lifecycle.

## Inputs

For one directional synchronization `R <- S`:

- `R` is the receiver's current stable graph+journal state;
- `S` is one source snapshot;
- both satisfy Journal 2 graph/journal consistency;
- both use the same graph schema and database version; and
- `R.header.writer != S.header.writer`.

Ordinary synchronization does not merge two snapshots which claim the same durable Journal writer identity. Same-writer continuation/recovery uses the same-host restoration rules; controlled reset has its own explicitly bounded same-writer-source rule. A same-writer source presented to ordinary full or incremental synchronization is an incompatible synchronization input rather than another replica.

Full synchronization does not require or consult a journal cursor.

## Source observation

Before joining the source header, synchronization MUST require:

```text
S.causalSummary[R.header.writer] <= R.localJournalCounter
```

If this fails, S demonstrates knowledge of later events from R's own writer identity than R can safely allocate after. Synchronization fails for that source before changing receiver state; it MUST NOT raise `R.localJournalCounter`, import the greater local-writer causal coordinate, or continue with a merge. Such a relationship requires supported same-writer restoration/reconciliation rather than ordinary observation.

After the precondition holds and before authoring any local semantic event, the receiver joins the source header causal and authority high-water knowledge:

```text
R.causalSummary := componentwiseMax(
    R.causalSummary,
    S.causalSummary
)

R.authorityClock := maxAuthorityTime(
    R.authorityClock,
    S.authorityClock
)
```

The source's coordinate for `R.header.writer` cannot increase R's own causal coordinate, so this join preserves the writer-coordinate invariant from `incremental-graph-journal-types.md`:

```text
R.causalSummary[R.header.writer] == R.localJournalCounter
```

By J2-INV-9, every retained head/certificate EventRef inspected from a supported source summary is already covered by that source header. If a retained reference is not covered, the source violates the supported-state invariant and the synchronization operation fails for that source rather than skipping the reference or silently repairing the header by joining the uncovered reference.

The causal and authority joins are one coupled observation: they must preserve J2-INV-7 and J2-INV-9 from `incremental-graph-journal.md` in the same publication. This observation allocates no event by itself. It does not change `R.localJournalCounter`; remote source sequences remain coordinates in their own writer dimensions.

## Semantic merge domain

The semantic domain is the union of represented `NodeKey`s in both compacted node-summary sets, including tombstoned keys.

Raw `NodeIdentifier`s do not determine semantic identity or conflict selection.

## Pure candidate join

For each key K, first compute a candidate summary without changing either source.

### State head

Choose the greater `SemanticHead` by comparing the head `EventRef`s with `authorityCompare`.

- greater present authority selects that exact `ValueRef`;
- greater absent authority selects that exact tombstone;
- equal authority must denote the same supported semantic head; disagreement is corrupt/unsupported state.

Payload equality is never consulted.

### Node-scoped invalidation

Join node-wide invalidate frontiers componentwise:

```text
nodeInvalidateFrontier = max(R.nodeInvalidateFrontier,
                             S.nodeInvalidateFrontier)
```

### Current-value metadata

If the selected head is present with ValueId V:

- consider value-specific metadata only from summaries whose current head is V;
- join their value invalidate frontiers componentwise;
- choose the greatest certificate event among certificates naming V by `authorityCompare(certificate.event, ...)`;
- if two candidate certificates have the same `certificate.event.id`, require their immutable event metadata, `value`, and exact `basis` to agree; disagreement is corrupt/unsupported state rather than a tie to resolve;
- all copies of the same `ValueRef` must carry the same immutable origin context and authority time and, by the ValueId invariant, correspond to the same semantic NodeKey, exact payload, and `modifiedAt`.

Metadata scoped to losing value occurrences is not a candidate for the selected value.

### Materialization-lineage creation time

`createdAt` is not value-occurrence identity or EventRef authority. It is retained as a `CreationTime` in the node summary and participates in synchronization through the canonical `(head, createdAt)` join defined in `incremental-graph-journal-projection.md`.

Accordingly, a strictly greater head wins together with the creation-time metadata carried by that head. Only when both inputs carry the same selected present head are their retained `CreationTime`s combined, by taking the earlier instant. An absent selected head retains no creation time.

This makes creation time follow the selected materialization lineage. It may move earlier when another replica carrying that same selected head has an earlier retained `CreationTime`, and may move later when a greater head replaces the old lineage. It is never set to synchronization execution time. Because an absent/tombstone head retains no `createdAt`, a node rematerialized after deletion does not inherit creation time from the materialization that was deleted.

### Local-only fields

`lastLocalChange` and changed-node marker coordinates are never imported or compared as semantic authority.

## Candidate payload source

A selected present head V must be carried by at least one input snapshot as a current materialized value. The selected payload and that occurrence's `modifiedAt` are copied from such a snapshot when the receiver does not already materialize V.

If both snapshots claim the same V, supported-state invariants guarantee the same semantic payload/`modifiedAt` and immutable `ValueRef` metadata; ordinary synchronization does not compare payloads to establish identity. Their retained `CreationTime`s may differ and are joined by the earlier instant because both summaries carry the same selected head. A detectable disagreement about V's payload, `modifiedAt`, or immutable event identity means the input is unsupported and synchronization fails rather than choosing one arbitrarily.

The journal contains no fallback payload.

## Canonical certificate

Only the greatest certificate for the selected current ValueId is considered, even if a lower historical certificate would happen to fit the merged inputs better.

Equality of certificate authority is not an independent conflict-resolution case. Because `authorityCompare` is total over `EventRef`, equal authority means the same event identity; the immutable-event-identity invariant therefore requires the certificates to have the same value and basis. If retained copies expose different bodies for that event ID, synchronization rejects the source/merge as unsupported state.

This rule is part of synchronization semantics before compaction; compaction does not create it.

## Topological normalization

The pure candidate join can describe graph state that cannot exist in the final legacy graph. Normalize candidates in schema topological order from inputs to dependents.

### Missing input

If candidate K is present but any direct input is finally absent, K cannot be materialized because the legacy graph is dependency-closed.

The receiver authors a local `DeleteEvent(reason="sync-discard")` for K. The new tombstone becomes K's final head and carries no `createdAt`.

Before allocation, synchronization has joined all source/local causal and authority high-water information relied on by this normalization. Therefore the tombstone is causally after, and has greater authority than, those observed candidate facts.

### Freshness projection

For a candidate which remains present, derive incoming validity and freshness using `incremental-graph-journal-projection.md` against the already normalized final direct inputs.

### Persistent stale propagation

If K's canonical certificate exactly names all final input ValueIds and covers all K invalidation frontiers, but K becomes stale solely because a final direct input is stale, synchronization must ensure K has an uncovered value-scoped invalidation.

If neither input already carries such authority for K, the receiver authors one local value-scoped invalidation. This prevents K from becoming automatically fresh merely because that input later revalidates unchanged; K must still perform its own normal cache-revalidation.

The authored invalidation advances from the synchronization transaction's joined causal summary and authority-clock high-water mark.

### `oldValue` retention

A present cache which survives dependency-closure normalization remains a valid cached value of the same semantic node and MAY be retained even when its final direct inputs come from different synchronization histories. This is the supported-state safety argument that discharges `$id-8254606583674715`; synchronization is not allowed to retain a cache by weakening the ordinary `oldValue` contract.

This follows directly from the existing IncrementalGraph pull contract. For a stale materialized node, the ordinary runtime:

1. pulls the node's current inputs;
2. checks whether the existing incoming validity proofs permit cache-only revalidation; and
3. if they do not, invokes the computor with those current input values and the node's currently stored cached value as `oldValue`.

That contract does not require `oldValue` to have been computed or validated against the current input values. Arbitrary dependency changes may occur while a node remains cached and stale; the cached value is still the value supplied as `oldValue` on the next recomputation.

Journal 2 therefore does not impose a stronger synchronization-only provenance rule. A final input `ValueId` which differs from the selected cache certificate basis removes the corresponding incoming validity proof and makes the cache stale through normal projection. It does not make the cached payload itself illegal as `oldValue`.

The computor's existing `Unchanged` contract remains the semantic guard: if invoked with the final inputs and retained cached value, it may return `Unchanged` only when preserving that value is semantically admissible for those current inputs. Otherwise it must produce a semantic value in `Outcomes(..., oldValue)` normally.

Consequently synchronization MUST NOT delete a present cache merely because:

- one or more final input `ValueId`s differ from its certificate basis;
- the cache and final inputs originated on different replicas;
- those value occurrences are concurrent;
- the node has multiple direct inputs; or
- a bootstrap/reset certificate contains `"unknown"` basis entries.

Those situations affect freshness and validity, not whether the stored value may be supplied as `oldValue`. A synchronization-authored `sync-discard` tombstone is required only when structural normalization makes the cache non-materializable, such as when a required direct input is finally absent.

### Cascading normalization

A newly authored tombstone for a non-materializable node may make dependents non-materializable. Continue topologically until every final present node has all inputs present.

No computor is invoked by synchronization.

## Final journal summary

For every node whose candidate metadata is simply adopted, preserve the foreign semantic IDs, immutable EventRefs, frontiers, certificate, and retained materialization-lineage `CreationTime`; record a receiver-local `AdoptEvent` only when that node's own `NodeJournalSemanticPart` actually changes.

For the same selected present head, learning an earlier `CreationTime` is therefore an ordinary semantic-part adoption change: it authors an `AdoptEvent`, advances `lastLocalChange`, and moves the changed-node marker even when head/frontier/certificate metadata is otherwise unchanged. This is what makes that observable creation-time update visible to a later incremental synchronization.

A dependent whose projected legacy freshness/validity changes only because an input summary changed authors no `AdoptEvent` and does not move its changed-node marker unless its own semantic part also changed or normalization authors another semantic event for it.

For every normalization-created value-scoped invalidation or structural tombstone, use the newly authored receiver EventRef authority.

After those events are folded, the final legacy graph is exactly the journal projection.

## Physical materialization

The semantic plan is keyed by NodeKey. Physical `NodeIdentifier` selection follows the existing identifier constraints:

- a surviving local identifier may be retained when unambiguous;
- a source identifier may be reused when collision-free;
- otherwise allocate a valid local identifier;
- rebuild the final identifier lookup and `valid` relation from the semantic plan;
- rebuild the derived reverse structural-edge index so it exactly represents every materialized `D -> N` structural edge in the final graph;
- install the selected payload and selected occurrence's `modifiedAt`, and serialize legacy `createdAt` to represent exactly the final summary's retained `CreationTime`;
- deleted nodes have no legacy identifier/value/freshness/timestamp/validity records and no reverse-edge records in which they are the dependent.

Physical choices do not participate in semantic conflict precedence. The reverse structural-edge index is likewise derived local acceleration state and carries no synchronization authority.

## Ordinary equality prohibition

Normal synchronization never calls `isEqual` on competing `ComputedValue`s and never uses serialization/hash equality as value identity, provenance, freshness, validity, or conflict evidence.

Two equal payloads with distinct `ValueId`s remain distinct occurrences and are resolved by journal authority exactly like unequal payloads.

## Monotonic facts

Across normal synchronization, these facts only grow in their respective orders:

- selected semantic head authority for a node under `authorityCompare`;
- node-wide invalidation frontiers;
- current-value invalidate frontiers while that value remains head;
- canonical certificate authority for a fixed current value;
- causal summary;
- authority-clock high-water mark.

For a fixed present head, retained `CreationTime` can only move earlier as more copies of that head are represented. When head selection changes, the old head's creation-time metadata is discarded with that losing materialization and the selected head's own carried `CreationTime` may be later. An absent head retains no `createdAt`.

## Why adoption does not cause authority inflation

If A copies B's value V, A records a local adoption event but keeps V's original `ValueId`, context, and `authorityTime` as the present head authority.

Therefore a path:

```text
B -> A -> C
```

does not turn V into successively newer semantic values merely because it crossed more hosts.

The same rule applies to adopted certificates, invalidation coordinates, tombstones, and retained creation-time metadata. A receiver's own HLC may advance because it observed the source, but that observation does not rewrite the adopted foreign EventRef.

## Convergence argument

Assume:

- finitely many replicas and represented nodes;
- no continuing graph-changing user operations after some time;
- fair repeated synchronization among a connected set;
- supported/correct snapshots.

Pure candidate joining uses the deterministic per-node join defined by the synchronization rules: total head maximum first, then current-head metadata joins, including the `CreationTime` minimum only for equal selected present heads. The creation-time component is exactly the associative `joinCreation` rule from `incremental-graph-journal-projection.md`. Repeated delivery of already represented positive authority or creation metadata therefore cannot change the candidate again.

A greater head may discard the losing head's `CreationTime` and install the selected head's own retained creation-time metadata, which may be later. Head authority itself can only increase, and under quiescence there are only finitely many represented positive heads, so such lineage replacements are finite. Once a final winning head is stable, its `CreationTime` only decreases toward the earliest represented value among copies of that head and therefore converges.

Synchronization may create only two forms of new negative semantic authority during normalization:

1. value-scoped invalidations required to preserve a newly merged stale transition;
2. destructive tombstones required by dependency closure when a selected present cache has a finally absent direct input, including cascading dependents.

Both are authored after joining all causal/authority high-water facts observed by the synchronization transaction. Consequently they are causally after and greater in authority than the facts which caused them. They introduce no new value or validation candidate.

Mixed cache/input provenance creates no additional negative authority. Basis mismatches simply project the retained cache stale, exactly as ordinary dependency value changes do in the local graph algorithm.

A particular already-observed positive state/certificate cannot force the same receiver to author an endless sequence of negative reactions: after the first required value-scoped invalidation or structural tombstone, its resulting frontier/tombstone is represented, and redelivery is a no-op.

A genuinely unseen concurrent positive authority may later force another finite normalization. Under quiescence there are finitely many such positive authorities. Each normalization may propagate along only the finite dependency DAG.

Therefore synchronization-authored negative events eventually stop. After that point, fair synchronization only applies deterministic head/frontier/certificate/creation joins, so every connected replica reaches the same semantic summaries and the same observable legacy graph state. Further synchronization is a semantic no-op.

The HLC authority order is total and extends happened-before, but its writer-local journal sequences are not compared across writers. This change does not weaken the convergence argument; convergence needs one deterministic total authority order, not globally comparable sequence magnitudes.

This establishes the Journal 2 convergence requirement without requiring local journal histories to become byte-for-byte equal.

## Full synchronization oracle

This full operation is the normative correctness oracle for incremental synchronization. Any cursor-based optimization must produce an observably equivalent receiver state when started from a valid cursor state; see `incremental-graph-journal-api.md`.