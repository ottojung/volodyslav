# DependencyGraph Migration Strategy

## Overview

This document describes strategies for migrating data between different `DependencyGraph` schemas. A schema change occurs when node definitions are modified, resulting in a new `schemaHash` and isolated storage namespace.

## Problem Statement

When a `DependencyGraph` schema changes, the system computes a new `schemaHash` and creates a fresh storage namespace. This isolates the new schema from the old one, preventing interference. However, this raises the question: **How do we migrate existing computed values from the old schema to the new schema?**

Key considerations:

- Node identity preservation (which nodes map between schemas)
- Computor versioning (when computations need recomputation vs. value reuse)
- Selective migration (copy only relevant nodes)
- Atomicity and rollback
- Performance with large graphs

## Schema Changes and Storage Isolation

### How Schema Hashing Works

The `DependencyGraph` computes a stable hash of the schema definition:

```javascript
const schemaRepresentation = compiledNodes
    .map((node) => ({
        output: node.canonicalOutput,
        inputs: node.canonicalInputs,
    }))
    .sort((a, b) => a.output.localeCompare(b.output));

const schemaJson = JSON.stringify(schemaRepresentation);
const schemaHash = crypto.createHash("sha256").update(schemaJson).digest("hex");
```

**Result:** Any change to node definitions (adding/removing nodes, changing inputs, reordering) produces a new `schemaHash` and a completely isolated storage namespace.

### Storage Structure

Each schema has four isolated databases:

- `values` - Computed node values (keyed by NodeKey: `{"head":"name","args":[...]}`)
- `freshness` - Node freshness state (`"up-to-date"` | `"potentially-outdated"`)
- `inputs` - Forward dependency tracking
- `revdeps` - Reverse dependency index for invalidation

## Migration Strategies

### Strategy 1: No Migration (Fresh Start)

**Approach:** Let the new schema start with empty storage. All nodes recompute on demand.

**Pros:**

- Simplest approach
- No migration code needed
- Guaranteed correctness (all values computed from sources)
- Works for any schema change

**Cons:**

- Full recomputation cost on first access
- Loss of expensive computations from old schema

**When to use:**

- Development and testing environments
- Schema changes are frequent
- Computation cost is acceptable
- Old values may be incorrect due to computor changes

**Implementation:**

```javascript
// Simply create new graph with new schema
const newGraph = makeDependencyGraph(rootDatabase, newNodeDefs);
// Old schema data remains in DB under old schemaHash
// New schema starts fresh
```

### Strategy 2: Selective Value Copy

**Approach:** Copy node values from old schema to new schema for nodes with matching identity.

**Node Identity Rules:**

Two nodes have the **same identity** across schemas if:

1. They have the same `NodeKey` (same head and bindings)
2. Their transitive dependency structure is **structurally identical**
3. All computors in the dependency chain are considered "semantically equivalent"

**Pros:**

- Avoids recomputation for unchanged parts of the graph
- Surgical approach - migrate only what's safe
- Can preserve expensive computations

**Cons:**

- Requires careful identity analysis
- Risk of stale values if computors changed behavior
- Complex implementation

**When to use:**

- Large graphs with expensive computations
- Schema changes are localized (add/remove nodes, but core graph stable)
- You can verify computor equivalence

**Implementation Approach:**

```javascript
async function migrateSelectiveValues(
    rootDatabase,
    oldSchemaHash,
    newSchemaHash,
    nodeIdentityMap,
) {
    const oldStorage = rootDatabase.getSchemaStorage(oldSchemaHash);
    const newStorage = rootDatabase.getSchemaStorage(newSchemaHash);

    const operations = [];

    // Iterate through nodes safe to migrate
    for (const [oldKey, newKey] of nodeIdentityMap.entries()) {
        const value = await oldStorage.values.get(oldKey);
        if (value !== undefined) {
            operations.push(newStorage.values.putOp(newKey, value));
            operations.push(newStorage.freshness.putOp(newKey, "up-to-date"));
        }
    }

    await newStorage.batch(operations);
}
```

**Identity Analysis Example:**

```javascript
// Old schema
[
    { output: "A", inputs: [], computor: sourceA },
    { output: "B", inputs: ["A"], computor: computeB_v1 },
    { output: "C", inputs: ["B"], computor: computeC },
][
    // New schema - added node D, changed computor for B
    ({ output: "A", inputs: [], computor: sourceA },
    { output: "B", inputs: ["A"], computor: computeB_v2 }, // Changed!
    { output: "C", inputs: ["B"], computor: computeC },
    { output: "D", inputs: [], computor: sourceD }) // New!
];

// Migration decision:
// - A: Safe to copy (source node, no dependencies, same computor)
// - B: UNSAFE to copy (computor changed - may produce different result)
// - C: UNSAFE to copy (depends on B which changed)
// - D: New node, nothing to copy
```

### Strategy 3: Computor Versioning + Selective Copy

**Approach:** Annotate computors with version numbers. Copy values only when version chains match.

**Conceptual Model:**

```javascript
{
    output: "B",
    inputs: ["A"],
    computor: computeB,
    computorVersion: "v2"  // Semantic version
}
```

**Migration Rules:**

For a node N to be safely migrated:

1. N exists in both old and new schema with same identity
2. N's computor version is unchanged (or semantically equivalent)
3. All transitive dependencies also satisfy these rules

**Pros:**

- Explicit versioning makes decisions transparent
- Can reason about when recomputation is needed
- Supports gradual schema evolution

**Cons:**

- Requires discipline to maintain version annotations
- More complex schema definition
- Still requires manual verification of semantic equivalence

**When to use:**

- Long-lived production systems
- Schema changes are incremental and documented
- Team can maintain versioning discipline
- Want explicit control over recomputation decisions

**Implementation:**

This requires schema extensions and is not currently supported by the DependencyGraph specification. Would need:

1. Add `computorVersion` field to `NodeDef`
2. Include version in `schemaHash` computation
3. Build migration tool that compares version chains

### Strategy 4: Dual-Graph Reconciliation

**Approach:** Run both old and new graphs in parallel. Copy values where they match, flag differences.

**Pros:**

- Validates migration correctness
- Catches computor behavioral changes
- Can generate migration report

**Cons:**

- Expensive (runs everything twice)
- Only practical for testing/validation
- Not suitable for production migration

**When to use:**

- Testing migration strategies
- Validating computor equivalence claims
- Debugging migration issues

### Strategy 5: Source-Only Migration

**Approach:** Copy only source node values (nodes with no inputs). Let derived nodes recompute.

**Pros:**

- Extremely simple and safe
- Preserves only user-provided data
- All derived values are guaranteed correct
- Works for any schema change

**Cons:**

- Recomputes all derived nodes
- Loses expensive intermediate computations

**When to use:**

- Source nodes are explicitly set by users (not derived)
- Derived computations are fast enough to recompute
- You want guaranteed correctness with minimal complexity
- Schema changes affect derived node definitions but sources are stable

**Implementation:**

```javascript
async function migrateSourceNodes(
    rootDatabase,
    oldSchemaHash,
    newSchemaHash,
    oldNodeDefs,
    newNodeDefs,
) {
    const {
        parseExpr,
    } = require("./backend/src/generators/dependency_graph/expr");
    const {
        deserializeNodeKey,
    } = require("./backend/src/generators/dependency_graph/node_key");

    const oldStorage = rootDatabase.getSchemaStorage(oldSchemaHash);
    const newStorage = rootDatabase.getSchemaStorage(newSchemaHash);

    // Identify source nodes (inputs: []) in both schemas
    const oldSources = oldNodeDefs
        .filter((def) => def.inputs.length === 0)
        .map((def) => parseExpr(def.output).name);

    const newSources = newNodeDefs
        .filter((def) => def.inputs.length === 0)
        .map((def) => parseExpr(def.output).name);

    // Find common source nodes (by head name)
    const commonSources = oldSources.filter((s) => newSources.includes(s));

    const operations = [];

    // Copy all materialized instances of common source nodes
    for await (const oldKey of oldStorage.values.keys()) {
        const nodeKey = deserializeNodeKey(oldKey);

        if (commonSources.includes(nodeKey.head)) {
            const value = await oldStorage.values.get(oldKey);
            if (value !== undefined) {
                operations.push(newStorage.values.putOp(oldKey, value));
                operations.push(
                    newStorage.freshness.putOp(oldKey, "up-to-date"),
                );
            }
        }
    }

    await newStorage.batch(operations);
}
```

## Recommended Strategy

**For most use cases, we recommend Strategy 5 (Source-Only Migration)** combined with Strategy 1 (Fresh Start) as a fallback.

**Rationale:**

1. **Simplicity:** Easy to implement and understand
2. **Safety:** Cannot copy stale derived values
3. **Correctness:** All derived values are guaranteed fresh
4. **Practical:** Source nodes are typically user data (set explicitly), while derived nodes are computations
5. **Performance:** Most graphs have relatively few source nodes compared to derived nodes

**Implementation Pattern:**

```javascript
async function migrateGraph(
    rootDatabase,
    oldNodeDefs,
    newNodeDefs,
    options = {},
) {
    const { strategy = "source-only", skipMigration = false } = options;

    if (skipMigration || strategy === "fresh-start") {
        // Strategy 1: Fresh start
        return makeDependencyGraph(rootDatabase, newNodeDefs);
    }

    // Get old schema hash
    const oldGraph = makeDependencyGraph(rootDatabase, oldNodeDefs);
    const oldSchemaHash = oldGraph.getSchemaHash();

    // Create new graph (gets new schema hash)
    const newGraph = makeDependencyGraph(rootDatabase, newNodeDefs);
    const newSchemaHash = newGraph.getSchemaHash();

    if (oldSchemaHash === newSchemaHash) {
        // No schema change, no migration needed
        return newGraph;
    }

    if (strategy === "source-only") {
        // Strategy 5: Migrate source nodes only
        await migrateSourceNodes(
            rootDatabase,
            oldSchemaHash,
            newSchemaHash,
            oldNodeDefs,
            newNodeDefs,
        );
    }

    return newGraph;
}
```

## Migration Checklist

When changing a `DependencyGraph` schema:

- [ ] Identify what changed (added nodes, removed nodes, changed computors, changed dependencies)
- [ ] Decide if migration is needed or fresh start is acceptable
- [ ] If migrating, choose appropriate strategy based on:
    - Size of graph (number of materialized nodes)
    - Cost of recomputation
    - Confidence in computor equivalence
    - Risk tolerance for stale data
- [ ] Test migration on a copy of production data
- [ ] Implement migration script
- [ ] Document computor changes (for future reference)
- [ ] Consider versioning computors for future migrations
- [ ] Plan rollback strategy

## Future Enhancements

### Computor Versioning Support

To better support Strategy 3, the DependencyGraph specification could be extended:

```javascript
{
    output: "enhanced_event(e)",
    inputs: ["event_context(e)", "metadata(e)"],
    computor: async ([ctx, meta], old, bindings) => ({...ctx, ...meta}),
    computorVersion: "1.0.0",  // Semantic version
    computorId: "enhance-event-v1"  // Stable identifier
}
```

Benefits:

- Explicit tracking of computor changes
- Automated migration decision-making
- Schema evolution history

### Migration DSL

For complex migrations, a declarative DSL could help:

```javascript
const migration = {
    from: oldSchemaHash,
    to: newSchemaHash,
    rules: [
        {
            type: "copy",
            pattern: "source_*",
            condition: "unchanged",
        },
        {
            type: "recompute",
            pattern: "derived_*",
            reason: "computor-changed",
        },
        {
            type: "transform",
            source: "old_node(x)",
            target: "new_node(x)",
            transform: (oldValue) => ({ ...oldValue, newField: defaultValue }),
        },
    ],
};
```

This is beyond the current scope but could be valuable for large-scale production systems.

## Conclusion

DependencyGraph migrations require careful consideration of:

1. **Node identity** preservation across schemas
2. **Computor equivalence** and versioning
3. **Performance** vs. **correctness** tradeoffs
4. **Complexity** vs. **safety** tradeoffs

**Recommended approach for most cases:**

- Start with **source-only migration** (Strategy 5)
- Fall back to **fresh start** (Strategy 1) if schema changes are radical
- Consider **selective value copy** (Strategy 2) only for large graphs with provably unchanged computors
- Invest in **computor versioning** (Strategy 3) for long-term production systems with frequent schema evolution

The simplest safe approach is often the best: **copy sources, recompute everything else**.
