You are working in the `ottojung/volodyslav` repository, on the flag-based validity work from PR #1440.

Implement the sync-merge validity redesign described below.

Start with tests. Do not begin implementation until you have added failing tests that expose the incompleteness of the current approach.

# Goal

The current sync merge rebuilds the `valid` relation too conservatively. It preserves only target-side validity entries where both the dependency and dependent are `decision === "keep"` and `initialDecision === "keep"`, then adds required flags for final up-to-date nodes.

That is incomplete.

A `valid[D].has(N)` fact means:

```
N's stored value is valid with respect to D's current stored value.
```

It does not mean:

```
N is up-to-date.
```

Therefore stale nodes may still carry useful conditional validity proofs. Sync merge should preserve those proofs when the exact source-side value incarnations survived the merge.

Do not reintroduce persisted `inputs`, `revdeps`, or `counters`.

Do not add a persisted value-incarnation sublevel in this task. Use merge-time value provenance instead.

# Tests first

Add tests that fail against the current implementation.

The tests should expose these cases:

1. Host-side stale validity proof is preserved

Create a graph like:

```
A -> B -> C
```

Prepare the host replica so that:

```
values[A], values[B], values[C] exist
freshness[A] = "up-to-date"
freshness[B] = "potentially-outdated"
freshness[C] = "potentially-outdated"
valid[A] contains B
valid[B] contains C
```

Prepare the local/target side so that the merge plan chooses the host values for A, B, and C.

After `mergeHostIntoReplica`, assert that the final active replica has:

```
valid[finalA] contains finalB
valid[finalB] contains finalC
freshness[B] remains "potentially-outdated"
freshness[C] remains "potentially-outdated"
```

This should fail with the current implementation because host-side `valid` entries are ignored, and the mandatory up-to-date rebuild does not add flags for stale B/C.

2. Target-side stale validity proof is preserved even when the merge decision is invalidate, if the value itself is preserved

Create a case where the final value of a stale node comes from the target side unchanged, but its final freshness is `"potentially-outdated"`.

Seed target-side validity like:

```
valid[A] contains B
```

Make B stale:

```
freshness[B] = "potentially-outdated"
```

Ensure the final value origin for both A and B is target-side. After merge, assert:

```
valid[finalA] contains finalB
```

This should fail against the current implementation if the decision is not literally `keep/keep`, because the current preservation predicate is decision-based rather than value-origin-based.

If this is awkward to trigger through the full merge API, add a focused unit test around the new validity rebuild helper described below. It is acceptable for the first version of the test to fail to compile because the new helper does not exist yet.

3. Cross-side mixed proofs are not preserved

Create a case with semantic edge:

```
A -> B
```

The source side has:

```
valid[A_source] contains B_source
```

But the final merge result takes:

```
A from target
B from host
```

or the reverse.

Assert that the source-side proof is not transported into the final `valid` relation.

Without persisted value-incarnation IDs, a proof from one side is only transportable if both endpoint values come from that same side and those same source identifiers.

4. Identifier lowering transports valid proofs to final identifiers

Create a case where the host has identifiers:

```
hostA
hostB
```

and the final chosen identifiers are:

```
finalA
finalB
```

with the same semantic keys.

Host has:

```
valid[hostA] contains hostB
```

The final value origins for both A and B are host-side:

```
A came from hostA
B came from hostB
```

After merge, assert:

```
valid[finalA] contains finalB
```

This verifies that validity transport is semantic-key-based, not raw-identifier-based.

5. Direct relowering with value deletion does not preserve validity

Create a case where a node’s structural input identifiers lower to different final identifiers and the existing code deletes that node’s copied value / marks it potentially-outdated.

For that node, final value origin must be `none`.

Assert that no validity proof involving that node as a dependent is transported.

6. Invalidation propagation walks through stale nodes

Current `propagateOutdatedFrom` only continues traversal through dependents that were up-to-date and just got marked potentially-outdated. That makes stale nodes act as barriers.

Add a test:

```
A -> B -> C
```

Seed:

```
values[A], values[B], values[C] exist
freshness[A] = "up-to-date"
freshness[B] = "potentially-outdated"
freshness[C] = "up-to-date"
valid[A] contains B
valid[B] contains C
```

Make A change value, then trigger the normal changed-value path for A.

Expected result:

```
freshness[C] becomes "potentially-outdated"
```

This should fail with the current implementation because traversal reaches B, sees B is already potentially-outdated, and does not continue to C.

7. Final merge validation rejects an up-to-date node with a stale input

Add a validation test:

```
A -> B
```

Seed:

```
values[A], values[B] exist
freshness[A] = "potentially-outdated"
freshness[B] = "up-to-date"
valid[A] contains B
```

`assertValidFinalMergeState` must reject this.

An up-to-date node may not depend on a stale direct input.

# Implementation design

Replace the current decision-based validity preservation with provenance-based two-sided validity transport.

## Definitions

Add this internal type conceptually:

```
type ValueOrigin =
    | { kind: "source", side: "target" | "host", sourceId: NodeIdentifier }
    | { kind: "none" };
```

Meaning:

```
{ kind: "source", side, sourceId }
```

The final stored value exists and was copied/preserved exactly from that side’s source identifier.

```
{ kind: "none" }
```

There is no final stored value, or the final stored value is not a byte-for-byte preserved value from either source side.

Important: freshness changes do not by themselves change value origin.

Examples:

* Final value kept from local active replica:
  { kind: "source", side: "target", sourceId: targetId }

* Final value taken from staged host replica:
  { kind: "source", side: "host", sourceId: hostId }

* Final node marked potentially-outdated but value preserved from host:
  { kind: "source", side: "host", sourceId: hostId }

* Final node marked potentially-outdated but value preserved from target:
  { kind: "source", side: "target", sourceId: targetId }

* Final value deleted because identifier relowering changed its dependency identities:
  { kind: "none" }

* Final value absent:
  { kind: "none" }

Do not infer value origin from the final freshness. Infer it from what `applyNodeDecisions` actually writes to the final replica.

## New data produced by merge planning/application

During sync merge, build:

```
valueOriginByKey: Map<NodeKeyString, ValueOrigin>
```

for every semantic key in the final identifier lookup.

The map must describe the final value after all decisions, relowering invalidations, deletions, and copied records are applied.

Rules:

1. If the final `values[finalId]` entry will be absent, origin is `none`.

2. If the final value is kept from the target source identifier, origin is target/sourceId.

3. If the final value is copied from the host source identifier, origin is host/sourceId.

4. If the final value is deleted due to direct relowering or relowering invalidation, origin is `none`.

5. If a node is merely marked `"potentially-outdated"` but its stored value is preserved, keep the source origin.

6. Do not use deep JSON equality of values to invent origin. Origin is about provenance of the stored value, not semantic equality.

## Read validity from both source replicas

Do not read old target validity from the already-mutated merge target replica.

Use the original local active storage as the target source, and the staged host storage as the host source.

The final rebuild should conceptually receive:

```
final target storage to write into
target source storage
host source storage
target source lookup
host source lookup
finalIdentifierForKey
finalIdentifierLookup
mergedInputsMap
valueOriginByKey
```

Replace `preserveAndRebuildValidity` with a new helper, for example:

```
rebuildMergedValidity({
    targetStorage,
    targetSourceStorage,
    hostSourceStorage,
    targetLookup,
    hostLookup,
    finalIdentifierForKey,
    finalLookup,
    mergedInputsMap,
    valueOriginByKey,
})
```

## Transport algorithm

For each source side, run the same transport algorithm.

Pseudocode:

```
async function transportValidityFromSide(side, sourceStorage, sourceLookup) {
    for await (const sourceDepId of sourceStorage.valid.keys()) {
        const sourceDependents = await sourceStorage.valid.get(sourceDepId) ?? []

        const depKey = sourceLookup.idToKey.get(nodeIdentifierToString(sourceDepId))
        if (depKey === undefined) continue

        const finalDepId = finalIdentifierForKey.get(depKey)
        if (finalDepId === undefined) continue

        const depOrigin = valueOriginByKey.get(depKey)
        if (!originMatches(depOrigin, side, sourceDepId)) continue

        for (const sourceDependentId of sourceDependents) {
            const dependentKey = sourceLookup.idToKey.get(nodeIdentifierToString(sourceDependentId))
            if (dependentKey === undefined) continue

            const finalDependentId = finalIdentifierForKey.get(dependentKey)
            if (finalDependentId === undefined) continue

            const dependentOrigin = valueOriginByKey.get(dependentKey)
            if (!originMatches(dependentOrigin, side, sourceDependentId)) continue

            const finalInputs = mergedInputsMap.get(finalDependentId) ?? []
            if (!containsIdentifier(finalInputs, finalDepId)) continue

            addValid(finalDepId, finalDependentId)
        }
    }
}

function originMatches(origin, side, sourceId) {
    return origin?.kind === "source"
        && origin.side === side
        && sameIdentifier(origin.sourceId, sourceId)
}
```

This algorithm is intentionally conservative.

A validity proof is transported only if:

```
the final dependency value came from the same side and same source identifier
the final dependent value came from the same side and same source identifier
the final graph still has the dependency as a structural input edge of the dependent
```

Do not transport mixed-side proofs.

Do not transport proofs where either endpoint has origin `none`.

Do not transport proofs that no longer correspond to a structural edge.

## After transporting optional proofs, add mandatory flags

After both source sides are transported, add required flags for final up-to-date nodes:

```
for every final materialized node N:
    if freshness[N] !== "up-to-date":
        continue

    for every D in mergedInputsMap.get(N) ?? []:
        addValid(D, N)
```

This preserves the hard invariant:

```
every up-to-date node has valid flags for every direct structural input
```

## Write final validity

Clear the final target `valid` sublevel, then write the rebuilt relation.

Requirements:

* No stale `valid` keys may remain.
* Arrays must be sorted with the existing `compareNodeIdentifier`.
* No duplicate dependents.
* Use `nodeIdentifierToString` only for map keys/comparison.
* Preserve `NodeIdentifier` objects/values for database writes.
* Respect existing batch-size limits.

# Strengthen final validation

Update `assertValidFinalMergeState` so it enforces all of these:

1. Every `values` key is present in the final identifier lookup.

2. Every `freshness` and `timestamps` key is present in the final identifier lookup.

3. Every `valid` key is present in the final identifier lookup.

4. Every `valid` key is materialized. That means `values[validKey]` exists.

5. Every dependent listed in `valid[D]` is present in the final identifier lookup.

6. Every dependent listed in `valid[D]` is materialized.

7. Every `valid[D].has(N)` corresponds to a structural edge in the final graph scheme:
   D is in deriveInputEdges(finalScheme, finalLookup, N)

8. Every up-to-date node N has a stored value.

9. Every up-to-date node N has all direct input flags:
   for every D in deriveInputEdges(..., N), valid[D] contains N

10. Every up-to-date node N has only up-to-date direct inputs:
    for every D in deriveInputEdges(..., N), freshness[D] === "up-to-date"

Rule 10 is important. A node must not be considered up-to-date if it depends on a stale direct input.

# Fix invalidation traversal

Update `propagateOutdatedFrom`.

Current behavior effectively does this:

```
for each dependent:
    if dependent is up-to-date:
        mark it potentially-outdated
        push it into the worklist
```

Change it to this:

```
for each dependent:
    if not visited:
        if dependent is up-to-date:
            mark it potentially-outdated
        push it into the worklist anyway
```

Stale nodes must not be traversal barriers. The `visited` set prevents cycles.

This is required for preserved stale validity proofs to remain safe.

# Acceptance criteria

The implementation is complete when:

1. The new tests fail on the current implementation.

2. The new tests pass after your implementation.

3. Existing sync merge, migration, and incremental graph tests pass.

4. No persisted `inputs`, `revdeps`, or `counters` are reintroduced.

5. No persisted value-incarnation storage is introduced.

6. Sync merge preserves compatible stale validity proofs from both target and host.

7. Sync merge rejects or drops unsafe proofs conservatively.

8. Cross-side proofs are not transported unless both endpoints come from the same source side and same source identifiers.

9. Identifier lowering maps transported proofs onto final identifiers.

10. Final validation catches up-to-date nodes depending on stale inputs.

11. Invalidation propagation reaches up-to-date descendants through already-stale intermediate nodes.

# Style constraints

Keep the design local to sync merge and validity handling.

Use clear helper names.

Avoid comments that narrate development history. Comments should describe the current invariant or algorithm, not what the old implementation did.

Do not add broad rewrites unrelated to this task.

Do not weaken existing validation to make tests pass.

Prefer precise unit tests for the validity transport helper plus at least one full `mergeHostIntoReplica` integration test that demonstrates host-side stale proof preservation.
