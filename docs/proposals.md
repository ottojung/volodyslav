# Proposals for Full Compliance with Incremental Graph Locking Spec

## Context
This document evaluates realistic ways to achieve full compliance with `docs/specs/incremental-graph-locking-design.md` while preserving correctness of volatile↔persistent synchronization in the identifier lookup and node-state commit path.

The key tension is:

- Locking spec wants **fine-grained pull concurrency** (same-node serialized, different-node concurrent).
- Current volatile/persistent synchronization model relies on strong serialization to avoid lost updates during identifier allocation/commit.

## Compliance target (from spec)

To be fully compliant, the runtime must satisfy all of these simultaneously:

1. `invalidate` and inspection reads run in `observe` mode and may overlap.
2. `pull` runs in `pull` mode and is mutually exclusive with observe-mode activity.
3. Same-node pulls serialize via per-node pull key.
4. Different-node pulls are allowed to progress concurrently.
5. Lock order is stable and deadlock-safe.

## Non-negotiable correctness constraints

Any compliant design must preserve these invariants:

1. **Disk-first ordering for lookup updates**: volatile identifier map must never advance past what was durably flushed.
2. **No lost updates** across concurrent transactions that both allocate identifiers and/or write node-state records.
3. **Atomic visibility boundary**: each transaction’s node-state writes and accompanying identifier-map delta must commit as one coherent persistent batch.
4. **Crash safety**: restart from persistent snapshot must reconstruct a valid lookup/state pair.

## Proposal A: Split execution phase from commit phase

### Idea
Allow concurrent pull computation and dependency traversal, but serialize only the final **commit phase** that merges identifier-allocation deltas and flushes persistent writes.

### Shape
- Keep `withModeMutex(GRAPH_ACTIVITY_KEY, "pull")` for pull phase exclusion vs observe.
- Add per-node `withMutex(PULL_NODE_KEY(node))` around top-level pull body for same-node exclusion.
- Run compute/resolve/freshness logic in per-transaction overlays concurrently.
- At commit boundary, acquire a dedicated `COMMIT_KEY(computedStateIdentifier)` mutex.
- Under `COMMIT_KEY`:
  - rebase/validate transaction identifier overlay against current base,
  - append serialized identifier delta,
  - flush storage batch,
  - then publish overlay into volatile lookup.

### Why it can be compliant
- Different-node pulls can compute in parallel.
- Same-node pulls still serialize.
- Observe/pull separation unchanged.

### Why volatile-persistent correctness holds
- The only shared mutable global is merged under one commit mutex.
- Disk-first ordering remains local to the commit critical section.
- Lost updates are prevented by serialized merge+flush.

### Trade-offs
- More complex transaction lifecycle (prepare vs commit states).
- Potential rebase/retry logic at commit if overlays conflict.

## Proposal B: Two-tier locking for allocation only + optimistic commit validation

### Idea
Serialize only identifier allocation operations with an allocation mutex, while permitting non-allocating transactions to commit concurrently if they do not touch lookup deltas.

### Shape
- Per-node + pull/observe locking as in spec.
- `ALLOC_KEY` protects calls that introduce new node identifiers.
- Transactions record whether they allocated.
- Commit path:
  - Non-allocating tx: commit node-state batch directly.
  - Allocating tx: acquire `ALLOC_KEY`, persist lookup delta + writes, then publish volatile.

### Correctness concerns
- Must guarantee atomic cross-transaction ordering between allocating and non-allocating commits touching related nodes.
- Requires strict constraints to avoid visibility skew where values are committed for identifiers not yet durably mapped.

### Assessment
Feasible but riskier than Proposal A due to mixed commit pathways and subtle ordering hazards.

## Proposal C: Global commit log / journaled state machine

### Idea
Convert commit into append-only journal entries (intent + apply), then materialize canonical maps/state from journal order.

### Benefits
- Strong replay model and explicit crash recovery semantics.
- Easy to reason about ordering and durability.

### Costs
- Large architectural change; heavy migration burden.
- Overkill for current codebase scope.

### Assessment
High assurance but disproportionate complexity for current objective.

## Proposal D: Preserve global transaction serialization (status quo+)

### Idea
Keep full serialization around transaction execution and formalize that as the concurrency contract.

### Assessment
- Preserves correctness trivially.
- Fails full locking-spec compliance because different-node pulls remain blocked.

Not acceptable if full compliance is mandatory.

## Comparative decision matrix

| Proposal | Full spec compliance | Volatile/persistent safety | Complexity | Recommended |
|---|---|---|---|---|
| A. Split execute/commit | High | High | Medium | Superseded by E |
| B. Allocation-only serialization | Medium-High | Medium (subtle hazards) | Medium-High | Maybe |
| C. Journaled commit engine | High | High | Very High | No (now) |
| D. Keep global serialization | Low | High | Low | No |
| E. Minimal locks + locked merge/publish | High | High | Medium-High | **Yes** |

## Historical rollout sketch (Proposal A)

1. **Lock primitives**
   - Introduce `PULL_NODE_KEY` helper and keep current mode locks.
   - Add dedicated `COMMIT_KEY` mutex for persistent/volatile merge.

2. **Transaction model split**
   - Phase 1: compute in transaction overlay (concurrent).
   - Phase 2: commit under `COMMIT_KEY` (serialized merge+flush+publish).

3. **Conflict policy**
   - Define deterministic rebase/abort semantics if overlay assumptions no longer hold at commit.
   - Prefer bounded retry for benign conflicts.

4. **Spec conformance tests**
   - Explicitly test:
     - different-node parallel pull start/progress,
     - same-node serialization,
     - observe/pull incompatibility,
     - invalidate/read compatibility.

5. **Synchronization integrity tests**
   - Concurrent allocation stress tests with crash/restart replay checks.
   - Assertions that every persisted identifier delta is reflected in volatile only after flush success.

## Acceptance criteria for final solution

A solution is acceptable only if all are true:

1. All locking-spec concurrency semantics are demonstrably satisfied.
2. No test shows volatile map ahead of durable state after injected failures.
3. Concurrent allocation workloads show no lost mappings or duplicate inconsistent mappings.
4. Recovery from persisted data reconstructs a coherent identifier lookup and node-state graph.

## Final recommendation

Adopt **Proposal E** below rather than Proposal A. Proposal A identified the right execution/commit split, but Proposal E narrows the lock boundary further: random private overlay allocation remains unlocked, and only concrete node ownership plus merge/publish of shared state is locked.


## Additional option explored: No special lock for identifier-map updates

### Hypothesis
If identifier-map updates are append-only and non-conflicting, perhaps we can remove special commit-time locking for identifier-map updates and rely only on pull-node serialization.

### What the code shows

1. Transaction overlays are private and start from a shared committed base (`makeTransactionIdentifierLookup(base)`).
2. Allocation collision checks (`txAllocateNodeIdentifier`) look only at:
   - the transaction overlay, and
   - the committed base at transaction-start / current reference.
3. They do **not** see allocations made concurrently in other still-uncommitted overlays.
4. Commit applies overlay mappings into base with plain `Map.set` in `commitTransactionLookup`.

### Consequence
Without a special lock (or equivalent coordination) at least around allocation/commit merge, two concurrent pulls on **different** nodes can each allocate the same candidate identifier before either commit is visible to the other.

This is possible even if same-node pulls are serialized, because the conflict is cross-node identifier collision, not same-node duplicate work.

### Why append-only is not enough
"Append-only" here means no deletes/rewrites to existing node keys in normal pull flow. But correctness also requires a global uniqueness invariant for identifier strings (`id -> key` must stay one-to-one).

If two transactions append the same identifier for different keys, one mapping can overwrite the other in volatile `idToKey`, and the persisted serialized lookup can contain logically conflicting pairs. That breaks lookup coherence and can surface as malformed lookup on reload.

### Can the option ever be made safe?
Only with extra guarantees that effectively replace the removed lock, for example:

- Deterministic collision-free identifier derivation from node key (injective in practice), or
- CAS/versioned commit that rejects/retries when base changed in conflicting ways, or
- Reservation protocol so uncommitted allocations are globally visible as unavailable.

Absent one of those, removing special synchronization for identifier-map updates is unsafe.

### Verdict on this option
As currently implemented, this option is **not valid** for full-correctness operation. Same-node pull serialization does not eliminate cross-node allocation conflicts. Any compliant proposal must keep explicit cross-transaction coordination for identifier allocation/merge/commit.

## Proposal E (new recommended): Minimal-lock transaction protocol with unlocked random allocation and locked merge/publish

### Why this proposal exists
The previous proposals treated identifier allocation as a likely synchronization point. After studying the current architecture more closely, the truly necessary synchronization boundary is narrower:

- Random identifier generation itself does **not** need a mutex. The identifier space is large enough for this personal tool, and collision probability is acceptable.
- Per-transaction overlays do **not** need a mutex while they are private to one transaction.
- The shared base lookup and the persistent store **do** need a coordinated merge/publish boundary, because that is where private overlays become globally visible and durable.

This proposal therefore locks the minimum surfaces that carry shared mutable state:

1. graph phase compatibility;
2. concrete node execution/commit ownership;
3. final merge of transaction intent into persistent state plus volatile lookup publication.

### Architecture paths studied

#### Locking entry points
- `withObserveMode` and `withPullMode` already express the global phase split required by the locking spec.
- `withExclusiveMode` already gives migrations/open/reset-style work a mode that blocks pull and observe activity.
- `withComputedStateMutex` currently serializes the entire transaction body and is the main source of over-locking.

#### Pull path
- Public pulls enter `withPullMode`, resolve a concrete node key, and then call `pullNode`.
- Nested pulls reuse the outer transaction via explicit `tx` passing.
- `tx.inFlight` only deduplicates repeated pulls inside a single transaction; it does not coordinate concurrent top-level transactions.

#### Invalidate path
- Invalidations enter `withObserveMode` and then run a transaction.
- They can materialize the invalidated node, allocate an identifier if needed, and propagate freshness to dependents.
- Multiple invalidations may run concurrently by spec, so their writes must be merge-safe rather than protected by a long operation lock.

#### Inspection path
- Inspection reads enter `withObserveMode` and read the volatile identifier lookup plus persistent node-state sublevels.
- They are excluded from pulls but intentionally compatible with invalidations.

#### Transaction / persistence path
- Transactions currently create a private identifier overlay and a batch operations array.
- Current `createBatch` records absolute `put`/`del` operations immediately.
- Current commit serializes `base + overlay`, writes the LevelDB batch, then mutates the base lookup after the batch succeeds.

### Minimal lock set

#### 1. Graph activity mode lock
Keep the existing global mode lock:

- `observe`: invalidate and inspection reads;
- `pull`: pull work;
- `exclusive`: migration/open/reset/switch-replica style work.

This preserves the spec-level phase semantics without serializing same-mode work.

#### 2. Per-node pull locks, held until transaction commit
Acquire a per-node pull lock for every concrete node whose pull body executes, including nested dependency pulls.

Important detail: **do not release a node lock immediately after its computor returns**. The transaction’s writes are still private until commit. Releasing the node lock before commit would allow a second transaction to pull the same node, fail to see the first transaction’s uncommitted writes, and duplicate work/allocation.

Therefore, the transaction owns a set of pull-node locks and releases them only after commit succeeds or aborts.

This is still minimal because:

- disjoint node sets run concurrently;
- shared dependency nodes serialize only where they actually overlap;
- no graph-wide pull mutex is introduced.

#### 3. Commit merge/publish mutex
Replace the broad `withComputedStateMutex` transaction-body lock with a short `COMMIT_KEY(activeReplica)` mutex around only:

1. rebasing private transaction intents onto the latest committed base;
2. serializing the identifier lookup after merge;
3. flushing one atomic persistent batch;
4. publishing the overlay into the volatile base after the flush succeeds.

No computor execution, dependency traversal, or random identifier generation happens under this mutex.

### Transaction representation changes required
The current batch builder eagerly records raw LevelDB operations. That is too early for a concurrent design because some writes are derived from shared state that can change before commit.

A compliant minimal-lock design should record **transaction intents** instead:

1. **Absolute per-node writes** for node-owned records:
   - `values[output]`;
   - `freshness[output]`;
   - `inputs[output]`;
   - `counters[output]`;
   - `timestamps[output]`.

   These are safe because the transaction holds the node’s pull lock until commit.

2. **Merge intents** for shared reverse-dependency records:
   - record `revdepsAdd(inputIdentifier, dependentIdentifier)` rather than `put(input, wholeArray)` during compute.
   - under the commit mutex, read the latest committed `revdeps[input]`, insert the dependent if absent, and write the merged sorted array.

   This avoids lost updates where two concurrent pulls of different dependent nodes both add themselves to the same input’s reverse-dependency list.

3. **Freshness intents with explicit precedence**:
   - `markPotentiallyOutdated(node)` from invalidation;
   - `markUpToDate(node)` from pull.

   Pull and invalidation cannot overlap due to graph activity modes, so cross-mode conflicts are excluded. Concurrent invalidations are idempotent. Concurrent pulls may both mark a shared dependency up-to-date, which is also idempotent.

4. **Identifier overlay intents**:
   - keep private `key -> random id` mappings in the transaction overlay without locking;
   - at commit, merge them with the current base under `COMMIT_KEY`.

### Identifier overlay merge rules

At commit time, for each private `nodeKey -> proposedId` mapping:

1. If the committed base already maps `nodeKey` to `existingId`, use `existingId` as canonical.
   - Rewrite all transaction intents that refer to `proposedId` so they refer to `existingId`.
   - This handles concurrent invalidations or other non-pull paths that materialize the same key.

2. Else if the committed base already maps `proposedId` to some other key, treat it as a random collision.
   - Because collision probability is acceptable, the simplest policy is to abort and retry the whole transaction.
   - A retry generates a new random id and re-runs with current committed state.

3. Else insert `nodeKey -> proposedId` into the base snapshot that will be serialized.

Only this merge needs the commit mutex. Allocation itself remains lock-free.

### Persistent/volatile synchronization protocol

Under `COMMIT_KEY(activeReplica)`:

1. Capture the latest active schema storage and active lookup.
2. Rebase transaction intents and identifier overlay onto that latest base.
3. Construct raw LevelDB operations from rebased intents.
4. If identifier mappings changed, include a raw put of the full serialized identifier lookup in the same persistent batch as node-state writes.
5. Await the persistent batch.
6. After the batch succeeds, synchronously publish the merged identifier mappings into the volatile base.
7. Release node locks owned by the transaction.

This preserves disk-first ordering: volatile lookup publication happens only after durable write success.

### Crash behavior

- Crash before persistent batch completes: volatile changes were not published; durable state remains old.
- Crash after persistent batch completes but before volatile publication: process dies, so volatile memory is lost; restart reloads the durable identifier lookup.
- Crash after volatile publication: durable state already contains the same lookup and node-state batch.

Thus the design preserves volatile-persistent synchronization.

### Interaction with invalidation and inspection

Invalidations remain observe-mode and may overlap each other and inspection reads.

To keep this safe:

- invalidation transactions use the same intent + commit protocol;
- concurrent invalidation writes are idempotent or rebased at commit;
- inspection reads that need lookup/storage coherence should either:
  - read after the no-`await` disk-success-to-volatile-publish window, or
  - optionally use a very short read-side `COMMIT_KEY` section only for multi-sublevel reads such as `listMaterializedNodes`.

The second option is stricter but still minimal: it does not block invalidation computation, only the publish window.

### Lock ordering

The required order is:

1. graph activity mode lock;
2. pull-node locks acquired along dependency traversal;
3. commit merge/publish mutex;
4. release commit mutex;
5. release pull-node locks.

Never acquire observe mode while holding node locks or commit mutex. Exclusive operations acquire exclusive graph mode before touching transaction state.

This remains deadlock-safe because pull-node wait edges follow dependency edges in the graph DAG.

### Why this is less locking than Proposal A
Proposal A serialized the whole commit operation and assumed transaction overlays may need conservative conflict handling. Proposal E is more precise:

- no lock for random identifier generation;
- no lock for private overlay writes;
- no lock for computor execution;
- no lock for disjoint node writes;
- only a short lock for merge/publish of shared persistent/volatile state;
- only concrete node locks for actually overlapping pull work.

### Required tests

1. Different top-level pulls with disjoint dependency closure both enter computors before either finishes.
2. Two top-level pulls sharing a dependency serialize only on the shared dependency node.
3. Same-node top-level pulls serialize until the first transaction commits.
4. Concurrent pulls adding reverse deps to the same input preserve both dependents.
5. Concurrent invalidations of the same previously-unmaterialized node converge on one canonical identifier.
6. Injected failure after batch rejection leaves volatile lookup unchanged.
7. Injected crash/reload after batch success reconstructs the committed lookup from disk.

### Final recommendation
Adopt Proposal E as the implementation target. It matches the user’s intuition that random overlay allocation does not need its own lock, while preserving the essential lock at the merge/publish boundary where correctness actually depends on serialized access to shared volatile and persistent state.
