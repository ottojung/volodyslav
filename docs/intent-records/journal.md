# Journal

$id-3431463105072133
title: Journal is a durable replay log
date: 2026/09/13
source: @ottojung
kind: requirement

The journal must be a durable historical replay log rather than a lossy current-state summary.

The retained journal history must contain enough information to reconstruct the supported IncrementalGraph semantic state by replay. Historical information needed for replay and debugging must remain available rather than being replaced by a compacted summary whose old events are no longer recoverable.

The current IncrementalGraph database may maintain efficient materialized state and indexes alongside the journal, but those structures do not replace the journal as the durable historical record.

---

$id-6180473925618407
title: IncrementalGraph state is a projection of the journal
date: 2026/09/14
source: @ottojung
kind: requirement

Journal 3 is journal-first: the persisted IncrementalGraph state must be a materialized projection of retained journal history rather than an independent semantic source of truth.

The journal must contain enough information to reconstruct the supported persisted graph state without guessing semantic facts from the current `values`, `freshness`, `valid`, `timestamps`, or identifier records. Those graph records may be maintained eagerly for efficient operation, but when journal and graph disagree, the design must treat the journal replay meaning as authoritative rather than combining two independent authorities.

This is a replay-completeness requirement. It does not require the mathematical mapping from histories to current graph states to be injective: distinct histories may legitimately project to the same current graph.

---

$id-1235084615014938
title: Journal is the replicated synchronization state
date: 2026/09/13
source: @ottojung
kind: requirement

The long-term synchronization architecture should replicate the journal rather than treating the rendered current IncrementalGraph database as semantic synchronization authority.

A local host may keep derived materialized graph state for efficient operation, but synchronized durable state must be sufficient to recover retained journal history and reconstruct the supported graph state.

This intent does not require a particular remote storage product, transport protocol, or change to the current Git transport mechanism. Journal 3 itself stops at the stable journal-snapshot semantic boundary.

---

$id-5697779364241164
title: No destructive journal compaction
date: 2026/09/13
source: @ottojung
kind: requirement

Journal history must not be destructively compacted by deleting old replay records merely because their current semantic effect can be summarized more compactly.

Replay and debugging benefit from retaining the actual historical records. Implementations may add derived indexes, caches, or replay checkpoints for performance, but those accelerators must not make destructive removal of the authoritative replay history part of the Journal design.

---

$id-1281785913568806
title: Unbounded replay history is acceptable
date: 2026/09/13
source: @ottojung
kind: accepted-tradeoff

Journal 3 does not require a total serialized-size bound that is independent of the number of historical journal records.

Because the journal is a durable replay history, its retained storage may grow with the number and size of recorded historical events. Storage and replay optimizations may be introduced where useful, but Journal 3 does not need compaction or another bounded-history representation solely to satisfy an asymptotic total-size requirement.

---

$id-4464408832385718
title: Synchronization convergence
date: 2026/09/06
source: @ottojung
kind: requirement

Synchronization must converge for whichever finite set of supported replicas is actually participating, without depending on participation by absent replicas.

Consider a quiescent participation epoch with a finite participating set P: non-normalization graph-changing operations have stopped, the membership of P remains fixed for the duration of the epoch, and every replica in P remains available long enough for fair synchronization. Synchronization among P must eventually reach a settled state in which:

- all replicas in P have observably equivalent projected IncrementalGraph states;
- all replicas in P have incorporated the same retained synchronized Journal closure available within P, meaning equal writer frontiers and identical immutable records at every retained coordinate in that closure, even though local physical layout, indexes, and locally-authored stream ownership may differ; and
- further synchronization among unchanged replicas in P transfers no new retained history, authors no new semantic normalization records, and leaves every projection unchanged.

This convergence requirement is closed over the replicas that actually remain available. If replicas A, B, and C have participated, graph-changing operations stop, and A then becomes unavailable before convergence, B and C must still be able to settle without A. If A later returns, the enlarged participating set begins a new convergence epoch; synchronization must incorporate the histories now available from A, B, and C and settle again.

A replica may be absent for an arbitrarily long finite interval or may never return. Its absence must not prevent the remaining participating replicas from reaching their own settled state. This specializes the independent no-remote-participation requirement to convergence behavior.

This requirement does not prescribe CRDTs or another particular convergence mechanism.

---

$id-7140986253417724
title: Counterfactual synchronization confluence is not required
date: 2026/09/16
source: @ottojung
kind: accepted-tradeoff

Synchronization may author real semantic normalization events required by IncrementalGraph semantics. Which normalization events become necessary may depend on the order in which a replica observes otherwise concurrent retained histories.

Therefore Journal synchronization is not required to be counterfactually confluent. Two executions which start from the same replica states and eventually expose the same underlying histories, but expose them in different synchronization orders, may author different normalization histories and may settle to different retained Journals or projected graphs.

This accepted non-confluence does not weaken convergence within an actual execution. Every quiescent participation epoch must still settle among its participating replicas according to `$id-4464408832385718`.

---

$id-5631842079463518
title: Synchronization settling admits a host-count bound
date: 2026/09/16
source: @ottojung
kind: requirement

After graph-changing operations and participation changes stop, the participating replicas must admit a settling schedule whose number of state-advancing successful pairwise synchronization operations is bounded solely as a function of the number of participating replicas, rather than by retained-history size or graph size.

For a quiescent participation epoch containing H participating replicas, there must exist a settling schedule reaching the state required by `$id-4464408832385718` within at most H^2 state-advancing successful pairwise synchronization operations.

A state-advancing synchronization is one which either incorporates retained Journal history not already present at the receiver or authors semantic normalization history required because of the incorporated/retained history. Semantically redundant synchronization calls which transfer no new retained history and author no normalization records do not consume this bound. Failed attempts do not consume it either.

This is an achievable-schedule bound, not a claim that every arbitrary fair ordering of pairwise synchronizations must settle within H^2 state-advancing calls. The independent convergence intent still requires arbitrary fair synchronization to settle eventually. An implementation or specification may satisfy this intent with any stronger host-count-only bound.

If a graph-changing operation occurs or the participating set changes, the current quiescent participation epoch ends and a new one begins with H recomputed from the new participating set.

This is a bound on the number of state-advancing pairwise synchronization operations in a deliberate settling schedule, not an end-to-end CPU, I/O, byte-transfer, or wall-clock running-time bound. The separate synchronization-performance intent may continue to defer change-sensitive running-time requirements.

---

$id-8532915736687645
title: Causality-respecting conflict authority
date: 2026/09/07
source: @ottojung
kind: requirement

Journal conflict authority must extend exact happened-before while keeping writer-local sequence numbers local to their writer.

A semantic event which is genuinely causally after another semantic event must have greater conflict authority. For concurrent value occurrences, authority should normally prefer the occurrence with the later legacy `modifiedAt` value, after adjustment required to preserve causal monotonicity. If the resulting authority times tie, durable writer fingerprint is the cross-writer tie-breaker; a writer-local journal sequence is compared only after the writer fingerprints are equal.

Journal sequence numbers from different writers must not be numerically compared to decide conflict precedence. The design may use a hybrid logical clock or an equivalent total-order timestamp which is seeded by `modifiedAt` for value events and advanced as necessary so happened-before always implies increasing authority. This is a deterministic conflict policy, not a guarantee of true wall-clock recency under clock skew.

---

$id-3817813711344897
title: No clock-skew rejection requirement
date: 2026/09/09
source: @ottojung
kind: accepted-tradeoff

The journal does not need a maximum-clock-skew rejection rule.

A badly skewed local clock, persisted `modifiedAt`, or previously observed authority high-water mark may suppress the normal `modifiedAt` preference for later concurrent conflicts. Once absorbed, that high-water mark may remain ahead of local wall time for an arbitrarily long period.

That persistence is accepted rather than adding a rule which tries to decide whether a remote or persisted authority coordinate is implausibly far from the observer's own wall clock. Supported state must not be rejected solely because its physical authority coordinate is far ahead of the observer's local time.

---

$id-7267992945144356
title: Preserve legacy graph representation during Journal 3
date: 2026/09/13
source: @ottojung
kind: constraint

Journal 3 must not change the stored representation of existing IncrementalGraph sublevels as part of this work.

The stored formats, keys, values, and meanings of existing sublevels such as `values`, `freshness`, `valid`, `timestamps`, and identifier metadata must not be extended with journal, provenance, causal, synchronization, or replay metadata. Journal-specific state must live in new storage rather than being embedded into those existing records.

This is a scope constraint for Journal 3, not a permanent prohibition on a separately owned future migration or redesign of the IncrementalGraph representation.

---

$id-6408459523082482
title: Journals are local to one database
date: 2026/09/13
source: @ottojung
kind: requirement

Each writable database owns one local journal stream containing the events authored by that database.

Synchronization may read, transfer, or locally cache immutable journal records authored by other databases, but those records retain their original author identity and are not re-authored as if they were local history. Local journal streams are not required to become byte-for-byte identical across databases.

When synchronization itself genuinely authors a new semantic event on a receiver, that new event belongs to the receiver's local journal stream under the receiver's normal journal rules.

---

$id-5823796411086523
title: Fixed-width physical clock space
date: 2026/09/10
source: @ottojung
kind: accepted-tradeoff

Physical real-time/calendar instants used by the journal are treated as fixed-width values with `O(1)` serialized size. This includes canonical legacy `createdAt`/`modifiedAt` instants when represented as journal metadata and the physical component of any hybrid logical clock authority timestamp.

This models the actual finite epoch-millisecond time representation used by the system. History-growing integer coordinates such as journal sequences and HLC logical components remain separate from physical time.

This intent does not impose a bound on the total size of retained replay history.

---

$id-4719065396881648
title: No remote-participation dependency
date: 2026/09/13
source: @ottojung
kind: requirement

Synchronization and journal correctness must not assume eventual participation, acknowledgement, or return of any particular remote host.

A supported remote host or remote state may be absent for an arbitrarily long finite interval after previously participating, may never return after participating, or may first be encountered only after an arbitrarily long delay. Correctness and the retained information required for later synchronization must remain valid in all of these cases.

No mandatory correctness rule may require every potentially relevant host to acknowledge an event, deletion, reset, migration, checkpoint, or other journal fact. Lifecycle and bootstrap code may rely on invariants of supported Volodyslav-produced state; it is not required to contact or discover every possible peer merely to prove the absence of unsupported external manipulation.

---

$id-8254606583674715
title: oldValue safety over cache retention
date: 2026/09/07
source: @ottojung
kind: requirement

Synchronization must prefer `oldValue` safety over retaining a cached materialization.

A cache may be retained only when the supported IncrementalGraph contract establishes that it remains permissible to expose that materialization to its computor as `oldValue`. Synchronization must not invent a weaker synchronization-only meaning of `oldValue` merely to preserve cache reuse.

For supported persisted IncrementalGraph state, a present materialization is already a legitimate cache of that semantic node. Dependency changes, concurrency, or mixed replica provenance do not by themselves make that cache unsafe as `oldValue`; those facts may instead affect freshness and validity.

If an independent structural or semantic rule makes a cached materialization unsafe to retain, synchronization must remove it rather than weakening the `oldValue` contract.

---

$id-2048186621237391
title: Atomic graph and journal publication
date: 2026/09/06
source: @ottojung
kind: requirement

Graph state and the journal information describing that state must be published atomically.

Whenever one supported operation changes existing IncrementalGraph sublevels and appends corresponding journal history, those changes must become durable as one atomic publication. A supported persisted state must not expose the graph side of such a transition without its corresponding journal side, or the journal side without the matching graph transition.

---

$id-7323556069253070
title: No payload equality in ordinary synchronization
date: 2026/09/06
source: @ottojung
kind: constraint

Ordinary synchronization must not compare `ComputedValue` payloads, or use payload equality, to infer value identity, origin, provenance, causal history, validation history, freshness, validity, or conflict precedence.

An implementation may avoid physically rewriting bytes when equality is already known for some independent reason, but equality itself carries no synchronization authority or historical evidence.

---

$id-4373538486707762
title: Transport-independent persistent database and journal semantics
date: 2026/09/06
source: @ottojung
kind: requirement

The IncrementalGraph implementation and Journal are transport-independent.

Journal identity, event semantics, replay, synchronization, conflict authority, recovery identity, and other IncrementalGraph semantics must not depend on Git hashes, commits, branches, ancestry, repository revisions, hostnames, Supabase-specific identifiers, or other transport/deployment-specific identities.

Implementation-owned persistent IncrementalGraph state MUST NOT store or reference hostnames, Git branch names, repository identities, or other transport locators. This prohibition applies to Journal records, graph metadata, indexes, recovery metadata, staging metadata, and other implementation-owned persisted database sublevels. Transport/lifecycle code may use such information externally to locate or implement a synchronization or recovery source, but that information must not cross into persisted IncrementalGraph state or its semantic APIs.

This does not prohibit application/computor-defined graph data from containing a hostname or other transport-looking string when user code deliberately chooses to store one. Such keys and payloads are opaque application data and are outside IncrementalGraph's control.

Transport mechanisms may carry or persist Journal/database snapshots without their own identities participating in database meaning. Journal 3 does not require changing the existing Git transport protocol; such transport changes, if ever desired, are separate work.

---

$id-6158827469032147
title: Persistent database state is lifecycle-owned
date: 2026/09/16
source: @ottojung
kind: requirement

Persistent IncrementalGraph database state may change only through supported Volodyslav lifecycle transitions. Specifications and implementations must not enlarge the supported state space by inventing recovery semantics for arbitrary external storage damage or rollback.

Complete disappearance of the local database is the one supported externally caused local-storage loss: it yields the lifecycle's `Absent` state and may be handled by the normal Volodyslav-controlled restoration or fresh-creation path. Partial deletion, rollback to an older local database state, mixing old and new storage, partial restoration, or direct external mutation are outside the supported lifecycle model and may be treated as corrupted/unsupported state rather than repaired semantically.

Crashes or interruption during a supported Volodyslav transition are different from external storage mutation. Each supported transition must define or inherit crash/atomicity behavior such that any state it exposes for later supported use is itself a valid lifecycle state; a crash does not authorize arbitrary partially committed database meaning.

Specifications may rely on closure under these supported transitions and need not defend against hypothetical partial histories that cannot arise within this model. Any future proposal to support an additional external-loss or rollback case must first change this intent and define an explicit controlled lifecycle transition.

---

$id-2863157490134726
title: One current format per database replica
date: 2026/09/14
source: @ottojung
kind: requirement

A supported database replica must contain persisted state in one current database format selected by that replica's existing `global/version` value. Journal records must not carry independent per-record version stamps, and ordinary open/replay/synchronization code must not upcast, downcast, or otherwise interpret a mixture of historical record formats inside one replica.

A database migration may temporarily keep the old active replica and a new inactive target replica at different database versions while constructing the atomic cutover. Within each replica, however, persisted graph state, journal records, and journal-derived metadata must all use that replica's single version format.

When journal storage format changes, migration rewrites every retained journal record into the target version's canonical representation before cutover. The rewrite preserves each record's `JournalRecordId`, historical semantic fact, causal identity, and cross-record references. New semantic migration events are appended separately when the graph/schema migration itself changes current meaning.

---

$id-9304516876420351
title: Whole-journal migration cost is acceptable
date: 2026/09/14
source: @ottojung
kind: accepted-tradeoff

Keeping one current persisted format is more important than making database migration proportional only to recent journal changes.

A migration which changes journal representation may inspect and rewrite the complete retained journal. Its running time and I/O may therefore grow linearly with the number and serialized size of retained journal records, even when the current graph or recent change set is small. This whole-history migration cost is an accepted price for avoiding permanent per-record version tags, compatibility decoders, and mixed-format state.

Implementations should still stream the rewrite when practical so the accepted time/I/O cost does not imply retaining the complete journal in RAM. This trade-off concerns migration cost only; it does not weaken journal retention, replay correctness, synchronization convergence, or the separate synchronization-performance intent.

---

$id-1270770443138081
title: Independent migration may stale dependents of replaced occurrences
date: 2026/09/14
source: @ottojung
kind: accepted-tradeoff

Journal-aware migration does not require replicas to coordinate on one canonical semantic migration author when a migration genuinely creates or replaces value occurrences.

Each replica may independently author its own replacement `ValueEvent`. When those histories later synchronize, normal conflict authority selects the current occurrence. A dependent whose certificate names a losing replacement occurrence may therefore become stale and require revalidation or recomputation.

This consequence is accepted in order to preserve migration independence and the no-remote-participation requirement. Occurrence-preserving migrations—including representation-only whole-Journal rewrites combined with `keep`—preserve existing shared ValueIds and do not incur this identity split.

---

$id-1847369205416728
title: Canonical bootstrap creation must be arbitrated
date: 2026/09/14
source: @ottojung
kind: requirement

The one-time transition from legacy state into a synchronization cohort's canonical Journal bootstrap must not permit two independently created canonical histories to both become accepted for the same cohort.

The configured transport-neutral cohort bootstrap source must distinguish an existing canonical snapshot, definite absence suitable for first creation, and an indeterminate/error result. Indeterminate/error must fail rather than authorize creation.

This requirement specifies lifecycle semantics only. It does not prescribe Git locking, a hosted backend, RPCs, or another transport mechanism. If distinct canonical bootstrap histories are nevertheless discovered, the state is unsupported and requires explicit recovery rather than payload-based reconciliation.
