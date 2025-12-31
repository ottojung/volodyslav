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
* **Freshness** — conceptual predicate: `{ up-to-date, potentially-outdated }` (implementation representation is not prescribed)
* **Computor** — a deterministic function `(inputs: NodeValue[], oldValue: NodeValue | undefined, bindings: Record<string, ConstValue>) => NodeValue | Unchanged`
* **Unchanged** — the only observable sentinel value indicating the computation returned the same value as before
* **Variable** — a parameter placeholder in node schemas (bare identifiers in argument positions)
* **Literal** — a typed constant value appearing in expressions (nat or single-quoted string)
* **ConstValue** — a typed constant value with kind (`'string' | 'nat'`) and value (string content or number)

### Node Schemas and Expressions

Instead of concrete node names, the graph is defined using **node schemas** that may contain variables.

**Expression Grammar (Normative):**

```
expr          := atom_expr | compound_expr
atom_expr     := ident
compound_expr := ident "(" arg ("," arg)* ")"

arg           := var | nat | string
var           := ident
nat           := "0" | [1-9][0-9]*
string        := "'" (escaped_char | [^'])* "'"
ident         := [A-Za-z_][A-Za-z0-9_]*

escaped_char  := "\\" | "\'" | "\\n" | "\\t" | "\\r"
```

**Terminology:**
* **atom-expression** — an expression with no arguments (e.g., `all_events`)
* **compound-expression** — an expression with arguments (e.g., `event_context(e)`)
* **free variables** — identifiers occurring in argument positions that are not literals
* **concrete expression** — an expression where `freeVars(expr) = ∅` (no free variables)

**Examples:**
* `all_events` — atom-expression (no arguments)
* `event_context(e)` — compound-expression with free variable `e`
* `event_context('id123')` — concrete compound-expression (no free variables)
* `fun_123(a, 42, 'abc', b)` — compound with free variables `a`, `b` and literals `42` (nat), `'abc'` (string)
* `enhanced_event('id123', 'photo5')` — concrete compound with string literals

**Note on String Quoting:** This specification uses **single quotes** (`'...'`) for string literals to distinguish them syntactically from variables. Implementations may choose to support double quotes as well, but the canonical form MUST use single quotes.

**Concrete Instantiation:**

A **concrete node** is a concrete expression (no free variables):
* `event_context('id123')` — concrete instantiation with `e = 'id123'`
* `enhanced_event('id123', 'photo5')` — concrete instantiation with two string literals

### Canonical Serialization (Normative)

The function `serialize(expr)` produces a unique canonical string representation:

**Rules:**
1. No whitespace is included
2. Natural numbers are rendered as decimal strings with no leading zeros (except `"0"` itself)
3. Strings use single-quote delimiters with escape sequences: `\'`, `\\`, `\n`, `\t`, `\r`
4. Arguments are joined by commas with no spaces
5. Atom-expressions: just the identifier (e.g., `all_events`)
6. Compound-expressions: `name(arg1,arg2,...)` with no spaces

**Examples:**
* `all_events` → `"all_events"`
* `event_context('id123')` → `"event_context('id123')"`
* `fun(42, 'test')` → `"fun(42,'test')"`
* `status('e1', 'active')` → `"status('e1','active')"`

**Round-trip Requirement:**
* `parse(serialize(ast))` MUST equal `ast` (modulo whitespace normalization)
* `serialize(parse(s))` MUST canonicalize `s`

**Database Storage:**
All database keys for node values and freshness MUST use canonical serialization.

### Graph Structure

A **DependencyGraph** is defined by:
* A set of **node schemas**: `{ (output_expr, input_exprs[], computor) }`
* Where `input_exprs` is a list of expressions this node depends on
* Variables in `output_expr` MUST be a superset of all variables in `input_exprs`
* The graph MUST be acyclic when considering the schema structure (not individual instantiations)

**Schema Overlap Detection (Normative):**

A schema output pattern `P` **matches** a concrete node `N` if and only if:
1. Same functor (identifier) and arity (number of arguments)
2. For each argument position:
   * If pattern arg is a literal: it MUST equal the concrete node arg literal
   * If pattern arg is a variable: it binds to the concrete node arg literal

Two schema output patterns **overlap** if and only if there exists at least one concrete node that matches both patterns.

**Graph Initialization Requirement:**
The system MUST reject graphs with overlapping output patterns.

**Examples of Allowed (Non-overlapping) Patterns:**
* `status(e, 'active')` and `status(e, 'inactive')` — disjoint due to different second literal
* `node1(x)` and `node2(y)` — disjoint due to different functors

**Examples of Disallowed (Overlapping) Patterns:**
* `node(x)` and `node(y)` — overlap (both match `node('val')`)
* `status(e, s)` and `status(x, 'active')` — overlap (both match `status('e1', 'active')`)

**Example Graph Definition:**

```javascript
[
  {
    output: "all_events",           // atom-expression
    inputs: [],
    computor: ([], old) => old || { events: [] }
  },
  {
    output: "meta_events",          // atom-expression
    inputs: ["all_events"],
    computor: ([all]) => extractMeta(all)
  },
  {
    output: "event_context(e)",     // parameterized compound-expression
    inputs: ["meta_events"],
    computor: ([meta], old, bindings) => findContext(meta, bindings.e)
  },
  {
    output: "enhanced_event(e, p)", // multi-parameter compound-expression
    inputs: ["event_context(e)", "photo(p)"],
    computor: ([ctx, photo], old, bindings) => enhance(ctx, photo, bindings)
  }
]
```

### Freshness States

Freshness is a **conceptual** property of nodes used for reasoning about correctness:

* **up-to-date** — The concrete node's value is guaranteed to be consistent with all its dependencies
* **potentially-outdated** — The concrete node MAY need recomputation because an upstream dependency changed

**Conceptual Predicate:** The specification reasons about freshness using:
* `isUpToDate(N)` — returns true if node N is up-to-date
* `isPotentiallyOutdated(N)` — returns true if node N is potentially-outdated

**Implementation Freedom:** Implementations MAY encode freshness using:
* Literal enum values (`'up-to-date'`, `'potentially-outdated'`)
* Boolean flags
* Version numbers or epochs
* Any other representation that satisfies the invariants and correctness properties

**Observable Special Values:**
* `Unchanged` is the ONLY observable special value that computors may return
* Internal freshness encodings are NOT externally observable

**Note:** Freshness is tracked per **concrete instantiation**, not per schema. For example, `event_context('id123')` and `event_context('id456')` have independent freshness states.

---

## Variable Binding and Pattern Matching

### Unification

When `pull(concrete_node)` is called, the system MUST:

1. **Pattern Match:** Find a schema whose output expression matches the requested concrete node
2. **Extract Bindings:** Determine variable-to-literal mappings from the match
3. **Instantiate Dependencies:** Apply bindings to all input expressions to get concrete dependency nodes
4. **Recursively Pull:** Pull all concrete dependencies with the same bindings

**Example:**

Given schema: `enhanced_event(e, p)` with inputs `[event_context(e), photo(p)]`

When pulling `enhanced_event('id123', 'photo5')`:
1. Match: `enhanced_event(e, p)` matches with bindings `{e: 'id123', p: 'photo5'}`
2. Instantiate inputs: `[event_context('id123'), photo('photo5')]`
3. Pull both dependencies recursively

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
When a variable appears in multiple input expressions, it MUST be bound to the same literal.

```
event_context(e), photo(p) -> enhanced_event(e, p)
```
Pulling `enhanced_event('id123', 'photo5')` binds `e='id123', p='photo5'` for ALL inputs.

**Rule 3: Literals in Input Expressions**
Input expressions MAY contain literals (not just variables). These act as filters.

```
metadata(e), status(e, 'active') -> active_metadata(e)
```
This schema only applies to events with `status='active'`.

---

## Dependency Propagation with Parameterization

### Challenge: Partial Invalidation

When a source node changes (e.g., `all_events` is updated via `set()`), ALL instantiations that transitively depend on it become potentially-outdated.

**Example:**
```
all_events -> meta_events -> event_context(e)
```

When `set('all_events', newData)` is called:
* `meta_events` becomes potentially-outdated
* **ALL** materialized instantiations `event_context('id123')`, `event_context('id456')`, etc. become potentially-outdated

**Implementation Challenge:** How do we efficiently mark all instantiations without enumerating them?

## Operations on Parameterized Graphs

### Source Nodes (Normative Definition)

A **source node** is a concrete node `N` where:
* It is **external** (no schema matches it), OR
* It matches a schema whose `inputs = []` (no dependencies)

Source nodes represent entry points to the dependency graph that receive data from external systems or direct user input.

### set(nodeName, value)

**Preconditions:** 
* `nodeName` MUST be a concrete expression (no free variables)
* `nodeName` MUST be a source node

**Effects:**
1. Store `value` at `nodeName`
2. Mark `nodeName` as `up-to-date`
3. Mark all materialized dependents (transitively) as `potentially-outdated`

**Error Handling:**
* If `nodeName` contains free variables, throw error
* If `nodeName` is not a source node, throw `InvalidSetError`

**Examples:**
```javascript
set('all_events', newData)              // OK: source node (no inputs)
set('event_context('id123')', ctx)      // ERROR: not a source (has inputs)
set('event_context(e)', data)           // ERROR: contains free variable
```

### pull(nodeName) → NodeValue

**Preconditions:** 
* `nodeName` MUST be a concrete expression (no free variables)
* For external nodes: node may be created with pass-through behavior if it doesn't exist
* For schema-based nodes: a matching schema pattern must exist in the graph to instantiate from

**Materialized Instantiations:**
When `pull()` is called with a concrete instantiation (e.g., `event_context('id123')`), the system:
1. Searches for a matching schema pattern (e.g., `event_context(e)`)
2. Extracts variable bindings from the match (e.g., `{e: 'id123'}`)
3. Creates a **materialized concrete node** on-demand with instantiated dependencies
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

**Example:**

Given schemas:
```javascript
[
  { output: "all_events", inputs: [], computor: ... },
  { output: "meta_events", inputs: ["all_events"], computor: ... },
  { output: "event_context(e)", inputs: ["meta_events"], computor: ... }
]
```

Call: `pull('event_context('id123')')`

1. Parse: `compound("event_context", ["'id123'"])`
2. Match: `event_context(e)` matches with `{e: 'id123'}`
3. Instantiate inputs: `["meta_events"]` (no variables)
4. Pull: `pull('meta_events')`
   * Pull: `pull('all_events')`
   * Compute meta_events
5. Compute: `computor([meta_value], old, {e: 'id123'})`
6. Store result at concrete key `event_context('id123')`
7. Persist materialized node marker for restart resilience

---

## Database Storage Model

### Key Naming Convention

Concrete node names are stored as database keys using canonical serialization:

* Atom-expressions: `'all_events'`, `'meta_events'`
* Concrete compounds: `"event_context('id123')"`, `"enhanced_event('id123','photo5')"`

**Serialization Format:**

All database keys MUST use the canonical serialization as defined in the "Canonical Serialization" section.

**Freshness Keys:**

Use the same convention with a prefix: `'freshness:' + canonical_node_name`

* `'freshness:all_events'`
* `"freshness:event_context('id123')"`

**Materialized Node Markers:**

Implementations MUST persist markers for materialized instantiations to ensure restart resilience. The specific mechanism is implementation-defined, but MUST allow reconstruction of the set of materialized nodes after restart.

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
set('all_events', {events: [{id: 'id123', data: '...'}]})
pull("event_context('id123')")  // Returns event with id='id123'
```

**Dependency Chain:**
1. `pull("event_context('id123')")`
2. → Match schema with `e='id123'`
3. → Pull `'meta_events'`
4. → → Pull `'all_events'` 
5. → Compute `event_context('id123')` with bindings `{e: 'id123'}`

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
pull("enhanced_event('id123', 'photo5')")
```

**Dependency Chain:**
1. Match schema with `{e: 'id123', p: 'photo5'}`
2. Pull `"event_context('id123')"` (binds `e='id123'`)
3. → Pull `'all_events'`
4. Pull `"photo('photo5')"` (binds `p='photo5'`)
5. → Pull `'photo_storage'`
6. Compute `enhanced_event('id123', 'photo5')`

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

**Key Property:** Both `status(e)` and `metadata(e)` receive the SAME binding `e='id123'` when pulling `full_event('id123')`.

---

## Edge Cases and Error Handling

### Unmatched Pull Request

**Error:** `pull("event_context('id123')")` but no schema matches `event_context(e)`

**Behavior:** Throw `InvalidNodeError` (same as current behavior for unknown nodes)

### Partial Bindings

**Error:** Schema has `output: "enhanced(e, p)"` but input is `"incomplete(e)"`

**Behavior:** This is invalid at graph definition time (violates Rule 1: output variables must cover input variables). Should be caught during graph initialization.

### Literals in Schema Outputs

**Question:** Can a schema output contain literals?

```javascript
{ output: "event_context('id123')", ... }  // Specific to one ID?
```

**Answer:** Technically yes, but this defeats the purpose of schemas. It would only match pull requests for exactly `event_context('id123')`. Generally not useful, but not forbidden.

### Multiple Matching Schemas

**Error:** Two schemas both match the same pull request

```javascript
{ output: "node(x)", inputs: ["a"], ... }
{ output: "node(y)", inputs: ["b"], ... }

pull("node('val')")  // Which schema matches?
```

**Behavior:** This is ambiguous. The system MUST detect overlapping output patterns at graph initialization and reject the graph definition.

**Rule:** Schema output patterns must be mutually exclusive (no two schemas can match the same concrete node).

### Non-Concrete Pull/Set Requests

**Error:** Attempting to pull or set a node with free variables

```javascript
pull("event_context(e)")    // ERROR: contains free variable e
set("all_events(x)", value) // ERROR: contains free variable x
```

**Behavior:** MUST throw an error indicating that pull/set require concrete expressions.

---

## Invariants

The dependency graph MUST maintain these invariants at all stable states (between operations).

**Scope:** These invariants apply to **materialized concrete nodes** — nodes that have been:
* Pulled at least once, or
* Set (for source nodes only)

**Materialized Node Definition:**
A **materialized concrete node** is any concrete node that has been instantiated and persisted (with its value and freshness state). Implementations MUST persist sufficient markers to reconstruct the set of materialized nodes after restart.

**Note on Parameterized Nodes:** The implementation tracks freshness for ALL materialized concrete instantiations. Once a parameterized node like `event_context('id123')` is demanded via `pull()`, it is cached with freshness tracking just like source nodes.

### I1: Outdated Propagation Invariant

If a materialized concrete node is `potentially-outdated`, then all materialized concrete nodes reachable from it (its dependents) are also `potentially-outdated`.

**Formally:** 
```
∀ materialized concrete node N, materialized concrete dependent D 
  where D depends (transitively) on N:
  
  isPotentiallyOutdated(N) ⟹ isPotentiallyOutdated(D)
```

### I2: Up-to-Date Upstream Invariant

If a materialized concrete node is `up-to-date`, then all materialized concrete nodes it depends on (transitively) are `up-to-date`.

**Formally:**
```
∀ materialized concrete node N, materialized concrete dependency I 
  where N depends (transitively) on I:
  
  isUpToDate(N) ⟹ isUpToDate(I)
```

### I3: Value Consistency Invariant

If a materialized concrete node is `up-to-date`, its value MUST equal what would be computed by recursively evaluating all its dependencies and applying its computor function with the appropriate bindings.

**Formally:**
```
∀ materialized concrete node N:
  isUpToDate(N) ⟹ 
    value(N) = computor_schema(N)(
      [value(I₁), ..., value(Iₙ)], 
      previous_value(N), 
      bindings(N)
    )
  where I₁, ..., Iₙ are N's concrete dependencies 
    and bindings(N) are the variable bindings
```

---

## Operations

### set(nodeName, value)

**Preconditions:** 
* `nodeName` MUST be a concrete expression (no free variables)
* `nodeName` MUST be a source node (see definition in "Source Nodes" section)

**Effects:**
1. Store `value` at `nodeName`
2. Mark `nodeName` as `up-to-date`
3. Mark all materialized dependents (transitively) as `potentially-outdated`

**Postconditions:**
* `isUpToDate(nodeName)` = true
* All reachable materialized dependents satisfy `isPotentiallyOutdated(D)` = true
* Invariants I1, I2, I3 are preserved

**Error Handling:**
* If `nodeName` contains free variables, throw error
* If `nodeName` is not a source node, throw `InvalidSetError`

---

### pull(nodeName) → NodeValue

**Preconditions:** 
* `nodeName` MUST be a concrete expression (no free variables)
* For external nodes: node may be created with pass-through behavior if it doesn't exist
* For schema-based nodes: a matching schema pattern must exist in the graph to instantiate from

**Lazy Instantiation:** Unlike traditional dependency graphs that require all nodes to be pre-defined, this implementation supports lazy instantiation of parameterized nodes. When `pull()` is called with a concrete instantiation (e.g., `event_context('id123')`), the system:
1. Searches for a matching schema pattern (e.g., `event_context(e)`)
2. Extracts variable bindings from the match (e.g., `{e: 'id123'}`)
3. Creates a materialized concrete node on-demand with instantiated dependencies
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

### P3: Computor Invoked At Most Once Per Pull

A node's computor MUST be invoked at most once per `pull()` operation, even if the node appears in multiple dependency paths.

**Note:** This is a requirement, not a mechanism. Implementations are free to achieve this property through any means (e.g., memoization, in-flight tracking, freshness checks, etc.).

### P4: Freshness Preservation

After `pull(N)` completes:
* N is marked `up-to-date`
* All nodes on which N (transitively) depends are marked `up-to-date`
* All nodes that (transitively) depend on N remain `potentially-outdated` (unless optimized by downstream propagation)

---

## Optimization: Unchanged Propagation

When a computor returns `Unchanged`:
1. The node's value is NOT updated (keeps old value)
2. The node is marked `up-to-date`
3. Downstream propagation MAY occur (see below)

**Soundness Requirement (Normative):**

An implementation MAY mark a dependent node `D` up-to-date without recomputing `D` **if and only if** it can **prove** that `D`'s value would be unchanged under recomputation given the current values of its dependencies.

**Formally:**
```
mark_up_to_date(D) without recomputation is valid ⟺
  computor_D(current_input_values, stored_value(D), bindings(D)) 
    would return stored_value(D) or Unchanged
```

**Non-Normative Implementation Guidance:**

A common safe strategy is to:
1. Store per-node `value_version` (or dependency snapshot)
2. When a dependency returns `Unchanged`, check if all of `D`'s dependencies have the same versions as when `D` was last computed
3. Only propagate up-to-date if versions match

**Unsound Strategy (DO NOT USE):**
* "If all inputs are up-to-date, mark dependent up-to-date" — this is unsound in diamond graphs where intermediate nodes return `Unchanged` but the transitive values have changed

**Example of Unsound Case:**
```
    A
   / \
  B   C
   \ /
    D
```
If `A` changes, then `B` returns `Unchanged` and `C` returns `Unchanged`, it is NOT safe to automatically mark `D` up-to-date, because `D` might depend on the specific value of `A` in a way that `B` and `C` don't capture.

This optimization is CRITICAL for efficiency with large dependency chains, but MUST be implemented soundly.

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

To efficiently implement downstream propagation and marking potentially-outdated, implementations SHOULD pre-compute a reverse dependency map:

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

### Required Tests (Spec-Level Requirements)

The following tests are REQUIRED to validate conformance to this specification:

1. **Parser/Serializer Round-trip Tests:**
   * `parse(serialize(ast))` MUST equal `ast`
   * `serialize(parse(s))` MUST canonicalize `s`

2. **Concrete Node Rejection Tests:**
   * `pull(fun(a))` with free variable MUST throw
   * `set(fun(x), value)` with free variable MUST throw

3. **Natural Number Literal Validation:**
   * Reject negative numbers
   * Reject floating-point numbers
   * Reject leading zeros (except `0` itself)

4. **Schema Overlap Detection Tests:**
   * Reject overlapping patterns like `node(x)` + `node(y)`
   * Allow disjoint literal patterns like `status(e, 'active')` + `status(e, 'inactive')`

5. **Source Node Restriction Tests:**
   * `set()` on non-source nodes MUST throw `InvalidSetError`
   * `set()` on source nodes (inputs=[]) MUST succeed

6. **Unchanged Propagation Soundness Tests:**
   * Regression test for diamond graph unsound propagation case
   * Verify that naive "all inputs up-to-date" strategy is NOT used

7. **Restart Resilience Tests:**
   * Materialized instantiation markers persist across restarts
   * Graph state correctly reconstructed after restart

---

## Comparison to Step/Run API

The original implementation included `step()` and `run()` methods for push-based propagation. These are now DEPRECATED in favor of pull-based evaluation.

**Rationale:** Pull-based evaluation provides better lazy evaluation semantics and clearer correctness properties. The big-step semantics of `pull` is trivial to specify, whereas `step/run` requires complex iteration semantics.
