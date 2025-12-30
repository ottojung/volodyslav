# Specification for the Dependency Graph

This document provides a formal specification for the dependency graph's operational semantics and correctness properties.

---

## Introduction

The Dependency Graph is a lazy evaluation system that propagates changes through a directed acyclic graph (DAG) of computational nodes. It ensures that computed values are always consistent with their dependencies while minimizing recomputation through aggressive caching.

### Key Properties

**Correctness Invariant:** The big-step semantics of `pull(node)` MUST produce the same result as recomputing all values from scratch, ignoring all cached state.

**Efficiency Goal:** The implementation SHOULD minimize recomputation by exploiting freshness tracking and caching.

---

## Data Model

### Types

* **NodeName** — unique identifier for a node in the graph
* **NodeValue** — the computed value at a node
* **Freshness** — one of `{ clean, dirty, potentially-dirty }`
* **Computor** — a deterministic function `(inputs: NodeValue[], oldValue: NodeValue | undefined) => NodeValue | Unchanged`
* **Unchanged** — a sentinel value indicating the computation returned the same value as before

### Graph Structure

A **DependencyGraph** is defined by:
* A set of **nodes**: `{ (name, inputs[], computor) }`
* Where `inputs` is a list of node names this node depends on
* The graph MUST be acyclic (DAG property)

### Freshness States

* **clean** — The node's value is guaranteed to be consistent with all its dependencies
* **dirty** — The node's value has been explicitly changed and needs recomputation
* **potentially-dirty** — The node MAY need recomputation because an upstream dependency changed

---

## Invariants

The dependency graph MUST maintain these invariants at all stable states (between operations):

### I1: Freshness Propagation Invariant

If a node is `potentially-dirty` or `dirty`, then all nodes reachable from it (its dependents) are either `potentially-dirty` or `dirty`.

**Formally:** 
```
∀ node N, dependent D where D depends (transitively) on N:
  freshness(N) ∈ {dirty, potentially-dirty} 
  ⟹ freshness(D) ∈ {dirty, potentially-dirty}
```

### I2: Clean Upstream Invariant

If a node is `clean`, then all nodes it depends on (transitively) are `clean`.

**Formally:**
```
∀ node N, dependency I where N depends (transitively) on I:
  freshness(N) = clean 
  ⟹ freshness(I) = clean
```

### I3: Value Consistency Invariant

If a node is `clean`, its value MUST equal what would be computed by recursively evaluating all its dependencies and applying its computor function.

**Formally:**
```
∀ node N:
  freshness(N) = clean 
  ⟹ value(N) = computor_N([value(I₁), ..., value(Iₙ)], previous_value(N))
  where I₁, ..., Iₙ are N's inputs
```

---

## Operations

### set(nodeName, value)

**Preconditions:** nodeName exists in the graph

**Effects:**
1. Store `value` at `nodeName`
2. Mark `nodeName` as `dirty`
3. Mark all dependents (transitively) as `potentially-dirty`

**Postconditions:**
* freshness(nodeName) = dirty
* All reachable dependents are marked `potentially-dirty`
* Invariants I1, I2, I3 are preserved

---

### pull(nodeName) → NodeValue

**Preconditions:** nodeName exists in the graph

**Big-Step Semantics (Correctness Specification):**

```
pull(N):
  inputs_values = [pull(I) for I in inputs_of(N)]
  old_value = stored_value(N)
  new_value = computor_N(inputs_values, old_value)
  if new_value ≠ Unchanged:
    store(N, new_value)
  return stored_value(N)
```

**Small-Step Semantics (Efficient Implementation):**

```
pull(N):
  freshness = get_freshness(N)
  
  case freshness of:
    clean:
      # Fast path: cached value is valid
      return get_value(N)
    
    dirty:
      return recalculate(N)
    
    potentially-dirty:
      return maybeRecalculate(N)
```

Where:

```
recalculate(N):
  # Pull all inputs (recursively ensures they're clean)
  input_values = [pull(I) for I in inputs_of(N)]
  
  # Mark inputs as clean
  for I in inputs_of(N):
    mark_clean(I)
  
  # Compute new value
  old_value = get_value(N)
  new_value = computor_N(input_values, old_value)
  
  # Store and mark clean
  if new_value ≠ Unchanged:
    store(N, new_value)
  mark_clean(N)
  
  # Propagate potentially-dirty to dependents
  for D in dependents_of(N):
    if get_freshness(D) ≠ dirty:
      mark_potentially_dirty(D)
  
  return get_value(N)
```

```
maybeRecalculate(N):
  # Check if any input needs recomputation
  needs_recompute = any(get_freshness(I) ≠ clean for I in inputs_of(N))
  
  if not needs_recompute:
    # All inputs are clean, we can trust our cached value
    mark_clean(N)
    return get_value(N)
  
  # At least one input is not clean, so we must recalculate
  # But first, pull all inputs to make them clean
  input_values = [pull(I) for I in inputs_of(N)]
  
  # Mark inputs as clean
  for I in inputs_of(N):
    mark_clean(I)
  
  # Compute new value
  old_value = get_value(N)
  new_value = computor_N(input_values, old_value)
  
  if new_value ≠ Unchanged:
    # Value changed, store it and propagate potentially-dirty
    store(N, new_value)
    mark_clean(N)
    for D in dependents_of(N):
      if get_freshness(D) ≠ dirty:
        mark_potentially_dirty(D)
  else:
    # Value unchanged - this is key for optimization!
    # We can mark ourselves clean AND propagate clean downstream
    mark_clean(N)
    propagate_clean_downstream(N)
  
  return get_value(N)
```

```
propagate_clean_downstream(N):
  # Optimization: if a potentially-dirty node returns Unchanged,
  # its dependents that are potentially-dirty can become clean
  # IFF all their other inputs are also clean
  
  for D in dependents_of(N):
    if get_freshness(D) = potentially-dirty:
      all_inputs_clean = all(get_freshness(I) = clean for I in inputs_of(D))
      if all_inputs_clean:
        mark_clean(D)
        propagate_clean_downstream(D)  # Recurse
```

---

## Correctness Properties

### P1: Semantic Equivalence

For any node N and any state of the database:

```
result_pull = pull(N)
result_recompute = full_recompute_from_scratch(N)

⟹ result_pull = result_recompute
```

Where `full_recompute_from_scratch` ignores all cached values and freshness states.

### P2: Progress

Every call to `pull(N)` MUST terminate (assuming all computor functions terminate).

**Proof sketch:** The graph is acyclic, so recursive calls form a DAG traversal. Each node is visited at most once per pull due to freshness caching.

### P3: Minimal Recomputation

A node's computor is invoked at most once per `pull` operation, even if the node appears in multiple dependency paths.

### P4: Freshness Preservation

After `pull(N)` completes:
* N is marked `clean`
* All nodes on which N (transitively) depends are marked `clean`
* All nodes that (transitively) depend on N remain in their previous freshness state (unless optimized by propagate_clean_downstream)

---

## Edge Cases

### Missing Values

If a node is marked `clean` but has no stored value, this is an error state that MUST throw an exception.

**Rationale:** A `clean` node guarantees value availability. If the value is missing, the database is corrupted.

### Unchanged Optimization

When a computor returns `Unchanged`:
1. The node's value is NOT updated (keeps old value)
2. The node is marked `clean`
3. If the node was `potentially-dirty`, clean state propagates to dependents that are `potentially-dirty` and have all inputs `clean`

This optimization is CRITICAL for efficiency with large dependency chains.

### Leaf Nodes

Leaf nodes (nodes with no inputs) typically have pass-through computors:

```javascript
{
  output: "leaf",
  inputs: [],
  computor: (_inputs, oldValue) => oldValue || defaultValue
}
```

These nodes are written directly via `set()` and serve as entry points to the graph.

---

## Implementation Notes

### Batching

All database operations within a single `pull` call SHOULD be batched and executed atomically to ensure consistency and performance.

### Dependents Map

To efficiently implement `propagate_clean_downstream` and `mark_potentially_dirty`, implementations SHOULD pre-compute a reverse dependency map:

```javascript
dependentsMap: Map<NodeName, Array<Node>>
```

This allows O(1) lookup of a node's immediate dependents.

### Optimization Opportunity

The `propagate_clean_downstream` optimization is particularly effective in scenarios where:
* Many nodes are marked `potentially-dirty` due to an upstream change
* The actual computation returns `Unchanged`
* This allows skipping recomputation of entire subtrees

---

## Testing Strategy

### Property-Based Testing

Tests SHOULD verify:
1. **Correctness:** `pull(N)` equals `recompute_from_scratch(N)` for random graphs and states
2. **Idempotence:** `pull(N); pull(N)` equals `pull(N)` (second call should be fast)
3. **Consistency:** After `set(N, v); pull(M)`, all freshness states satisfy invariants

### Scenario Testing

Tests MUST cover:
1. Linear chains (A → B → C)
2. Diamond graphs (A → B,C → D)
3. Unchanged propagation (node returns Unchanged, dependents skip recomputation)
4. Mixed freshness states (some clean, some dirty, some potentially-dirty)

---

## Comparison to Step/Run API

The original implementation included `step()` and `run()` methods for push-based propagation. These are now DEPRECATED in favor of pull-based evaluation.

**Rationale:** Pull-based evaluation provides better lazy evaluation semantics and clearer correctness properties. The big-step semantics of `pull` is trivial to specify, whereas `step/run` requires complex iteration semantics.
