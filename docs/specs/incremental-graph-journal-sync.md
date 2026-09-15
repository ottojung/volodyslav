# IncrementalGraph Journal 3 Synchronization

## Purpose

Journal 3 synchronization replicates immutable journal history and materializes deterministic replay.

It does not merge mutable graph sublevels as independent authorities and does not define a separate semantic "full sync" algorithm.

For an already-established writable receiver the core operation is:

```text
open one stable source JournalSnapshot
verify exact compatibility metadata from that snapshot
copy every missing immutable writer suffix
validate immutable history and causal closure
normalize only the graph transitions required by IncrementalGraph semantics
project the final journal
atomically publish journal + projection
```

An established fresh receiver may have frontier zero; that is ordinary zero-frontier synchronization. A completely **absent installation with no writer identity** instead uses the receiver-less restoration lifecycle in `database-lifecycle.md` before it can call this receiver-required operation.

## Semantic API

Conceptually:

```text
synchronizeFrom(source: JournalSyncSource) -> SyncResult
```

The source abstraction is transport-neutral. Journal 3 specifies the semantic stable-snapshot contract, not Git branches, remote tables, RPCs, or another transport protocol.

## Preconditions

Synchronization requires:

- a valid writable receiver with established `localWriter`;
- one stable source `JournalSnapshot`;
- exact compatible database version and graph scheme;
- valid contiguous receiver/source writer prefixes;
- transitively closed semantic-event contexts;
- a valid receiver journal/projection pair;
- exclusive receiver maintenance ownership for import normalization/final cutover;
- no conflicting canonical content under one `JournalRecordId`.

## Snapshot compatibility cut

The held source snapshot supplies:

```text
S.databaseVersion
S.graphSchemeString
S.localWriter
S.frontier
S.records
```

The first two are the exact persisted source `global/version` and exact persisted `global/graph_scheme` string from the **same immutable committed source state** as the frontier and records.

Before interpreting/importing source history require:

```text
S.databaseVersion == R.databaseVersion
S.graphSchemeString == R.graphSchemeString
```

Both comparisons are exact.

A metadata read made before `openSnapshot()` is not a substitute. If the source migrates/cuts over between an earlier check and snapshot acquisition, the held snapshot's metadata governs the operation.

Mismatch fails with `JournalVersionCompatibilityError`; synchronization never performs implicit migration.

## Missing writer suffixes

Let receiver/source frontiers be FR and FS.

For every writer A with:

```text
FS[A] > FR[A]
```

R imports exactly:

```text
A:(FR[A]+1) .. FS[A]
```

in ascending writer-local sequence order.

No node summary substitutes for missing authoritative history.

## Immutable overlap law

For every record ID present on both sides, canonical current-format meaning must agree exactly.

A disagreement is a writer fork/corruption error. It is not resolved by:

- payload equality;
- event authority;
- Git/filesystem ancestry;
- source/receiver preference; or
- remapping the record ID.

## Same-writer prefix recovery

If receiver local writer is A and S contains a longer exact A prefix, synchronization may recover that suffix under exclusive maintenance.

Before any new A-authored normalization record is allocated, reconstruct from the recovered history:

- local Journal head;
- local `last_node_index` writer state;
- semantic authority high-water;
- other derived local allocator state.

The next local record is strictly after the recovered A head.

If overlap differs, recovery fails as a fork.

This rule handles a **behind existing receiver**. If no local database/writer identity exists at all, the lifecycle first uses `restoreAbsentFrom(snapshot)` rather than guessing that a source writer is the absent installation's identity inside synchronization.

## Foreign writer suffixes

Foreign records are copied verbatim and retain their original:

- writer/sequence ID;
- causal context;
- authority time;
- payload/timestamps;
- references.

Receiving B:73 does not create an A-authored `Adopt(B:73)` or acknowledgement event merely for transport.

## Imported context validation

A source snapshot is supported only when every semantic event context is a genuine causally closed cut.

For F=(W,q):

```text
F.context[W] == q - 1
```

and if F's context includes semantic event E, then:

```text
for every writer A:
    E.context[A] <= F.context[A]
```

The candidate union must also retain every coordinate claimed by those contexts.

Synchronization may complete a merely missing transferred prefix while staging, but it must never "repair" an immutable imported event whose encoded context omits a transitive causal predecessor.

## Stable snapshot union

Let:

```text
J0 = union(JR, JS)
FU = join(FR, FS)
```

where overlaps agree and both input histories are supported.

Because supported event contexts are closed cuts, complete prefix union through FU remains causally closed.

At the retained-information level compatible union is:

- idempotent;
- commutative;
- associative.

The staging target may be temporarily incomplete while ranges stream in, but it is not publishable until all required records through FU are present and validated.

No second mutable source read is needed to fetch a payload: `ValueEvent` already contains its replay payload/timestamps.

## Normalization versus raw union

Raw union is authoritative retained information, but the combination can expose a graph transition which neither input had separately materialized.

Journal 3 may therefore append receiver-authored semantic normalization before publication.

Normalization is not transport acknowledgement. Its records represent real graph transitions and remain ordinary immutable history after commit.

## Phase 1: dependency-closure removal

Select current Value/Delete heads of J0 by ordinary replay authority.

If selected current value K has a direct required input D whose selected head is absent, K cannot remain materialized under the IncrementalGraph contract.

Compute the required structural dependent removal closure and, for every selected-present K in that closure, author receiver:

```text
DeleteEvent {
    node: K,
    reason: "sync"
}
```

The events:

- observe the complete imported causally closed frontier;
- use ordinary HLC allocation after imported authority high-water;
- are ordered cause-before-dependent;
- make cache destruction explicit history rather than latent omission.

Call the resulting history J1.

`J1` must have dependency-closed selected current values.

A later unseen concurrent positive event may make a node present again, but a correctly authored sync delete is not retroactively removed from history.

## Phase 2: persist staleness caused only by stale direct inputs

Compute:

```text
P1 = project(J1)
```

For each present K, let:

```text
C = certificate_P1(K)
```

where **C is exactly the replay-selected certificate using the normative selection key**:

```text
1. basisMatchCount
2. coversValueInvalidations (true > false)
3. authority
```

Define:

```text
selfProofReady(K) iff
    C exists
    and basisMatchCount(K,C) == numberOfDirectInputs(K)
    and coversValueInvalidations(K,C)
```

Node-scoped invalidation coverage is already part of certificate eligibility, so `selfProofReady` means K's own selected proof is complete and persistently valid for the selected occurrence. It is not stale because of basis mismatch, node invalidation, or its own uncovered value invalidation.

If:

```text
selfProofReady(K)
and some direct input D is stale in P1
```

then K is stale **solely through recursive input freshness**.

To preserve the existing flag-based transition, synchronization ensures history contains an uncovered current-occurrence marker:

```text
InvalidateEvent {
    node: K,
    scope: {
        kind: "value",
        value: P1.valueId(K)
    },
    reason: "sync"
}
```

unless an applicable persistent marker is already present.

This rule applies to the selected post-union occurrence regardless of provenance. In particular it covers a newly selected imported ValueId.

Example:

```text
A -> B
receiver: A=a1 stale
source:   B=b2 fresh, certificate B={A:a1}
```

After union B=b2 has complete matching self-proof but is stale because A is stale. The receiver persists `Invalidate(B,value=b2,reason=sync)`. If A later validates `Unchanged`, B remains stale until B itself validates/recomputes.

No sync marker is required merely because K has:

- a current-basis mismatch;
- an uncovered node-scoped invalidation; or
- an already-uncovered value-scoped invalidation.

Those are already persistent causes of staleness.

Apply phase 2 through the complete affected dependency closure. An implementation may use derived reverse indexes; #1607 owns the future end-to-end time bound.

Call the result Jfinal.

## Final replay and validation

Compute:

```text
Pfinal = project(Jfinal)
```

Before cutover verify at least:

- held snapshot version/schema exactly matched receiver metadata;
- every retained writer stream is contiguous;
- every overlapping ID has one meaning;
- every semantic event context has exact own-writer prefix and transitive closure;
- every happened-before edge increases authority;
- every ValueId reference satisfies reference causality;
- validation bases have unique explicit input NodeKeys in canonical order;
- selected-present heads are dependency-closed;
- selected current NodeIdentifiers are bijective;
- every current certificate is target-schema-compatible;
- every occurrence stale solely through recursive direct-input freshness has persistent current-value invalidation history;
- all ordinary IncrementalGraph invariants and `oldValue` safety hold;
- local writer allocator state is at least as advanced as retained local history requires.

The target graph is exactly Pfinal's lowering. Mutable pre-sync graph bytes are not a second repair authority.

## Synchronization-authored event allocation

A sync-authored Delete/Invalidate event:

1. observes the complete imported/receiver causally closed frontier;
2. receives context satisfying the same exact own-prefix/transitive-closure rules as every semantic event;
3. receives authority after the maximum observed semantic authority;
4. consumes the next receiver writer sequence;
5. participates in future synchronization normally.

Imported records remain under their original authors.

## Atomic publication

Transfer may stream into inactive storage for a long time.

The active database changes only at final cutover, which publishes together:

```text
Jfinal
project(Jfinal)
local writer allocator/high-water state
required derived indexes/caches
```

No supported state exposes new journal + old graph or old journal + new graph.

Failure before cutover leaves the previous active supported state selected, apart from disposable staging.

## Full synchronization

An established fresh receiver with frontier zero uses the same algorithm:

```text
FR[B]=0, FS[B]=905 -> import B:1..905
```

A later receiver:

```text
FR[B]=900, FS[B]=905 -> import B:901..905
```

Everything after acquisition is identical.

Again, this zero-frontier case assumes an already-created receiver identity. It is not the absent-installation restore operation.

## Streamability

Missing writer suffixes must be streamable without materializing the complete history/suffix in RAM.

The receiver may write streamed records directly to inactive durable staging with bounded decoding buffers.

Normalization may use graph-sized derived/scratch state where correctness currently requires it. No end-to-end change-sensitive time theorem is imposed yet; #1607 owns that contract.

## Pairwise result law

Successful `Sync(R,S)`:

1. checked exact compatibility from the held S snapshot;
2. retains every compatible immutable record from R and S;
3. changes no imported record body;
4. adds only receiver-authored normalization justified above;
5. commits `receiverGraph = project(receiverJournal)`;
6. repeated sync against the unchanged incorporated source is a semantic no-op.

## Why repeat sync is a no-op

After the first success:

- no source suffix is missing;
- dependency closure repairs are already historical current authority;
- a current occurrence stale solely through stale inputs already has its persistent value invalidation;
- normalization does not create acknowledgement chains.

Therefore no semantic record is newly justified solely by observing the same source facts again.

## Convergence and termination

Journal 3 guarantees convergence of each actual fair execution, not counterfactual confluence between executions that actually authored different normalization events.

After non-normalization graph-changing operations stop, synchronization can create only:

```text
DeleteEvent(reason="sync")
InvalidateEvent(reason="sync", scope=value(...))
```

It creates no ValueEvent or ValidateEvent.

A sync delete defeats the already-observed positive occurrence which required structural removal. Another delete for that node can become necessary only after previously unseen finite positive history selects another occurrence.

A sync invalidation makes one exact ValueId persistently stale. Normalization cannot clear it because clearing requires a causally later validation and normalization never creates validations.

With finite pre-existing positive history and a finite schema DAG, only finitely many normalization obligations can arise after quiescence. Fair synchronization eventually disseminates all actually authored records, all participating replicas reach equivalent projections, and further sync becomes a semantic no-op.

## Delayed/absent replicas

Correctness never requires every remote to acknowledge or return.

A delayed supported replica can later consume missing immutable suffixes. Authoritative records are not destructively reclaimed merely because known peers advanced.

An installation whose **local database is absent** is a lifecycle-restoration case, not evidence that every remote must participate.

## Multi-source execution

The core operation is pairwise against one held stable source snapshot.

An outer procedure may process multiple sources sequentially. Each successful source may commit independently, so an aggregate failure can coexist with earlier successful commits.

Raw imported history union is order-independent. Receiver-authored normalization is real history, so different counterfactual source schedules may create different real semantic histories before all facts are observed.

Every supported fair actual execution must converge relative to the events it actually authored.

## Version boundary

Ordinary synchronization operates only across exactly compatible snapshot `global/version` and `global/graph_scheme` interpretations.

Cross-version/schema transition belongs to the migration lifecycle. Synchronization does not upcast/downcast/rewrite source records.