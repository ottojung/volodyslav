# IncrementalGraph Journal 2 Synchronization

## Purpose

This specification defines the semantic full synchronization operation for Journal 2. It is independent of Git transport and operates on two stable Journal 2/legacy graph snapshots with the same database/schema version.

The source is read-only. The receiver may publish a new inactive replica and cut over atomically according to the existing database lifecycle.

## Inputs

For one directional synchronization `R <- S`:

- `R` is the receiver's current stable graph+journal state;
- `S` is one source snapshot;
- both satisfy Journal 2 graph/journal consistency;
- both use the same graph schema and database version.

Full synchronization does not require or consult a journal cursor.

## Source observation

Before authoring any local semantic event, the receiver joins the source header causal and authority high-water knowledge:

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

and includes every source semantic event reference/context/authority time actually inspected if it is not already covered by the source header.

This observation allocates no event by itself. It does not change `R.localJournalCounter`; remote source sequences remain coordinates in their own writer dimensions.

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
- join their value hard-invalidate frontiers componentwise;
- choose the greatest certificate event among certificates naming V by `authorityCompare(certificate.event, ...)`;
- all copies of the same `ValueRef` must carry the same immutable origin context and authority time.

Metadata scoped to losing value occurrences is not a candidate for the selected value.

### Local-only fields

`lastLocalChange` and changed-node marker coordinates are never imported or compared as semantic authority.

## Candidate payload source

A selected present head V must be carried by at least one input snapshot as a current materialized value. The selected complete value/timestamp record is copied from such a snapshot when the receiver does not already materialize V.

If both snapshots claim the same V, supported-state invariants guarantee the same semantic payload/timestamps and immutable `ValueRef` metadata; ordinary synchronization does not compare payloads to establish identity.

The journal contains no fallback payload.

## Canonical certificate

Only the greatest certificate for the selected current ValueId is considered, even if a lower historical certificate would happen to fit the merged inputs better.

This rule is part of synchronization semantics before compaction; compaction does not create it.

## Topological normalization

The pure candidate join can describe a cache that cannot safely exist in the final legacy graph. Normalize candidates in schema topological order from inputs to dependents.

### Missing input

If candidate K is present but any direct input is finally absent, K cannot be materialized because the legacy graph is dependency-closed.

The receiver authors a local `DeleteEvent(reason="sync-discard")` for K. The new tombstone becomes K's final head.

Before allocation, synchronization has joined all source/local causal and authority high-water information relied on by this normalization. Therefore the tombstone is causally after, and has greater authority than, those observed candidate facts.

### Freshness projection

For a candidate which remains present, derive incoming validity and freshness using `incremental-graph-journal-projection.md` against the already normalized final direct inputs.

### Persistent stale propagation

If K's canonical certificate exactly names all final input ValueIds and covers all K invalidation frontiers, but K becomes stale solely because a final direct input is stale, synchronization must ensure K has an uncovered value-scoped soft invalidation.

If neither input already carries such authority for K, the receiver authors one local soft invalidation. This prevents K from becoming automatically fresh merely because that input later revalidates unchanged; K must still perform its own normal cache-revalidation.

The authored invalidation advances from the synchronization transaction's joined causal summary and authority-clock high-water mark.

### `oldValue` admissibility

A selected present cache must be safe to expose under the existing computor `oldValue` contract.

If K has zero or one distinct direct semantic input, Journal 2 permits the selected present cache to remain as `oldValue` provided all other graph invariants hold.

If K has two or more distinct direct inputs, let C be its canonical certificate. The cache is serially admissible only if C exists and, for every index `i` of `inputEdges(K)`, at least one condition holds:

```text
C.basis[i] == currentValueId(inputEdges(K)[i])
```

or

```text
happenedBefore(
    C.event,
    currentValueEvent(inputEdges(K)[i])
)
```

The second condition uses the immutable causal context of the input's original `ValueRef`; synchronization/adoption delivery order does not create happened-before for this test.

Intuition: every mismatching current input must be a genuine semantic successor of the cache's last validation, not merely a concurrently delivered branch. Otherwise selecting K as `oldValue` can expose which branch happened to win the synchronization order.

If this admissibility test fails, the receiver authors a local `sync-discard` tombstone and removes K from the legacy graph. It never stores K's payload in the journal.

### Cascading normalization

A newly authored tombstone may make dependents non-materializable. Continue topologically until every final present node has all inputs present and passes the admissibility rule.

No computor is invoked by synchronization.

## Final journal summary

For every node whose candidate metadata is simply adopted, preserve the foreign semantic IDs, immutable EventRefs, frontiers, and certificate and record a receiver-local `AdoptEvent` only when receiver synchronization-relevant state actually changes.

For every normalization-created soft invalidation or tombstone, use the newly authored receiver EventRef authority.

After those events are folded, the final legacy graph is exactly the journal projection.

## Physical materialization

The semantic plan is keyed by NodeKey. Physical `NodeIdentifier` selection follows the existing identifier constraints:

- a surviving local identifier may be retained when unambiguous;
- a source identifier may be reused when collision-free;
- otherwise allocate a valid local identifier;
- rebuild the final identifier lookup and `valid` relation from the semantic plan;
- copy selected payload/timestamps as a complete record;
- deleted nodes have no legacy identifier/value/freshness/timestamp/validity records.

Physical choices do not participate in semantic conflict precedence.

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

Changing to a greater value/tombstone head may discard metadata scoped only to the losing value.

## Why adoption does not cause authority inflation

If A copies B's value V, A records a local adoption event but keeps V's original `ValueId`, context, and `authorityTime` as the present head authority.

Therefore a path:

```text
B -> A -> C
```

does not turn V into successively newer semantic values merely because it crossed more hosts.

The same rule applies to adopted certificates, invalidation coordinates, and tombstones. A receiver's own HLC may advance because it observed the source, but that observation does not rewrite the adopted foreign EventRef.

## Convergence argument

Assume:

- finitely many replicas and represented nodes;
- no continuing graph-changing user operations after some time;
- fair repeated synchronization among a connected set;
- supported/correct snapshots.

Pure candidate joining uses deterministic total EventRef maxima/componentwise frontier maxima and therefore repeated delivery of already represented positive authority cannot change the candidate again.

Synchronization may create only two new kinds of semantic authority:

1. soft invalidations required to preserve a newly merged stale transition;
2. destructive tombstones for an unsafe/non-materializable cache.

Both are negative authority and are authored after joining all causal/authority high-water facts observed by the synchronization transaction. Consequently they are causally after and greater in authority than the facts which caused them. They introduce no new value or validation candidate.

A particular already-observed positive state/certificate cannot force the same receiver to author an endless sequence of negative reactions: after the first reaction its resulting frontier/tombstone is represented, and redelivery is a no-op.

A genuinely unseen concurrent positive authority may later force another finite negative normalization. Under quiescence there are finitely many such positive authorities. Each normalization may propagate along only the finite dependency DAG.

Therefore synchronization-authored negative events eventually stop. After that point, fair synchronization only adopts deterministic maxima/frontiers/certificates, so every connected replica reaches the same semantic summaries and the same legacy graph projection. Further synchronization is a semantic no-op.

The HLC authority order is total and extends happened-before, but its writer-local journal sequences are not compared across writers. This change does not weaken the convergence argument; convergence needs one deterministic total authority order, not globally comparable sequence magnitudes.

This establishes the Journal 2 convergence requirement without requiring local journal histories to become byte-for-byte equal.

## Full synchronization oracle

This full operation is the normative correctness oracle for incremental synchronization. Any cursor-based optimization must produce an observably equivalent receiver state when started from a valid cursor state; see `incremental-graph-journal-api.md`.
