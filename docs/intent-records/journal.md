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

$id-1235084615014938
title: Journal is the replicated backend state
date: 2026/09/13
source: @ottojung
kind: requirement

The long-term synchronization architecture should upload and replicate the journal rather than uploading the rendered current IncrementalGraph database as the synchronization payload.

A local host may keep derived materialized graph state for efficient operation, but the durable remote synchronization state must be sufficient to recover that host's journal history and reconstruct its supported graph state.

This intent does not require a particular remote storage product or transport protocol.

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

Synchronization must converge.

For any finite set of supported replicas, once graph-changing operations stop, fair repeated synchronization must eventually bring all replicas to observably equivalent IncrementalGraph states. Once this state has been reached, further synchronization without intervening graph changes must be a semantic no-op.

This requirement does not prescribe associativity, commutativity, idempotence, CRDTs, or any particular convergence mechanism.

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
title: Transport-independent journal semantics
date: 2026/09/06
source: @ottojung
kind: requirement

The IncrementalGraph journal is transport-independent.

Journal identity, event semantics, replay, synchronization, and conflict authority must not depend on Git hashes, commits, branches, ancestry, repository revisions, Supabase-specific identifiers, or other transport-specific identities. Transport mechanisms may carry or persist journal records, but they do not participate in journal semantics.
