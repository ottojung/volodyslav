# Petri-net model for IncrementalGraph synchronization

## Context and goal

`docs/specs/incremental-graph-locking-design.md` asks for a locking model with five concurrency
properties:

1. `invalidate()` is exclusive with every `pull()`, but compatible with other invalidations.
2. Inspection reads are compatible with invalidations.
3. `pull()` is exclusive with inspection reads.
4. `pull()` is exclusive with other pulls of the same concrete node.
5. Pulls of different concrete nodes may proceed concurrently.

The same document proposes a concrete lock protocol: a global mode lock with compatible `observe` and
`pull` groups, plus one exclusive per-node pull mutex. It also requires a fixed acquisition discipline:
global activity mode first, then node-level locks, and never acquire `observe` while holding node locks.

This report considers a different model: represent graph synchronization as a Petri network, and ask
whether that model can provide correctness, at least the same fine-grained concurrency as the locking
spec, and simple implementation.

## What a Petri network would mean here

A Petri net is a state-machine model with:

- **places**: resource or state buckets;
- **tokens**: current availability or current state;
- **transitions**: atomic moves that consume tokens from input places and produce tokens into output
  places; and
- **marking**: the whole current token distribution.

For IncrementalGraph, the places would represent graph activity phases and node ownership. A transition
fires when all required tokens are available. While a token is consumed, no incompatible transition can
fire. When the operation finishes, completion transitions restore the tokens.

This is not the same as the previously proposed single logical worker. A single worker serializes all
top-level commands. A Petri-net scheduler can allow independent transitions to fire concurrently when
their input tokens do not conflict. It is closer to a generalized lock manager whose locking policy is
declared as a net.

## Minimal Petri-net encoding of the existing locking spec

The locking spec can be encoded directly.

### Places

```text
place ObservePhaseFree        // no pull phase is active or queued-as-current phase
place PullPhaseFree           // no observe phase is active or queued-as-current phase
place PullSlot                // optional counting place for active pull-mode compatibility
place ObserveSlot             // optional counting place for active observe-mode compatibility
place NodePullFree(nodeKey)   // one token per concrete node
```

A simpler implementation can avoid explicit `PullSlot` and `ObserveSlot` places by treating a graph
phase as a reader-group with a fairness queue. But if the goal is an actual Petri network, the net
needs either colored/counting places or a small amount of scheduler metadata to represent "many holders
of the same phase are compatible, but a conflicting phase waits for the group to drain."

### Transitions

```text
StartObserve(op):
  requires graph phase is not Pull
  records one active observe holder

FinishObserve(op):
  releases one active observe holder

StartPull(nodeKey):
  requires graph phase is not Observe
  consumes NodePullFree(nodeKey)
  records one active pull holder

FinishPull(nodeKey):
  produces NodePullFree(nodeKey)
  releases one active pull holder
```

This encodes the five demanded properties:

- `invalidate()` and inspections are both observe operations, so they can overlap.
- Any observe holder prevents new pull holders in the conflicting phase.
- Any pull holder prevents new observe holders in the conflicting phase.
- Same-node pulls contend on the same `NodePullFree(nodeKey)` token.
- Different-node pulls consume different node tokens and can run concurrently.

So, at the level of **safety**, a Petri net can express the current design exactly.

## A more graph-native Petri-net encoding

The above net is only a reformulation of the existing lock protocol. Petri nets become more interesting
if we model graph work more finely.

A graph-native net could add places such as:

```text
NodeStable(nodeId)            // node value/freshness/inputs are not being rewritten
NodeComputing(nodeId)         // one recomputation owns the node output
NodeDependenciesReading(nodeId)
IdentifierMapFree            // identifier lookup may be extended
CommitLogFree(replica)        // durable batch publication may run
ReplicaPointerStable          // no migration/sync cutover is in progress
```

Then a `pull(A)` transition sequence could be decomposed:

1. enter pull phase;
2. consume `NodeStable(A)`, produce `NodeComputing(A)`;
3. recursively fire dependency pull/read transitions;
4. consume `IdentifierMapFree` only if a new identifier must be allocated;
5. consume `CommitLogFree(activeReplica)` only for the commit transition;
6. produce `NodeStable(A)` and release phase/node tokens.

This is more expressive than the current locking spec. It could, for example, serialize identifier-map
extension while allowing already-identified node computations to proceed, or serialize commits while
allowing computations to prepare batches concurrently.

However, that extra precision comes with a major cost: operations become multi-transition workflows,
and correctness now depends on many intermediate markings. This shifts complexity from lock ordering to
net design, transition atomicity, and scheduler fairness.

## Correctness analysis

### Safety

A Petri-net scheduler can provide safety if all shared mutable invariants are represented by tokens
and every operation consumes the right tokens before touching the protected state.

For the incremental graph, the safety invariants are roughly:

- no pull overlaps an observe operation;
- no two pulls rewrite the same concrete node concurrently;
- identifier allocation is collision-safe and publishes atomically with the batch that introduced the
  identifier;
- volatile lookup publication happens only after durable batch success;
- migration/sync replica cutover is not observed halfway through; and
- nested pulls do not create a dependency-cycle deadlock.

A Petri net can encode these as resource places:

| Invariant | Petri-net resource |
|-----------|--------------------|
| pull vs observe exclusion | global phase places |
| same-node pull exclusion | `NodePullFree(node)` token |
| identifier allocation serialization | `IdentifierMapFree` token, or one owner token per active lookup |
| disk-before-memory commit | commit transition consumes prepared transaction and produces committed volatile state only after durable write succeeds |
| replica cutover isolation | `ReplicaPointerStable` / `CutoverFree` token |
| nested dependency ownership | ordered dependency transitions over DAG nodes |

For safety, Petri nets are strong: the token discipline makes incompatible states unrepresentable if
all state access goes through transitions. In particular, a net can make "allocate identifier without
identifier-map ownership" or "commit while cutover is active" structurally impossible.

The safety weak point is not the model; it is the implementation boundary. If ordinary modules can
still mutate `RootDatabase`, write `identifiers_keys_map`, or update node sublevels outside the net,
the Petri model becomes documentation rather than enforcement. To get real safety, the net scheduler
must be the only entry point for graph-state mutation, just like a lock manager or worker would be.

### Liveness

Liveness is harder. A transition being enabled does not guarantee it will eventually fire unless the
scheduler has fairness rules. A Petri net can prove some deadlock-freedom properties on a finite static
net, but IncrementalGraph is dynamic:

- node places are created lazily for concrete nodes;
- dependencies can be dynamic because computors can call `pull`;
- commits and identifier allocations are conditional;
- operations contain asynchronous effects; and
- the graph may be large enough that full state-space exploration is impractical.

The current locking spec uses a simpler liveness argument:

- the graph phase lock has FIFO mode-group fairness;
- per-node locks are FIFO;
- acquisition order is global phase first, then node locks; and
- recursive pulls follow graph dependencies, which are a DAG.

A Petri-net implementation would need equivalent explicit scheduling rules:

1. **FIFO fairness for conflicting modes.** A stream of observe transitions must not starve a waiting
   pull transition, and a stream of pull transitions must not starve a waiting observe transition.
2. **FIFO fairness per node.** Same-node pulls should not starve behind later same-node work.
3. **No hold-and-wait cycles outside the graph DAG.** If a workflow holds node `A` and waits for node
   `B`, this must correspond to a valid dependency edge `A -> B`. Otherwise the net can create cycles
   that the graph constructor cannot reject.
4. **Failure transitions.** Every started operation must have a completion or rollback path that
   returns consumed tokens even if computation, LevelDB batch write, migration, or sync fails.
5. **Async boundary discipline.** Awaiting arbitrary external work while holding scarce tokens can
   preserve safety but harm liveness and latency.

Thus a Petri-net model can achieve liveness, but not automatically. The implementation still needs a
fair scheduler and very careful rollback paths. Without those, a Petri net can be just as deadlock- or
starvation-prone as a lock system.

## Fine-grained concurrency

### Matching the locking spec

A Petri-net scheduler can match the requested granularity exactly:

| Requested behavior | Petri-net expression |
|--------------------|----------------------|
| invalidates overlap invalidates | compatible observe transitions |
| inspections overlap invalidates | compatible observe transitions |
| pulls exclude observe reads/invalidations | conflicting graph phase places |
| same-node pulls serialize | one `NodePullFree(node)` token |
| different-node pulls overlap | separate node tokens |

So the answer to "can it meet the demanded fine-grainedness?" is yes.

### Going beyond the locking spec

A Petri net can go finer than the spec, but the benefit is questionable.

Possible refinements:

- Only take `IdentifierMapFree` when a transaction actually allocates a new identifier.
- Only take `CommitLogFree(replica)` for the final batch flush/publication step.
- Distinguish read-only dependency inspection from node output mutation.
- Permit multiple prepared computations to run concurrently and serialize only their commit
  transitions.
- Represent migration cutover as a short exclusive transition instead of excluding the whole migration
  callback.

These refinements might improve concurrency, but they introduce conflict detection. For example, if two
prepared computations started from the same freshness/counter snapshot and then commit in a different
order, the second commit may be stale. At that point the design begins to resemble optimistic
transactions with validation, not just Petri-net scheduling.

For this project, "higher than the spec" should probably mean one modest improvement: keep the same
phase/node granularity, but make identifier allocation and commit publication explicit transitions in
the model. Avoid splitting slow computation from commit until there is real performance evidence.

## Simplicity analysis

There are three possible implementation styles.

### Option A: Petri net as documentation/specification only

This is simple to write and useful for reasoning, but it does not enforce correctness. The code would
still use `withModeMutex` and `withMutex` exactly as described in the existing locking spec.

Verdict: good supplement, not a new implementation model.

### Option B: Restricted Petri-net scheduler compiled to existing locks

Define a small resource DSL:

```javascript
startObserve(op)
startPull(nodeKey)
withIdentifierMap(op)
withCommit(replica, op)
withCutover(op)
```

Internally, this compiles to the existing sleeper primitives and a few ordinary mutexes. The "Petri"
part is the declared resource graph and transition protocol, not a general-purpose Petri-net engine.

Verdict: probably the best practical variant if we want Petri-net thinking. It can keep the current
fine-grained behavior and make the resource protocol more explicit without inventing a large runtime.
It is still basically a lock manager.

### Option C: General Petri-net runtime

Build a generic scheduler with dynamic places, colored tokens, transition guards, fairness queues,
rollback transitions, and async transition execution.

Verdict: not simple. It would be more abstract than the current design, harder to type with JSDoc,
harder to debug, and likely overkill for the graph. The model might be elegant, but the implementation
would have many new failure modes.

## Recommended Petri-inspired design

If we pursue this direction, use a **restricted Petri-net lock manager**, not a full Petri-net runtime.

The implementation should expose graph-specific transitions:

```text
observe(op)
  acquires GraphPhase(observe)

pull(nodeKey, op)
  acquires GraphPhase(pull)
  acquires NodePull(nodeKey)

allocateIdentifier(op)
  requires active transaction
  acquires IdentifierMap

commit(replica, op)
  requires prepared transaction
  acquires Commit(replica)

cutover(op)
  acquires GraphPhase(exclusive) or Cutover
```

This gives the main benefit of the Petri model: every protected invariant is represented as an explicit
place/token. But each transition remains graph-specific and small enough to understand.

### Suggested resource places

```text
GraphPhase              // observe vs pull vs exclusive/cutover
NodePull(nodeKey)       // one token per concrete node
IdentifierMap(replica)  // one token for lookup extension/publication
Commit(replica)         // one token for durable batch + volatile publication
Cutover                 // one token for replica pointer replacement
```

### Suggested transition rules

1. Public invalidation and inspection use `GraphPhase(observe)`.
2. Public pull uses `GraphPhase(pull)` plus `NodePull(nodeKey)` for the node currently being pulled.
3. Nested pulls reuse the active pull workflow and acquire dependency `NodePull(dependencyKey)` only in
   graph dependency order.
4. Identifier allocation is allowed only inside an active transaction and consumes `IdentifierMap`.
5. Commit consumes `Commit(replica)` and performs disk-before-memory publication.
6. Migration/sync cutover consumes `Cutover` and a graph-exclusive phase token.
7. Every transition has a `finally` rollback/release path.
8. The scheduler uses FIFO fairness for conflicting phase groups and per-node queues.

This is essentially the existing locking spec plus two improvements:

- identifier-map and commit publication become named resources rather than ad hoc implementation
  details; and
- the resource model can be documented and tested as a transition system.

## Tests and verification strategy

A Petri-inspired implementation should be tested at two levels.

### Scheduler/resource tests

- observe operations overlap;
- pull operations for different nodes overlap;
- pull operations for the same node serialize;
- observe and pull operations exclude each other;
- FIFO mode-group fairness prevents starvation;
- tokens are released on failure;
- nested dependency acquisition cannot violate the DAG order; and
- cutover excludes all incompatible graph activity.

### Graph invariant tests

- concurrent same-node pulls allocate one identifier;
- concurrent different-node pulls do not block unless they share dependencies;
- failed batch writes do not publish volatile identifier state;
- migration cutover never exposes mixed-replica lookup state;
- inspection reads never overlap pull writes; and
- invalidation never overlaps pull recomputation.

A small finite model test may also be worthwhile. For example, model two nodes, one dependency edge,
one observe operation, one same-node pull pair, and one migration. Exhaustively enumerate transition
orders and assert safety properties. This would give confidence without requiring a general verifier.

## Final evaluation

### Correctness: possible, but scheduler-dependent

A Petri-net model is a good fit for safety because shared graph invariants can be represented by
resource tokens. Liveness is possible only if the implementation includes fairness, rollback, and
acyclic nested-acquisition rules. Petri nets do not remove the need to design those rules.

### Fine-grainedness: yes

The model can exactly match the existing locking-design document: observe operations overlap, pull
operations overlap by node, and conflicting observe/pull phases exclude each other. It can also express
finer resources such as identifier-map ownership and commit publication.

### Simplicity: only if restricted

A full Petri-net runtime would not be simple. It would likely be more complex than the current lock
protocol and harder to maintain. A restricted Petri-inspired resource scheduler, compiled to the
existing sleeper primitives, could be simple enough and would make the synchronization model more
explicit.

## Recommendation

Do not replace the incremental graph locking model with a general Petri-net engine.

Instead, if Petri-net structure is desired, use it as a **design language and small resource DSL** over
the existing primitives:

- keep the global observe/pull phase from `docs/specs/incremental-graph-locking-design.md`;
- keep per-node pull exclusion;
- add explicit named resources for identifier-map mutation, commit publication, and replica cutover;
- document each operation as a transition sequence;
- test token release, fairness, and invariant preservation directly.

This achieves the requested safety and fine-grainedness while preserving implementation simplicity. A
general Petri-net scheduler would be theoretically expressive, but it would not satisfy the simplicity
goal.
