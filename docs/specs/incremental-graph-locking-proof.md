# Incremental Graph Locking Proof Sketch

This document proves that the locking design in
[incremental-graph-locking-design.md](./incremental-graph-locking-design.md)
enforces the requested concurrency guarantees, assuming the follow-up PR adopts
that design exactly.

## Definitions

Let:

- `G` be the single global key `GRAPH_ACTIVITY_KEY`;
- `P(n)` be the per-node key `PULL_NODE_KEY(nodeKeyString(n))`;
- mode `"observe"` be the mode used by invalidates and inspection reads;
- mode `"pull"` be the mode used by pulls.

Assume the sleeper primitives satisfy the following contracts:

1. `withMutex(key, procedure)` allows at most one active holder for `key`.
2. `withModeMutex(key, mode, procedure)` allows multiple active holders only
   when both `key` and `mode` match.
3. If two active `withModeMutex` holders share the same key and have different
   modes, that is a contradiction.
4. Lock acquisition order is always:
   - first `withModeMutex(G, ...)`,
   - then any `withMutex(P(n), ...)`.

## Goal 1 — Invalidates do not overlap pulls

Every invalidate acquires `withModeMutex(G, "observe", ...)`.

Every pull acquires `withModeMutex(G, "pull", ...)`.

The two modes differ while the key `G` is the same. By contract (3), those two
critical sections cannot be active at the same time.

Therefore no invalidate overlaps any pull.

## Goal 2 — Inspection reads do not overlap pulls

Every inspection read acquires `withModeMutex(G, "observe", ...)`.

Every pull acquires `withModeMutex(G, "pull", ...)`.

The same argument as Goal 1 applies, so no inspection read overlaps any pull.

## Goal 3 — Invalidates may overlap invalidates

Every invalidate acquires `withModeMutex(G, "observe", ...)`.

Two concurrent invalidates therefore request the same key and the same mode.
By contract (2), they are compatible.

Therefore multiple invalidates may overlap.

## Goal 4 — Inspection reads may overlap invalidates

Inspection reads and invalidates both use `withModeMutex(G, "observe", ...)`.

Again, key and mode both match, so by contract (2) they are compatible.

Therefore inspection reads may overlap invalidates.

## Goal 5 — Pulls on the same node do not overlap

Consider two pulls of the same concrete node `n`.

Both acquire `withModeMutex(G, "pull", ...)`, so the global mode lock does not
separate them; that is intentional.

But both also acquire `withMutex(P(n), ...)`.

By contract (1), at most one holder of `P(n)` is active at any time.

Therefore two pulls of the same node cannot overlap in their node-critical
section.

## Goal 6 — Pulls on different nodes may overlap

Consider two pulls of distinct concrete nodes `n1` and `n2`, where `n1 !== n2`.

They both acquire `withModeMutex(G, "pull", ...)`, which is compatible because
the key and mode match.

They then acquire `withMutex(P(n1), ...)` and `withMutex(P(n2), ...)`.

Because the keys differ, contract (1) imposes no mutual exclusion between these
two node locks.

Therefore the design permits pulls on different nodes to overlap.

## Goal 7 — No stale write-back caused by invalidate/pull overlap

A stale write-back race would require:

1. a pull computing node `n`,
2. an invalidate overlapping that pull,
3. the invalidate changing the freshness assumptions that the pull later writes
   back over.

But Goal 1 already established that invalidates do not overlap pulls at all.

Therefore the specific stale write-back race enabled by `withoutMutex` is
eliminated.

## Goal 8 — Deadlock freedom under the stated discipline

We analyze the only possible waiting edges.

### Observe operations

Invalidates and inspection reads only acquire `withModeMutex(G, "observe", ...)`
and no node mutexes.

So an observe operation can wait only on the global mode lock. It cannot wait
while holding a node mutex, and it cannot contribute a node-level cycle.

### Pull operations

A pull first acquires `withModeMutex(G, "pull", ...)`, then acquires node
mutexes for the nodes it traverses.

Because all pulls use the same global mode, once a pull is inside the global
mode section it cannot deadlock against another pull on `G`; those holders are
compatible.

The remaining possibility is a cycle among node mutex waits.

If a pull holding `P(a)` waits for `P(b)`, that means the computation of node
`a` needs node `b`.

A deadlock cycle would therefore give a dependency cycle:

`a1` waits for `a2`, `a2` waits for `a3`, ..., `ak` waits for `a1`.

But the incremental graph schema is validated to be acyclic before execution.
So such a dependency cycle cannot exist.

Therefore, under the stated acquisition discipline and DAG assumption, the
design is deadlock-free.

## Hole Check

The proof depends on a few non-negotiable implementation details:

1. inspection reads must actually use mode `"observe"`;
2. pulls must never downgrade or drop the global `"pull"` mode mid-operation;
3. the per-node mutex key must be derived from the full concrete node key, not
   just the head symbol;
4. the follow-up PR must not introduce an alternate path that mutates graph
   state without first taking the prescribed locks.

If any of these conditions are violated, the proof no longer applies.

## Conclusion

Given the sleeper contracts and the operation protocol from the design
document, the requested locking properties follow directly:

- invalidates overlap invalidates;
- invalidates overlap inspection reads;
- pulls exclude invalidates and inspection reads;
- same-node pulls serialize;
- different-node pulls may overlap;
- the stale race introduced by `withoutMutex` is removed.
