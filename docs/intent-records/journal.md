# Journal

$id-4464408832385718
title: Synchronization convergence
date: 2026/09/06
source: @ottojung
kind: requirement

Synchronization must converge.

For any finite set of supported replicas, once graph-changing operations stop, fair repeated synchronization must eventually bring all replicas to observably equivalent IncrementalGraph states. Once this state has been reached, further synchronization without intervening graph changes must be a semantic no-op.

This requirement does not prescribe associativity, commutativity, idempotence, CRDTs, or any particular convergence mechanism.

---

$id-8532915736687645
title: Causality-respecting conflict authority
date: 2026/09/07
source: @ottojung
kind: requirement

Journal 2 conflict authority must extend exact happened-before while keeping writer-local sequence numbers local to their writer.

A semantic event which is genuinely causally after another semantic event must have greater conflict authority. For concurrent value occurrences, authority should normally prefer the occurrence with the later legacy `modifiedAt` value, after adjustment required to preserve causal monotonicity. If the resulting authority times tie, durable writer fingerprint is the cross-writer tie-breaker; a writer-local journal sequence is compared only after the writer fingerprints are equal.

Journal sequence numbers from different writers must not be numerically compared to decide conflict precedence. Journal 2 may use a hybrid logical clock or an equivalent bounded total-order timestamp which is seeded by `modifiedAt` for value events and advanced as necessary so happened-before always implies increasing authority. This is a deterministic conflict policy, not a guarantee of true wall-clock recency under clock skew.

---

$id-3817813711344897
title: No clock-skew rejection requirement
date: 2026/09/09
source: @ottojung
kind: accepted-tradeoff

Journal 2 does not need a maximum-clock-skew rejection rule.

A badly skewed local clock, persisted `modifiedAt`, or previously observed authority high-water mark may suppress the normal `modifiedAt` preference for later concurrent conflicts. Once absorbed, that high-water mark never decreases and ordinary observation propagates it to peers. The preference returns only after a later physical seed exceeds the absorbed high-water mark; for clock-derived timestamps that can require the wall clock to catch up, which may take arbitrarily long and may effectively last for the remaining lifetime of a database.

That persistence is accepted rather than adding a rule which tries to decide whether a remote or persisted authority coordinate is implausibly far from the observer's own wall clock. Otherwise supported state must not be rejected solely because its physical authority coordinate is far ahead of the observer's local time.

---

$id-7267992945144356
title: Frozen legacy graph representation
date: 2026/09/06
source: @ottojung
kind: constraint

The representation of every existing IncrementalGraph sublevel is frozen.

The stored formats, keys, values, and meanings of existing sublevels such as `values`, `freshness`, `valid`, `timestamps`, and identifier metadata must not be extended with journal, version, provenance, causal, cursor, or synchronization metadata.

The journal is a new sublevel. Any metadata required by the new synchronization design must be stored there rather than changing an existing sublevel's representation.

---

$id-4211571544165137
title: Historical journal model
date: 2026/09/06
source: @ottojung
kind: requirement

The journal is a historical event list.

Conceptually, journal entries record historical IncrementalGraph events in journal order. Compaction is a required storage optimization and may remove historical entries whose future-relevant meaning is represented by retained journal information, but the conceptual journal remains a history of events rather than a current-state table.

---

$id-2289413971072778
title: No durable audit-history guarantee
date: 2026/09/07
source: @ottojung
kind: constraint

The journal is not a durable audit-history or indefinite forensic-replay facility.

Canonical compaction may permanently discard raw low-level historical events, high-level operation records, grouping/parent relationships, and other historical detail once the future synchronization and iterator meaning required by Journal 2 is represented by retained bounded journal state. Journal 2 does not promise that old operations or their exact raw event expansions remain inspectable forever.

---

$id-6408459523082482
title: Journals are local to one database
date: 2026/09/06
source: @ottojung
kind: requirement

A journal is local to one database.

Synchronization does not require the receiver to adopt the source journal as its own history or to make the receiver journal converge byte-for-byte with the source journal. Graph changes caused by synchronization are represented in the receiver's own journal according to the receiver's normal journal rules.

---

$id-6193879998109578
title: Compacted journal size bound
date: 2026/09/06
source: @ottojung
kind: requirement

The compacted journal must have a bounded serialized bit size with retained absence represented honestly in the bound.

Let:

- `L` be the number of currently present/materialized concrete semantic nodes represented by the journal;
- `T` be the number of currently absent/tombstoned semantic keys whose negative authority remains represented so older values cannot incorrectly resurrect;
- `N = L + T` be the complete represented semantic-node/key domain;
- `R` be the number of durable journal-author identities represented by synchronization-relevant journal metadata;
- `H >= 2` be an upper bound on every represented journal sequence/counter magnitude and every numeric hybrid-authority-clock component;
- the maximum serialized `NodeKey` size be bounded independently of `N`, `R`, and `H`;
- the maximum direct in-degree of every represented node be bounded independently of `N`, `R`, and `H`;
- durable author identifiers and other fixed primitive tags have bounded serialized size.

Under these assumptions, the total serialized size of the compacted journal must be

```text
O((L + T) R log H) bits
= O(N R log H) bits.
```

`T` is allowed to grow with the number of distinct semantic keys whose absence must remain synchronization-relevant. The bound therefore does not claim independence from historical *unique-key churn*. It must, however, be independent of the number of historical operations, validations, invalidations, synchronizations, resets, and repeated changes on a fixed represented key domain except through the retained parameters above and the `log H` coordinate-width term.

---

$id-8247698182975014
title: Uncompacted journal may be unbounded
date: 2026/09/09
source: @ottojung
kind: accepted-tradeoff

Journal 2 does not require any storage-size bound for the uncompacted raw historical layer.

The compacted representation must satisfy the stated bounded-size guarantees, but between compactions the raw historical event/operation layer may grow without a fixed bound. This is acceptable even if an unusually busy interval produces a very large journal before the next compaction.

From the Journal 2 semantic perspective, the timing of compaction is intentionally nondeterministic. Correctness must not depend on a particular compaction point or cadence; compaction may happen from time to time whenever the surrounding application chooses to invoke it.

---

$id-2399748558090155
title: Hourly Journal 2 compaction
date: 2026/09/09
source: @ottojung
kind: requirement

Volodyslav must attempt Journal 2 canonical compaction as part of its existing hourly periodic job.

The operational schedule is once per execution of the hourly job. Missed hourly runs do not create a requirement to replay one compaction per missed hour; the scheduler's ordinary no-make-up behavior applies.

A failed compaction attempt is best-effort maintenance failure: it must not fail the hourly scheduler task, trigger retry of the other hourly responsibilities, or create a separate make-up compaction obligation. Any compaction batches which committed before the failure remain valid, and a later hourly execution may continue pruning the remaining accumulated history.

This hourly application policy does not make compaction timing part of Journal 2 semantics and does not create a size guarantee for the uncompacted journal between successful compactions.

---

$id-4719065396881648
title: No remote-participation dependency
date: 2026/09/07
source: @ottojung
kind: requirement

Journal 2 correctness and mandatory compaction guarantees must not assume eventual participation, acknowledgement, or return of any particular remote host.

A supported remote host or remote state may be absent for an arbitrarily long finite interval after previously participating; may never return after participating; or may first be encountered only after an arbitrarily long delay. Correctness and required retained synchronization authority must remain valid in all of these cases.

In particular, canonical correctness may not depend on eventually learning that every potentially relevant host has incorporated a deletion, reset, compaction point, or other journal fact. Host-acknowledgement or liveness-based reclamation may exist only as an optional optimization and may not be required for the base Journal 2 guarantees.

Lifecycle and bootstrap code may rely on invariants of supported Volodyslav-produced state. It is not required to scan, contact, or wait for every possible peer merely to prove that no unsupported external state exists. If locally available evidence demonstrates that a supported-state invariant was violated, the state must be rejected where the relevant specification requires it; absence of such evidence does not create a global-discovery obligation.

---

$id-1762448645994697
title: Worst-case compaction bound
date: 2026/09/07
source: @ottojung
kind: requirement

The stated Journal 2 storage bound is a worst-case bound over supported histories and host-participation schedules, not an expected, average-case, or eventual-after-reclamation bound.

For every supported committed state, canonical compaction must satisfy the stated bound as a function of that state's retained `L`, `T`, `R`, and `H` without assuming any favorable future synchronization or host return. An optimization that only reduces typical retained state, or only becomes effective after some remote host acknowledges progress, does not improve or justify the mandatory worst-case bound.

---

$id-7314129657143424
title: Individually small journal values
date: 2026/09/06
source: @ottojung
kind: requirement

The journal must be stored as a collection of individually small LevelDB values rather than as a global object whose value grows with the graph or journal history.

Under the bounded-`NodeKey`, bounded-in-degree, and bounded-primitive assumptions of `$id-6193879998109578`, every individual LevelDB value belonging to the journal sublevel must have serialized size

```text
O(R log H) bits.
```

No individual journal LevelDB value may have size proportional to `N`, to the total number of graph dependency edges, or to the total number of historical journal events. Journal indexes, summaries, and other auxiliary journal data are subject to the same requirement; a graph-wide lookup/map/list must be decomposed into individually bounded records.

---

$id-4924739474925738
title: Streamable incremental change discovery
date: 2026/09/07
source: @ottojung
kind: requirement

Journal 2 incremental change discovery and source processing must be streamable without retaining a graph-sized collection of journal summaries or payloads in RAM.

The internal `possibleMaybeChanges` facility must expose changed-node summaries as a private asynchronous iterator over a caller-owned stable source snapshot rather than as an `Array` containing the complete changed-node range. The change-discovery layer must retain only a constant number of individually bounded journal records at a time, apart from bounded implementation/runtime iterator buffers.

This iterator is private synchronization/journal infrastructure. It must not be exposed through the public IncrementalGraph API or made available to ordinary computors. Synchronization may use bounded-record scratch storage when graph-wide normalization state is required, but the journal iterator itself must not force O(N) journal metadata or payloads into RAM.

---

$id-5212884941700983
title: No ComputedValue payloads in the journal
date: 2026/09/06
source: @ottojung
kind: constraint

The journal must not store `ComputedValue` payloads or copies of values from the existing `values` sublevel.

Journal entries may identify or describe value occurrences using bounded journal metadata, but the journal is not secondary storage for semantic node values.

---

$id-8254606583674715
title: oldValue safety over cache retention
date: 2026/09/07
source: @ottojung
kind: requirement

Synchronization must prefer `oldValue` safety over retaining a cached materialization.

A cache may be retained only when the supported IncrementalGraph contract establishes that it remains permissible to expose that materialization to its computor as `oldValue`. Journal 2 must not invent a weaker synchronization-only meaning of `oldValue` merely to preserve cache reuse.

For supported persisted IncrementalGraph state, a present materialization is already a legitimate cache of that semantic node. The ordinary graph contract permits that cache to remain while dependencies change and supplies it as `oldValue` when a later pull cannot cache-revalidate. Therefore input/certificate mismatch, concurrency, mixed replica provenance, multiple inputs, or unavailable historical basis provenance do not by themselves make a supported present cache unsafe as `oldValue`; those facts are expressed through stale freshness and missing validity edges.

Synchronization removes a retained cache when an independent structural rule makes the materialization impossible to keep, such as dependency closure when a required direct input is finally absent. If synchronization removes a cache, it must retain sufficient negative journal authority to prevent rejected older cache occurrences from being resurrected incorrectly. A later genuine recomputation may create a new value occurrence and materialize the node again.

---

$id-2048186621237391
title: Atomic graph and journal publication
date: 2026/09/06
source: @ottojung
kind: requirement

Graph state and the journal information describing that state must be published atomically.

Whenever one supported operation changes existing IncrementalGraph sublevels and requires a corresponding journal change, those changes must become durable as one atomic publication. A supported persisted state must not expose the graph side of such a transition without its corresponding journal side, or the journal side without its corresponding graph side.

---

$id-7323556069253070
title: No payload equality in ordinary synchronization
date: 2026/09/06
source: @ottojung
kind: constraint

Ordinary synchronization must not compare `ComputedValue` payloads, or use value equality, to infer value identity, origin, provenance, causal history, validation history, freshness, validity, or conflict precedence.

Controlled reset may compare a source value with the corresponding receiver value solely in order to avoid replacing a value already known to be equal. That equality does not by itself establish any additional provenance or history fact.

---

$id-7726871716903043
title: Journal 2 reset source compatibility
date: 2026/09/07
source: @ottojung
kind: requirement

Journal 2 semantic reset requires a valid compatible Journal 2 source snapshot.

A journal-less or pre-Journal-2 snapshot must not be accepted as the source of a Journal 2 semantic reset. Same-host restoration is a distinct lifecycle operation: it may recover an older saved database state, after which the normal migration gate must establish Journal 2 before that state participates in Journal 2 synchronization or semantic reset.

---

$id-9638924011004178
title: Full synchronization before incremental synchronization
date: 2026/09/06
source: @ottojung
kind: requirement

Convergent full synchronization comes before incremental synchronization.

The synchronization design must first provide a correct convergent full synchronization operation that does not depend on journal cursors or changed-node discovery for correctness. Incremental synchronization is a later optimization.

For source and receiver states for which an incremental synchronization cursor is valid, incremental synchronization must produce an observably equivalent final IncrementalGraph state to full synchronization of those same states.

---

$id-3720838127855063
title: Compacted iterator semantic equivalence
date: 2026/09/06
source: @ottojung
kind: requirement

Journal iteration after compaction preserves the semantic effect of the consumed journal range rather than requiring event-for-event reproduction of entries removed by compaction.

For any valid iterator progress state `P` and fixed journal snapshot ending at `S`, consuming the retained iterator output for `(P,S]` from any supported consumer state that correctly represents the journal through `P` must produce the same journal-derived observable result as consuming the corresponding uncompacted historical events through `S`.

The iterator consumes the complete snapshot range through `S` even when compaction has removed redundant events and therefore returns fewer retained entries than originally occurred in that range.

---

$id-5848454000145656
title: Compaction preserves future synchronization
date: 2026/09/06
source: @ottojung
kind: requirement

Journal compaction must preserve future synchronization behavior.

Replacing a supported journal by its compacted representation must not change the observably converged IncrementalGraph result of any later supported sequence of graph operations and synchronizations, including synchronization with replicas that have not participated since before the compaction.

---

$id-6483437836079063
title: Journal 2 migration invalidates source cursors
date: 2026/09/07
source: @ottojung
kind: requirement

A migration whose input already contains Journal 2 must invalidate all receiver-local incremental synchronization progress by atomically deleting every stored source cursor with the migrated state.

After such a migration, the next synchronization with each source must use full synchronization; a successful full synchronization may establish a fresh cursor under the migrated state. Journal 2 does not require an optimization for proving individual pre-migration cursors safe to preserve.

---

$id-4373538486707762
title: Transport-independent journal semantics
date: 2026/09/06
source: @ottojung
kind: requirement

The IncrementalGraph journal is transport-independent.

Journal identity, event semantics, synchronization, compaction, and cursor semantics must not depend on Git hashes, commits, branches, ancestry, repository revisions, or other transport-specific identifiers. Transport mechanisms may carry journal or graph state, but they do not participate in journal semantics.
