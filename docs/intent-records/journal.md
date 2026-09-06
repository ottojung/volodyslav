# Journal

$id-jbczivkrby
date: 2026/08/02
source: @ottojung
kind: requirement

The IncrementalGraph journal is transport-independent. Its identity, causality, synchronization, compaction, reset, and cursor semantics must not depend on Git hashes, commits, branches, ancestry, repository revisions, or other transport-specific identifiers.

Transport mechanisms may carry journal state, but they do not participate in journal semantics.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-synchronization.md`

---

$id-nzyczdgxmr
date: 2026/08/29
source: @ottojung
kind: requirement

Journal sequence numbers are writer-local coordinates.

For an event `(author, sequence)`, `sequence` orders events only within the durable writer history identified by `author`. Cross-author sequence magnitudes must not be compared as evidence of chronology, causality, revision order, presence, freshness, conflict precedence, or destructive authority.

Cross-author happened-before relationships are represented explicitly by journal identity and causal context.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-journal-sync.md`

---

$id-fuswbzcleq
date: 2026/09/04
source: @ottojung
kind: requirement

Causality is resolved before semantic occurrence time.

Timestamps must not substitute for missing causal evidence. For genuinely concurrent semantic changes, semantic occurrence time may resolve the conflict, with the durable author fingerprint available as the deterministic exact-equal-time tie-breaker.

Correctness must not require synchronized physical clocks. A persisted semantic clock may prevent a causally later authored semantic event from receiving an earlier occurrence time.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-journal-sync.md`

---

$id-koupxsoowk
date: 2026/08/29
source: @ottojung
kind: requirement

The journal's per-author coordinate structures have distinct meanings and must not substitute for one another.

In particular:

- `journalCoverage` proves complete possession/accounting of journal prefixes;
- causal context and `causalSummary` record happened-before knowledge;
- `clearsThrough` records validation-clearing authority;
- `absorbsThrough` records reset absorption authority;
- iterator progress records consumer progress;
- iterator issuance coverage records the possession frontier that made durable progress safe to issue.

A coordinate appearing in one of these structures is not automatically evidence for another.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-journal-api.md`

---

$id-vkoyfuczni
date: 2026/08/29
source: @ottojung
kind: requirement

Journal compaction must preserve future merge behavior.

For supported states `A` and `B`, the required future-union law is:

```text
compact(compact(A) union B) = compact(A union B)
```

The equality covers the journal-derived semantics that compaction claims to preserve, including semantic graph state, freshness authority, reset behavior, exact provenance required by synchronization, and public journal notification semantics.

See:

- `docs/specs/incremental-graph-journal-compaction.md`
- `docs/specs/incremental-graph-journal-sync.md`

---

$id-wariqamvff
date: 2026/08/10
source: @ottojung
kind: constraint

Journal correctness guarantees apply to states produced by the supported database lifecycle.

Corrupt, forged, rolled-back, partially installed, fingerprint-aliased, or otherwise unsupported histories do not need to be made meaningful by the journal protocol. Compaction does not need to retain forensic evidence, audit history, Merkle summaries, or intermediate validation evidence solely to diagnose unsupported histories.

See:

- `docs/specs/database-lifecycle.md`
- `docs/specs/incremental-graph-journal-types.md`

---

$id-pvtfqtaxgz
date: 2026/08/29
source: @ottojung
kind: requirement

Reset must preserve delayed-union semantics.

Causal observation of source history, history intentionally absorbed by reset, and exact semantic correspondence established by comparing source and receiver values are distinct forms of information. One must not be inferred merely from another.

Absorption evidence is specific to the exact reset anchor to which it belongs. Evidence for one anchor must not be lent to a different anchor. If delayed history later makes an already represented anchor relevant again, reset semantics must behave consistently with union-before-compaction.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-journal-sync.md`
- `docs/specs/incremental-graph-journal-compaction.md`

---

$id-pllxgquzdx
date: 2026/08/29
source: @ottojung
kind: requirement

Controlled reset does not import the source journal or the source `journalCoverage` into the receiver.

The receiver keeps its own durable writer identity and allocator history. Source causal knowledge may be observed, source semantic state may be represented, and source history may be intentionally absorbed without turning the source journal prefix into receiver-owned journal coverage.

Later source events above an absorbed per-author prefix remain live when they are eventually observed.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-journal-sync.md`

---

$id-sfgtzgliiz
date: 2026/08/29
source: @ottojung
kind: accepted-tradeoff

A reset may persist future-relevant causal or reset-anchor archive information without authoring a public journal event when no semantic graph occurrence happened.

Once the complete required semantic state, causal knowledge, and reset-anchor information are already represented, repeating the same reset should be silent.

See:

- `docs/specs/incremental-graph-journal-emission.md`
- `docs/specs/incremental-graph-journal-sync.md`

---

$id-emzeprnejr
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

Historical reset-anchor absorption information may be retained indefinitely.

The journal does not require a stable-frontier, acknowledgement, writer-retirement, or garbage-collection mechanism merely to eliminate `resetAnchorCuts` that remain necessary for delayed-union reset semantics.

See:

- `$id-vkoyfuczni`
- `$id-pvtfqtaxgz`
- `docs/specs/incremental-graph-journal-compaction.md`

---

$id-fkyryvkazu
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

Historical durable authors may continue to contribute permanently to journal metadata.

Persistent author coordinates in causal contexts, coverage, validation-clearing vectors, reset-absorption vectors, compaction metadata, or iterator state are acceptable and are not by themselves a reason to weaken journal semantics.

---

$id-jylkchamxz
date: 2026/09/04
source: @ottojung
kind: requirement

The compacted journal representation should have structural storage complexity

```text
O(nr² + ar + cr)
```

where:

- `n` is the number of represented semantic keys;
- `r` is the number of represented durable authors;
- `a` is the number of distinct `(NodeKey, taggedAnchor)` identities whose reset absorption evidence must remain represented;
- `c` is the number of retained exact reset-correspondence relations.

The `ar` term is acceptable because exact delayed-union reset behavior may require independent `O(r)` absorption information for each represented historical anchor.

This is a structural logical-record/vector-coordinate bound. Serialized byte size additionally depends on the byte length of retained arbitrary-precision coordinates and on the serialized size of semantic addresses.

See:

- `$id-vkoyfuczni`
- `$id-pvtfqtaxgz`
- `$id-emzeprnejr`
- `docs/specs/incremental-graph-journal-compaction.md`

---

$id-vonnocdvwi
date: 2026/08/26
source: @ottojung
kind: requirement

A journal entry persists one semantic node address: `nodeName` plus `bindings`.

It must not also persist a redundant `NodeKeyString` representation of the same address. `NodeKey` is derived from the semantic address when needed.

See:

- `docs/specs/incremental-graph-journal-types.md`

---

$id-ycienzeneo
date: 2026/08/26
source: @ottojung
kind: requirement

Every materialized IncrementalGraph node has defined creation and modification timestamps.

A materialized node is not allowed to use nullable or missing timestamp state as a compatibility fallback. Persistent state that claims a node is materialized must contain the timestamp record required by the graph invariant.

See:

- `docs/specs/incremental-graph.md`
- `docs/specs/database-lifecycle.md`

---

$id-cfwcrkvmqb
date: 2026/07/03
source: @ottojung
kind: requirement

Semantic invalidation is journaled.

A journal-relevant transition to stale state must retain explicit `invalidate` authority rather than relying on reconstruction from the current graph state alone. Journal and graph changes belonging to the same transition must be published atomically.

See:

- `docs/specs/incremental-graph-journal-emission.md`

---

$id-ehuakdwldj
date: 2026/07/03
source: @ottojung
kind: requirement

Compaction must retain enough positive semantic evidence to explain and merge materialized state.

An `invalidate` entry alone is not sufficient evidence for the existence or value history of a materialized node. Compaction must not remove the only surviving `add` or `edit` evidence when that evidence is required to preserve the node's semantic state or future-union behavior.

See:

- `docs/specs/incremental-graph-journal-compaction.md`

---

$id-drdgjkrhhw
date: 2026/08/08
source: @ottojung
kind: requirement

Copying an already represented canonical semantic value during synchronization or reset does not by itself create a new semantic `add` or `edit` revision.

Journal revision identity represents semantic occurrences, not transport or delivery. A receiver may persist genuinely new local authority required by synchronization, but mere transfer of an existing canonical value must not manufacture a new value occurrence.

See:

- `docs/specs/incremental-graph-journal-sync.md`
- `docs/specs/incremental-graph-synchronization.md`

---

$id-bkmrbrfulz
date: 2026/07/04
source: @ottojung
kind: requirement

Journal change observation returns an eager array rather than an externally consumed async iterator.

The observation call must operate on one stable journal snapshot and publish consumer progress only at the successful call boundary. Journal mutation and the snapshot/consumption boundary must be serialized sufficiently to prevent a mixed or partially observed journal state.

The exact locking mechanism may change as the graph locking design evolves; the required property is the stable consumption boundary.

See:

- `docs/specs/incremental-graph-journal-api.md`
- `docs/specs/incremental-graph-locking-design.md`

---

$id-rmrkdtnbft
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

The public journal iterator is a change-notification stream, not lossless replay of every underlying journal event.

Multiple journal events may collapse into the notification representative defined by the iterator semantics.

See:

- `docs/specs/incremental-graph-journal-api.md`

---

$id-wcxcoknumo
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

A journal iterator may consume entries that do not match the filter supplied to a particular iteration call. Changing the filter later does not need to revisit already consumed history.

This behavior must be stated clearly in the public API and implementation comments.

See:

- `docs/specs/incremental-graph-journal-api.md`

---

$id-zqhurszevg
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

The journal iterator does not require an acknowledgement protocol, paging protocol, or backpressure mechanism.

A successful call may eagerly materialize its result and advance progress at that successful-call boundary.

This behavior must be stated clearly in the public API and implementation comments.

See:

- `docs/specs/incremental-graph-journal-api.md`

---

$id-glsmnltiwm
date: 2026/09/04
source: @ottojung
kind: requirement

A `DatabaseFingerprint` is the permanent durable identity of one writer history and must not change during that history.

The same fingerprint may serve both as the journal author coordinate and as the allocation namespace component of `NodeIdentifier`.

The canonical fingerprint representation is exactly 16 lowercase ASCII letters. Its generation may ultimately contain only 32 bits of entropy; probabilistic collision risk at that level is acceptable. The protocol does not require collision detection or repair, and its guarantees may be conditional on each interpreted fingerprint denoting one durable writer history.

See:

- `docs/specs/incremental-graph-fingerprint.md`
- `docs/specs/keys-design.md`

---

$id-xadiitvcod
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

Object property order may be semantically significant for IncrementalGraph values and bindings.

The graph does not need to canonicalize differently ordered JSON records into one semantic value merely because they contain the same set of properties. `isEqual`, `ConstValue`, and `NodeKey` identity must remain mutually consistent about this property.

See:

- `docs/specs/incremental-graph.md`
- `backend/src/generators/incremental_graph/database/node_key.js`

---

$id-orgbwzwnio
date: 2026/09/04
source: @ottojung
kind: requirement

Persistence representation details must not leak into application-level generator logic.

Application code should operate on domain values rather than compensate for incidental serialized forms, private library layouts, or multiple persistence-specific representations. In particular, application generators should not interpret private Luxon representation details such as `_luxonDateTime` internals.

Serialization and reconstruction adapters belong at the domain/persistence boundary.

See:

- `backend/src/generators/individual/persisted_event.js`
- `backend/src/generators/individual/event_transcription/compute.js`

---

$id-rliuqrcclh
date: 2026/09/04
source: @ottojung
kind: requirement

IncrementalGraph persistence must preserve the established persisted `ComputedValue` representation.

Persistence-safety validation may reject values that cannot round-trip correctly, but it must not introduce a new storage envelope, change existing application payload JSON shapes, or add a new top-level `null` semantic value merely to perform validation.

The normative specification and implementation must describe one consistent persistence model.

See:

- `docs/specs/incremental-graph.md`
- `backend/src/generators/incremental_graph/database/computed_value_database.js`
- `backend/src/generators/incremental_graph/database/types.js`

---

$id-bbouwqwuno
date: 2026/09/04
source: @ottojung
kind: requirement

Synchronization requires exact database-version compatibility.

Direct synchronization between incompatible IncrementalGraph database versions is not desired.

See:

- `docs/specs/database-lifecycle.md`
- `docs/specs/incremental-graph-synchronization.md`

---

$id-pfeuxuyfcy
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

A failed parent `pull()` may leave successfully completed dependency pulls committed.

A public pull does not require atomic rollback across the complete dependency cone.

See:

- `docs/specs/incremental-graph-locking-design.md`

---

$id-hqbxziisir
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

IncrementalGraph correctness may rely on explicit computor-discipline requirements, including restrictions on unsupported graph re-entry and assumptions necessary for sound proof transport.

These requirements should be explicit and enforced where practical, but their existence is not itself a reason to weaken the journal design.

See:

- `docs/specs/incremental-graph-locking-design.md`
- `docs/specs/incremental-graph-synchronization.md`

---

$id-mtgkqoxjrf
date: 2026/09/04
source: @ottojung
kind: requirement

Database migrations may directly transform an existing materialized node from one `ComputedValue` to a different `ComputedValue`.

Migration validity must not require the target value to be `isEqual` to the source value. If the migration API distinguishes representation-only rewrites from semantic replacements, that distinction must be explicit in the migration operation rather than inferred by comparing source and target values with `isEqual`.

See:

- `docs/specs/migration.md`
- `docs/specs/incremental-graph-journal-migrations.md`

---

$id-zwrvcwxnzt
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

Synchronization of derived cached values may use proof/coherence eligibility before applying ordinary causal/concurrent precedence among the eligible candidates.

A newer unsupported derived cache does not need to displace an older coherent cache merely because its semantic occurrence time is later.

See:

- `docs/specs/incremental-graph-synchronization.md`

---

$id-uxcyhttrfj
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

Synchronization may author new receiver-local semantic journal events when combining already-observed authority requires a genuinely new semantic decision, such as a destructive barrier or proof-loss hardening.

Merely importing or copying already represented semantic state must not author a new value occurrence. Synchronization-authored authority must participate in the normal causal model so that the decision remains meaningful under later delivery and repeated synchronization.

See:

- `docs/specs/incremental-graph-synchronization.md`
- `docs/specs/incremental-graph-journal-sync.md`

---

$id-csmhmuefpr
date: 2026/09/04
source: @ottojung
kind: accepted-tradeoff

Freshness may use replicated authority distinct from generic happened-before knowledge when that distinction is needed to preserve validation and recomputation semantics.

In particular, dedicated validation-clearing evidence and the distinction between soft and hard invalidation are acceptable even though they make the journal freshness protocol more complex than ordinary causal observation alone.

See:

- `docs/specs/incremental-graph-journal-types.md`
- `docs/specs/incremental-graph-synchronization.md`
