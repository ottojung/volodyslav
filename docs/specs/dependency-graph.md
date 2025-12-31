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

* **NodeName** — unique identifier for a node in the graph (concrete, fully instantiated)
* **NodeValue** — the computed value at a node
* **Freshness** — one of `{ up-to-date, potentially-outdated }`
* **Computor** — a deterministic function `(inputs: NodeValue[], oldValue: NodeValue | undefined, bindings: Record<string, ConstValue>) => NodeValue | Unchanged`
* **Unchanged** — a sentinel value indicating the computation returned the same value as before
* **Variable** — a parameter placeholder in node schemas (e.g., `e`, `p`)
* **Constant** — a concrete value for a variable (e.g., `id123`, `photo5`)
* **ConstValue** — a typed constant value with kind (`'string' | 'nat'`) and value (string content or number)

### Node Schemas and Expressions

Instead of concrete node names, the graph is defined using **node schemas** that may contain variables.

**Expression Grammar:**

```
expression := atom | compound
atom       := \w+
compound   := atom "(" args ")"
args       := atom | atom "," args
```

**Examples:**
* `all_events` — atom expression (no parameters)
* `event_context(e)` — compound expression with one variable
* `enhanced_event(e, p)` — compound expression with two variables

**Concrete Instantiation:**

A **concrete node** is an expression with all variables replaced by constants:
* `event_context(id123)` — instantiation of `event_context(e)` with `e = id123`
* `enhanced_event(id123, photo5)` — instantiation with `e = id123, p = photo5`

### Graph Structure

A **DependencyGraph** is defined by:
* A set of **node schemas**: `{ (output_expr, input_exprs[], computor) }`
* Where `input_exprs` is a list of expressions this node depends on
* Variables in `output_expr` MUST be a superset of all variables in `input_exprs`
* The graph MUST be acyclic when considering the schema structure (not individual instantiations)

**Example Graph Definition:**

```javascript
[
  {
    output: "all_events",           // atom
    inputs: [],
    computor: ([], old) => old || { events: [] }
  },
  {
    output: "meta_events",          // atom
    inputs: ["all_events"],
    computor: ([all]) => extractMeta(all)
  },
  {
    output: "event_context(e)",     // parameterized
    inputs: ["meta_events"],
    computor: ([meta], old, bindings) => findContext(meta, bindings.e)
  },
  {
    output: "enhanced_event(e, p)", // multi-parameter
    inputs: ["event_context(e)", "photo(p)"],
    computor: ([ctx, photo], old, bindings) => enhance(ctx, photo, bindings)
  }
]
```

### Freshness States

* **up-to-date** — The concrete node's value is guaranteed to be consistent with all its dependencies
* **potentially-outdated** — The concrete node MAY need recomputation because an upstream dependency changed

**Note:** Freshness is tracked per **concrete instantiation**, not per schema. For example, `event_context(id123)` and `event_context(id456)` have independent freshness states.

---

## Variable Binding and Pattern Matching

### Unification

When `pull(concrete_node)` is called, the system MUST:

1. **Pattern Match:** Find a schema whose output expression matches the requested concrete node
2. **Extract Bindings:** Determine variable-to-constant mappings from the match
3. **Instantiate Dependencies:** Apply bindings to all input expressions to get concrete dependency nodes
4. **Recursively Pull:** Pull all concrete dependencies with the same bindings

**Example:**

Given schema: `enhanced_event(e, p)` with inputs `[event_context(e), photo(p)]`

When pulling `enhanced_event(id123, photo5)`:
1. Match: `enhanced_event(e, p)` matches with bindings `{e: id123, p: photo5}`
2. Instantiate inputs: `[event_context(id123), photo(p)]` — **ERROR: `p` not bound in second input**

**Correction:** The dependency should be `photo(p)`, which gets instantiated as `photo(photo5)`.

Actually, looking at the user's example more carefully:
```
event_context(e), photo(p) -> enhanced_event(e, p)
```

This means the inputs are `event_context(e)` and `photo(p)`, not `photo(p)` alone. So when pulling `enhanced_event(id123, photo5)`:
1. Match with bindings: `{e: id123, p: photo5}`
2. Instantiate inputs: `[event_context(id123), photo(photo5)]`
3. Pull both dependencies

### Variable Scope Rules

**Rule 1: Output Variables Must Cover Inputs**
All variables appearing in any input expression MUST also appear in the output expression.

**Valid:**
```
event_context(e) -> derived_event(e)     // e appears in both
all_events -> meta_events                // no variables
```

**Invalid:**
```
event_context(e) -> derived_event()      // ERROR: e in input but not output
event_context(e) -> derived_event(x)     // ERROR: e not bound, x undefined
```

**Rule 2: Multiple Inputs Share Bindings**
When a variable appears in multiple input expressions, it MUST be bound to the same constant.

```
event_context(e), photo(p) -> enhanced_event(e, p)
```
Pulling `enhanced_event(id123, photo5)` binds `e=id123, p=photo5` for ALL inputs.

**Rule 3: Constants in Inputs**
Input expressions MAY contain constants (not just variables). These act as filters.

```
metadata(e), status(e, "active") -> active_metadata(e)
```
This schema only applies to events with status="active".

---

## Dependency Propagation with Parameterization

### Challenge: Partial Invalidation

When a constant node changes (e.g., `all_events` is updated via `set()`), ALL instantiations that transitively depend on it become potentially-outdated.

**Example:**
```
all_events -> meta_events -> event_context(e)
```

When `set("all_events", newData)` is called:
* `meta_events` becomes potentially-outdated
* **ALL** instantiations `event_context(id123)`, `event_context(id456)`, etc. become potentially-outdated

**Implementation Challenge:** How do we efficiently mark all instantiations without enumerating them?

## Operations on Parameterized Graphs

### set(nodeName, value)

**Unchanged:** The `set` operation works only on concrete nodes (atoms or fully instantiated compounds).

```javascript
set("all_events", newData)              // OK: atom
set("event_context(id123)", newContext) // OK: fully instantiated
set("event_context(e)", data)           // ERROR: cannot set schema
```

### pull(nodeName) → NodeValue

**Extended Behavior:**

1. **Parse** the requested node name into an expression
2. **Pattern Match** against schema definitions to find matching schema
3. **Extract Bindings** from the match
4. **Validate** that all variables in the schema are bound
5. **Instantiate** all input expressions with bindings
6. **Recursively Pull** concrete dependencies
7. **Compute** using the schema's computor function with bindings
8. **Store and Cache** the concrete instantiation's value and freshness

**Example:**

Given schemas:
```javascript
[
  { output: "all_events", inputs: [], computor: ... },
  { output: "meta_events", inputs: ["all_events"], computor: ... },
  { output: "event_context(e)", inputs: ["meta_events"], computor: ... }
]
```

Call: `pull("event_context(id123)")`

1. Parse: `compound("event_context", ["id123"])`
2. Match: `event_context(e)` matches with `{e: "id123"}`
3. Instantiate inputs: `["meta_events"]` (no variables)
4. Pull: `pull("meta_events")`
   * Pull: `pull("all_events")`
   * Compute meta_events
5. Compute: `computor([meta_value], old, {e: "id123"})`
6. Store result at concrete key `"event_context(id123)"`

---

## Database Storage Model

### Key Naming Convention

Concrete node names are stored as database keys directly:

* Atoms: `"all_events"`, `"meta_events"`
* Instantiations: `"event_context(id123)"`, `"enhanced_event(id123, photo5)"`

**Serialization Format:**

For compound expressions: `name + "(" + args.join(",") + ")"`

**Freshness Keys:**

Use the same convention: `"freshness:" + concrete_node_name`

* `"freshness:all_events"`
* `"freshness:event_context(id123)"`

---

## Parameterized Graph Examples

### Example 1: Simple Linear Chain

**Schema Definition:**
```javascript
[
  { output: "all_events", inputs: [], computor: passthrough },
  { output: "meta_events", inputs: ["all_events"], computor: extractMeta },
  { output: "event_context(e)", inputs: ["meta_events"], 
    computor: ([meta], old, {e}) => meta.find(ev => ev.id === e) }
]
```

**Operations:**
```javascript
set("all_events", {events: [{id: "id123", data: "..."}]})
pull("event_context(id123)")  // Returns event with id=id123
```

**Dependency Chain:**
1. `pull("event_context(id123)")`
2. → Match schema with `e="id123"`
3. → Pull `"meta_events"`
4. → → Pull `"all_events"` 
5. → Compute `event_context(id123)` with bindings `{e: "id123"}`

---

### Example 2: Multiple Parameters

**Schema Definition:**
```javascript
[
  { output: "all_events", inputs: [], computor: passthrough },
  { output: "event_context(e)", inputs: ["all_events"],
    computor: ([all], _, {e}) => all.events.find(ev => ev.id === e) },
  { output: "photo(p)", inputs: ["photo_storage"],
    computor: ([storage], _, {p}) => storage.photos[p] },
  { output: "enhanced_event(e, p)", 
    inputs: ["event_context(e)", "photo(p)"],
    computor: ([ctx, photo], _, {e, p}) => combine(ctx, photo) }
]
```

**Operations:**
```javascript
pull("enhanced_event(id123, photo5)")
```

**Dependency Chain:**
1. Match schema with `{e: "id123", p: "photo5"}`
2. Pull `"event_context(id123)"` (binds `e="id123"`)
3. → Pull `"all_events"`
4. Pull `"photo(photo5)"` (binds `p="photo5"`)
5. → Pull `"photo_storage"`
6. Compute `enhanced_event(id123, photo5)`

---

### Example 3: Variable Sharing

**Schema Definition:**
```javascript
[
  { output: "status(e)", inputs: ["event_data"],
    computor: ([data], _, {e}) => data.statuses[e] },
  { output: "metadata(e)", inputs: ["event_data"],
    computor: ([data], _, {e}) => data.metadata[e] },
  { output: "full_event(e)", 
    inputs: ["status(e)", "metadata(e)"],
    computor: ([status, meta], _, {e}) => ({id: e, status, meta}) }
]
```

**Key Property:** Both `status(e)` and `metadata(e)` receive the SAME binding `e="id123"` when pulling `full_event(id123)`.

---

## Edge Cases and Error Handling

### Unmatched Pull Request

**Error:** `pull("event_context(id123)")` but no schema matches `event_context(e)`

**Behavior:** Throw `InvalidNodeError` (same as current behavior for unknown nodes)

### Partial Bindings

**Error:** Schema has `output: "enhanced(e, p)"` but input is `"incomplete(e)"`

**Behavior:** This is invalid at graph definition time (violates Rule 1: output variables must cover input variables). Should be caught during graph initialization.

### Constants in Schema Outputs

**Question:** Can a schema output contain constants?

```javascript
{ output: "event_context(id123)", ... }  // Specific to one ID?
```

**Answer:** Technically yes, but this defeats the purpose of schemas. It would only match pull requests for exactly `event_context(id123)`. Generally not useful, but not forbidden.

### Multiple Matching Schemas

**Error:** Two schemas both match the same pull request

```javascript
{ output: "node(x)", inputs: ["a"], ... }
{ output: "node(y)", inputs: ["b"], ... }

pull("node(val)")  // Which schema matches?
```

**Behavior:** This is ambiguous. The system MUST detect this at graph initialization and reject the graph definition.

**Rule:** Schema output patterns must be mutually exclusive (no two schemas can match the same concrete node).

---

## Invariants

The dependency graph MUST maintain these invariants at all stable states (between operations).

**Note on Parameterized Nodes:** The implementation tracks freshness for ALL concrete node instantiations (both constant nodes and parameterized instantiations). Once a parameterized node like `event_context("id123")` is demanded via `pull()`, it is cached with freshness tracking just like constant nodes. Instantiation markers are persisted to ensure that previously demanded instantiations remain tracked across restarts.

### I1: Outdated Propagation Invariant

If a concrete node is `potentially-outdated`, then all concrete nodes reachable from it (its dependents) are also `potentially-outdated`.

**Formally:** 
```
∀ concrete node N, concrete dependent D where D depends (transitively) on N:
  freshness(N) = potentially-outdated
  ⟹ freshness(D) = potentially-outdated
```

### I2: Up-to-Date Upstream Invariant

If a concrete node is `up-to-date`, then all concrete nodes it depends on (transitively) are `up-to-date`.

**Formally:**
```
∀ concrete node N, concrete dependency I where N depends (transitively) on I:
  freshness(N) = up-to-date
  ⟹ freshness(I) = up-to-date
```

### I3: Value Consistency Invariant

If a concrete node is `up-to-date`, its value MUST equal what would be computed by recursively evaluating all its dependencies and applying its computor function with the appropriate bindings.

**Formally:**
```
∀ concrete node N (constant or instantiation):
  freshness(N) = up-to-date
  ⟹ value(N) = computor_schema(N)([value(I₁), ..., value(Iₙ)], previous_value(N), bindings(N))
  where I₁, ..., Iₙ are N's concrete dependencies and bindings(N) are the variable bindings
```

---

## Operations

### set(nodeName, value)

**Preconditions:** 
* nodeName must be a concrete node (no variables)
* For constant nodes: node may be created if it doesn't exist (pass-through behavior)
* For parameterized nodes: a matching schema pattern must exist in the graph

**Effects:**
1. Store `value` at `nodeName`
2. Mark `nodeName` as `up-to-date`
3. Mark all dependents (transitively) as `potentially-outdated`

**Postconditions:**
* freshness(nodeName) = up-to-date
* All reachable dependents are marked `potentially-outdated`
* Invariants I1, I2, I3 are preserved

---

### pull(nodeName) → NodeValue

**Preconditions:** 
* nodeName must be a concrete node (no variables)
* For constant nodes: node may be created with pass-through computor if it doesn't exist
* For parameterized nodes: a matching schema pattern must exist in the graph to instantiate from

**Note on Node Creation:** Unlike traditional dependency graphs that require all nodes to be pre-defined, this implementation supports lazy instantiation of parameterized nodes. When `pull()` is called with a concrete instantiation (e.g., `event_context("id123")`), the system:
1. Searches for a matching schema pattern (e.g., `event_context(e)`)
2. Extracts variable bindings from the match (e.g., `{e: "id123"}`)
3. Creates a concrete node on-demand with instantiated dependencies
4. Persists an instantiation marker for restart resilience

This allows the graph to support an unbounded set of parameterized nodes without pre-creating every possible instantiation.

**Big-Step Semantics (Correctness Specification):**

```
pull(N):
  bindings = extract_bindings(N)  // Extract variable bindings from pattern match
  inputs_values = [pull(I) for I in inputs_of(N)]
  old_value = stored_value(N)
  new_value = computor_N(inputs_values, old_value, bindings)
  if new_value ≠ Unchanged:
    store(N, new_value)
  mark_up_to_date(N)
  return stored_value(N)
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
* N is marked `up-to-date`
* All nodes on which N (transitively) depends are marked `up-to-date`
* All nodes that (transitively) depend on N remain `potentially-outdated` (unless optimized by propagate_up_to_date_downstream)

---

## Optimization: Unchanged Propagation

When a computor returns `Unchanged`:
1. The node's value is NOT updated (keeps old value)
2. The node is marked `up-to-date`
3. Clean state propagates to dependents that are `potentially-outdated` and have all inputs `up-to-date`

**Algorithm for propagate_up_to_date_downstream(N):**

```
propagate_up_to_date_downstream(N):
  for each dependent D of N:
    if freshness(D) = potentially-outdated:
      if all inputs of D are up-to-date:
        mark_up_to_date(D)
        propagate_up_to_date_downstream(D)  // recursive
```

This optimization is CRITICAL for efficiency with large dependency chains and diamond patterns.

---

## Edge Cases

### Missing Values

If a node is marked `up-to-date` but has no stored value, this is an error state that MUST throw an exception.

**Rationale:** An `up-to-date` node guarantees value availability. If the value is missing, the database is corrupted.

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

All database operations within a single `set` call MUST be batched and executed atomically.

Database operations during `pull` MUST be batched per node recomputation.

### Dependents Map

To efficiently implement `propagate_up_to_date_downstream` and `mark_potentially_outdated`, implementations SHOULD pre-compute a reverse dependency map:

```javascript
dependentsMap: Map<NodeName, Array<Node>>
```

This allows O(1) lookup of a node's immediate dependents.

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
3. Unchanged propagation (node returns `Unchanged`, dependents skip recomputation)
4. Mixed freshness states (some up-to-date, some potentially-outdated)

---

## Comparison to Step/Run API

The original implementation included `step()` and `run()` methods for push-based propagation. These are now DEPRECATED in favor of pull-based evaluation.

**Rationale:** Pull-based evaluation provides better lazy evaluation semantics and clearer correctness properties. The big-step semantics of `pull` is trivial to specify, whereas `step/run` requires complex iteration semantics.

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

All database operations within a single `set` call MUST be batched and executed atomically.

Database operations within a whole `pull` call SHOULD not be batched.
Database operations during `pull` MUST be batched per node recomputation.

### Dependents Map

To efficiently implement `propagate_clean_downstream` and `mark_potentially_dirty`, implementations SHOULD pre-compute a reverse dependency map:

```javascript
dependentsMap: Map<NodeName, Array<Node>>
```

This allows O(1) lookup of a node's immediate dependents.
