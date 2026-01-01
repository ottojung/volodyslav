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
* **Computor** — a deterministic asynchronous function `(inputs: NodeValue[], oldValue: NodeValue | undefined, bindings: Record<string, ConstValue>) => Promise<NodeValue | Unchanged>`
* **Unchanged** — the only observable sentinel value indicating the computation returned the same value as before
* **Variable** — a parameter placeholder in node schemas (bare identifiers in argument positions)
* **Literal** — a typed constant value appearing in expressions (nat or single-quoted string)
* **ConstValue** — a typed constant value with kind (`'string' | 'int'`) and value (string content or number)

### Node Schemas and Expressions

Instead of concrete node names, the graph is defined using **node schemas** that may contain variables.

**Expression Grammar (Normative):**

```
expr          := atom_expr | compound_expr
atom_expr     := ident
compound_expr := ident "(" args ")"

args          := arg ("," arg)*
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
* `Unchanged` is an observable special value that computors may return
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

**Implementation Challenge:** How do we efficiently mark all instantiations without enumerating infinitely many of them?

## Operations on Parameterized Graphs

### Source Nodes (Normative Definition)

A **source node** is a concrete node `N` where:
* It matches a schema whose `inputs = []` (no dependencies)

Source nodes represent entry points to the dependency graph that receive data from external systems or direct user input.

### Brief Overview of Operations

The graph supports two primary operations:
* `set(nodeName, value)` — writes a value to a source node and invalidates dependents
* `pull(nodeName)` — computes (or retrieves cached) value for a concrete node

Detailed specifications for these operations are provided in the "Operations" section below.

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

**Scope:** These invariants apply to **materialized concrete nodes**.

**Materialized Node Definition:**
A **materialized concrete node** is any concrete node for which the implementation maintains dependency tracking. This includes:
* Nodes that have been pulled or set (value materialization)
* Nodes with persisted dependency edges (structural materialization)

Implementations MUST persist sufficient markers to reconstruct dependency relationships after restart. Once a node has dependency tracking, it remains materialized even if its value or freshness state is absent.

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

An implementation SHOULD mark a dependent node `D` up-to-date without recomputing `D` **if and only if** it can **prove** that `D`'s value would be unchanged under recomputation given the current values of its dependencies.

**Formally:**
```
mark_up_to_date(D) without recomputation is valid ⟺
  computor_D(current_input_values, stored_value(D), bindings(D)) 
    would return stored_value(D) or Unchanged
```

---

## Additional Edge Cases

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

---

## JavaScript Interfaces & Conformance Contract (Normative)

This section defines the concrete JavaScript interfaces, API contracts, and error taxonomy that implementations MUST provide and tests MAY observe. These definitions enable deterministic test synthesis and unambiguous implementation audits.

### 1) Core Runtime Types (Normative)

#### 1.1 `ConstValue`

A `ConstValue` represents a typed constant value that can appear in expressions or variable bindings.

**Type Definition:**

```typescript
type ConstValue =
  | { type: "string"; value: string }
  | { type: "int"; value: number };
```

**Normative Requirements:**

* `type` MUST be either `"string"` or `"int"`.
* For `type: "string"`, the `value` field MUST contain the **decoded** string content (escape sequences interpreted).
* For `type: "int"`, the `value` field MUST be a JavaScript number representing a natural integer (0, 1, 2, ...).
* Parsing MUST reject non-natural numbers (negative, floats, etc.) per the grammar rules.

**Examples:**

```javascript
{ type: "string", value: "hello" }        // String constant
{ type: "int", value: 42 }                // Natural number constant
{ type: "string", value: "line1\nline2" } // With decoded newline
```

#### 1.2 `Unchanged`

`Unchanged` is a unique sentinel value that computors MAY return to indicate that the computed value has not changed.

**Normative Requirements:**

* `Unchanged` MUST be a unique sentinel value that cannot be confused with any valid `DatabaseValue`.
* Implementations MUST expose a type guard function `isUnchanged(value): boolean` that returns `true` if and only if `value` is the `Unchanged` sentinel.
* The `Unchanged` sentinel MUST be obtained via a factory function `makeUnchanged()` or equivalent.

**Example Usage:**

```javascript
const unchanged = makeUnchanged();
if (isUnchanged(value)) {
  // Handle unchanged case
}
```

**Observable Behavior:**

* When a computor returns `Unchanged`, the node's stored value MUST NOT be updated.
* The node MUST be marked `up-to-date`.
* Implementations MAY propagate the `up-to-date` state to downstream dependents (see "Optimization: Unchanged Propagation" section).

#### 1.3 `DatabaseValue`

A `DatabaseValue` represents any value that can be stored and retrieved through the `Database` interface.

**Normative Requirements:**

* `DatabaseValue` MUST be an arbitrary JSON-serializable object (or implementation-defined type that is stable across database roundtrips).
* Values MUST round-trip through the `Database` interface without semantic change: `getValue(k)` after `put(k, v)` MUST return a value semantically equivalent to `v`.
* If the database supports richer types beyond JSON, tests MUST NOT assume those types unless explicitly documented.

**Type Guard:**

Implementations SHOULD provide a type guard `isDatabaseValue(value): boolean` to distinguish `DatabaseValue` from `Freshness` or other internal types.

### 2) `Computor` (Normative)

A `Computor` is a deterministic function that computes a node's value based on its input values, previous value, and variable bindings.

**Function Signature:**

```typescript
type Computor = (
  inputs: DatabaseValue[],
  oldValue: DatabaseValue | undefined,
  bindings: Record<string, ConstValue>
) => Promise<DatabaseValue | Unchanged>;
```

**Normative Requirements:**

* Computors MUST be **asynchronous** and return a `Promise`.
* Computors MUST be **deterministic** with respect to `(inputs, oldValue, bindings)`: given the same inputs, old value, and bindings, they MUST produce the same result.
* Computors MUST NOT have hidden side effects that affect their output (no hidden state, no nondeterminism from random number generators, timestamps, etc.).
* Computors MUST NOT be invoked more than once per node per top-level `pull()` call (property P3 from the spec).
* Computors MAY return `Unchanged` to indicate that the value has not changed. This is observable only through storage behavior (value not replaced) and potentially through debug instrumentation if provided.

**Parameters:**

* `inputs: DatabaseValue[]` — Ordered array of input node values. Length and order MUST match the node schema's `inputs` array.
* `oldValue: DatabaseValue | undefined` — The node's previous stored value, or `undefined` if no value exists yet.
* `bindings: Record<string, ConstValue>` — Variable-to-constant mappings extracted from pattern matching. Empty object `{}` for non-parameterized nodes.

**Return Value:**

* `DatabaseValue` — The newly computed value, which will be stored.
* `Unchanged` — The sentinel value indicating no change. The old value will be retained.

**Note on Synchronous Computors:**

While this specification defines computors as asynchronous (`Promise`-returning), implementations MAY accept synchronous computor functions for convenience and automatically wrap them in `Promise.resolve()`. However, the canonical signature and all interface contracts MUST treat computors as asynchronous.

### 3) Node Schema Definition Object Shape (`NodeDef`) (Normative)

A `NodeDef` defines a node schema in the dependency graph.

**Type Definition:**

```typescript
type NodeDef = {
  output: string;     // Expression string (pattern or concrete)
  inputs: string[];   // Array of expression strings (dependencies)
  computor: Computor; // Async function that computes the output
};
```

**Normative Requirements:**

* `output` MUST be a valid expression string that parses according to the Expression Grammar.
* Each entry in `inputs` MUST be a valid expression string that parses according to the Expression Grammar.
* Variables in `output` MUST be a superset of all variables appearing in all `inputs` expressions (Rule 1: Output Variables Must Cover Inputs).
* The schema set MUST be rejected at graph initialization if any two `output` patterns overlap (see "Schema Overlap Detection" section).
* The schema set MUST be rejected at graph initialization if the schema structure forms a cycle (schema-level acyclicity requirement).
* `computor` MUST be a valid `Computor` function as defined above.

**Example:**

```javascript
{
  output: "enhanced_event(e, p)",
  inputs: ["event_context(e)", "photo(p)"],
  computor: async (inputs, oldValue, bindings) => {
    const [context, photo] = inputs;
    return { ...context, photo, eventId: bindings.e.value };
  }
}
```

### 4) Public API: Graph Construction and Operations (Normative)

#### 4.1 Factory Function

**Function Signature:**

```typescript
function makeDependencyGraph(
  database: Database,
  nodeDefs: NodeDef[]
): DependencyGraph;
```

**Normative Requirements:**

* `makeDependencyGraph` MUST be the only public way to construct a `DependencyGraph` instance.
* The function MUST validate all schemas at construction time (synchronously or during first use) and throw on:
  * Parse errors (invalid expression syntax)
  * Variable scope rule violations (Rule 1)
  * Overlapping output patterns
  * Schema cycles
* The function MUST compile and cache any derived artifacts needed for efficient operation (variable lists, canonical forms, pattern indexes, etc.), but the internal representation is not prescribed.
* The function MUST NOT mutate the provided `nodeDefs` array or `database` object.

**Returns:**

A `DependencyGraph` instance that exposes the operations defined below.

**Throws:**

* `InvalidExpressionError` — If any `output` or `inputs` expression fails to parse.
* `InvalidSchemaError` — If variable scope rules are violated or other schema definition problems occur.
* `SchemaOverlapError` — If two or more schemas have overlapping `output` patterns.
* `SchemaCycleError` — If the schema structure is cyclic.

#### 4.2 `DependencyGraph` Interface

**Type Definition:**

```typescript
interface DependencyGraph {
  pull(nodeName: string): Promise<DatabaseValue>;
  set(nodeName: string, value: DatabaseValue): Promise<void>;
}
```

**Type Guard:**

Implementations MUST provide a type guard function `isDependencyGraph(value): boolean`.

#### 4.3 `pull` Method

**Signature:**

```typescript
pull(nodeName: string): Promise<DatabaseValue>
```

**Normative Requirements:**

* `pull` MUST accept any string that parses as a valid expression according to the Expression Grammar.
* `pull` MUST accept expressions with non-canonical quoting (e.g., double quotes if supported) and canonicalize them internally before processing.
* `pull` MUST reject expressions with free variables (non-concrete expressions) by throwing `NonConcreteNodeError`.
* `pull` MUST throw `InvalidNodeError` if the concrete node has no matching schema.
* `pull` MUST return a `Promise` that resolves to the node's computed `DatabaseValue`.
* `pull` MUST ensure that each node's computor is invoked at most once per top-level `pull()` call (property P3).
* `pull` MUST produce the same result as recomputing all values from scratch, ignoring all cached state (Correctness Invariant, property P1).

**Behavior:**

1. Parse and canonicalize `nodeName`.
2. Validate that the expression is concrete (no free variables).
3. Find or instantiate the node schema.
4. Check freshness:
   * If `up-to-date`: Return cached value immediately.
   * If `potentially-outdated` or missing: Recursively pull inputs, recompute if necessary, store result, mark `up-to-date`.
5. Return the node's value.

**Throws:**

* `InvalidExpressionError` — If `nodeName` does not parse as a valid expression.
* `NonConcreteNodeError` — If `nodeName` contains free variables.
* `InvalidNodeError` — If no schema matches.
* `MissingValueError` — If the node is marked `up-to-date` but has no stored value (database corruption).

#### 4.4 `set` Method

**Signature:**

```typescript
set(nodeName: string, value: DatabaseValue): Promise<void>
```

**Normative Requirements:**

* `set` MUST accept any string that parses as a valid expression according to the Expression Grammar.
* `set` MUST accept expressions with non-canonical quoting and canonicalize them internally before processing.
* `set` MUST reject expressions with free variables (non-concrete expressions) by throwing `NonConcreteNodeError`.
* `set` MUST reject non-source nodes by throwing `InvalidSetError`.
* `set` MUST store the value at the canonical node key.
* `set` MUST mark the node as `up-to-date`.
* `set` MUST mark all materialized transitive dependents as `potentially-outdated`.
* All operations MUST be performed atomically in a single database batch.

**Behavior:**

1. Parse and canonicalize `nodeName`.
2. Validate that the expression is concrete (no free variables).
3. Validate that the node is a source node (see "Source Nodes" section).
4. Store `value` at the canonical key.
5. Mark the node as `up-to-date`.
6. Recursively mark all dependents as `potentially-outdated`.
7. Commit all operations atomically via `database.batch()`.

**Throws:**

* `InvalidExpressionError` — If `nodeName` does not parse as a valid expression.
* `NonConcreteNodeError` — If `nodeName` contains free variables.
* `InvalidSetError` — If the node is not a source node.

### 5) Canonicalization at API Boundaries and DB Keys (Normative)

**Canonical Form Definition:**

For any expression string `expr`, the canonical form is defined as:

```
canonical(expr) := serialize(parse(expr))
```

Where:
* `parse(expr)` parses the expression into an AST.
* `serialize(ast)` produces the canonical string representation.

**Normative Requirements:**

* All database keys for node values MUST use `canonical(nodeName)`.
* All database keys for freshness state MUST use `canonical(freshnessKey(nodeName))` where `freshnessKey` applies the freshness key naming convention.
* `pull(nodeName)` and `set(nodeName, value)` MUST behave as if they first compute `canonical(nodeName)` and then operate on that canonical form.
* Tests MUST use canonical forms when asserting database key contents.

**Quoting Rules:**

* The canonical form MUST use **single quotes** (`'...'`) for string literals.
* Implementations MAY accept **double quotes** (`"..."`) in input expressions for convenience.
* If double quotes are accepted, they MUST be canonicalized to single quotes in `serialize()`.
* If double quotes are NOT supported, the parser MUST reject them with `InvalidExpressionError`.

**Recommendation:**

Implementations SHOULD accept double quotes in parsing and canonicalize to single quotes for maximum flexibility.

**Examples:**

```javascript
canonical('event_context("id123")')  // → "event_context('id123')"
canonical("event_context('id123')")  // → "event_context('id123')"
canonical("all_events")              // → "all_events"
canonical("fun(42, 'test')")         // → "fun(42,'test')"
```

### 6) Required Database Interface for Conformance Tests (Normative)

The `Database` interface defines the minimal contract that the dependency graph requires for storage and retrieval.

**Type Definition:**

```typescript
interface Database {
  // Store or overwrite a value at key
  put(key: string, value: DatabaseValue | Freshness): Promise<void>;

  // Retrieve stored value or undefined if missing
  getValue(key: string): Promise<DatabaseValue | undefined>;

  // Retrieve stored freshness or undefined if missing
  getFreshness(key: string): Promise<Freshness | undefined>;

  // Atomically execute a batch of operations
  batch(ops: Array<
    | { type: "put"; key: string; value: DatabaseValue | Freshness }
    | { type: "del"; key: string }
  >): Promise<void>;

  // Close the database connection
  close(): Promise<void>;
}
```

**Normative Requirements:**

* `put(key, value)` MUST store `value` at `key`, overwriting any existing value.
* `getValue(key)` MUST return the stored `DatabaseValue` or `undefined` if no value exists at `key`.
* `getFreshness(key)` MUST return the stored `Freshness` state (`"up-to-date"` or `"potentially-outdated"`) or `undefined` if no freshness state exists at `key`.
* `batch(ops)` MUST execute all operations atomically: either all succeed or all fail (no partial application).
* `batch(ops)` operations MUST be applied in the order specified in the `ops` array.
* `put` and `getValue` MUST round-trip values without mutation: after `put(k, v)`, `getValue(k)` MUST return a value semantically equivalent to `v`.
* `close()` MUST cleanly shut down the database connection and release resources.

**Database vs. Graph API:**

* The `Database` interface represents **raw storage** without dependency tracking or invalidation logic.
* Only `graph.set()` performs invalidation and marks dependents as `potentially-outdated`.
* Tests MAY use `database.put()` only as a seeding helper to set up initial state, but MUST use `graph.set()` for operations that should trigger dependency propagation.

**Freshness Key Convention:**

Freshness state is stored using a key derived from the node key:

```javascript
function freshnessKey(nodeKey: string): string {
  return `freshness:${nodeKey}`;
}
```

### 7) Materialization Markers (Normative Behavioral Contract)

Implementations MUST persist sufficient information to reconstruct the set of materialized nodes after a restart.

**Normative Requirements:**

* A **materialized node** is any concrete node for which the implementation maintains dependency tracking.
* If a node is materialized before a graph restart, then after restart (new `DependencyGraph` instance over the same `Database`):
  * `set(source, v)` MUST mark all previously materialized transitive dependents as `potentially-outdated`
  * This MUST occur **without** requiring re-pull of those dependents to rediscover them.
* The specific mechanism for persisting materialization markers (separate keys, metadata, reverse dependency index, etc.) is **not prescribed**.
* Tests MUST validate this property through behavioral assertions (e.g., after restart, dependent is marked `potentially-outdated` after source `set()`) and MUST NOT assert specific key formats or marker structures.

**Implementation Guidance (Non-Normative):**

Common strategies include:
* Maintaining a reverse dependency index in the database.
* Storing a materialization marker key for each instantiated node.
* Using schema hash namespacing to avoid conflicts between different graph schemas.

### 8) Observability and Test Hooks (Normative)

#### 8.1 Freshness Observability Policy

Internal freshness representation and freshness keys are **explicitly unspecified** and MUST NOT be directly asserted by conformance tests.

**Rationale:**

The specification intentionally leaves freshness encoding flexible (enum values, epochs, version numbers, etc.) to allow implementation freedom and optimization.

**Conformance Test Restrictions:**

* Tests MUST NOT assert the specific format or values of freshness keys or freshness state representations.
* Tests MAY only assert **functional behavior**: whether `pull()` returns the correct value, whether computors are invoked the expected number of times, and whether invalidation propagates correctly.

#### 8.2 Optional Debug Interface (Recommended)

To enable stronger conformance tests and easier debugging, implementations MAY provide an optional debug interface:

**Type Definition:**

```typescript
interface DependencyGraphDebug {
  // Query conceptual freshness state of a node
  debugGetFreshness(nodeName: string): Promise<
    "up-to-date" | "potentially-outdated" | "missing"
  >;

  // List all materialized nodes (canonical names)
  debugListMaterializedNodes(): Promise<string[]>;
}
```

**Normative Requirements (If Implemented):**

* `debugGetFreshness(nodeName)` MUST return the conceptual freshness state of the node:
  * `"up-to-date"` — Node is guaranteed consistent with dependencies.
  * `"potentially-outdated"` — Node may need recomputation.
  * `"missing"` — Node is not materialized (no dependency tracking exists).
* `debugListMaterializedNodes()` MUST return an array of canonical node names for all materialized nodes.
* The debug interface MUST reflect the same conceptual state that governs the graph's operational behavior (no divergence).

**Usage:**

This interface is intended for test builds and debugging only. Production code SHOULD NOT depend on it.

### 9) Error Taxonomy (Normative)

All errors thrown by the dependency graph MUST have stable, documented names (via `.name` property) or codes (via `.code` property) for reliable test assertions.

#### 9.1 `InvalidExpressionError`

**When Thrown:**

* During `makeDependencyGraph()` initialization if any `output` or `inputs` expression fails to parse.
* During `pull(nodeName)` or `set(nodeName, value)` if `nodeName` does not parse as a valid expression.

**Error Properties:**

* `name: "InvalidExpressionError"` (or equivalent stable identifier)
* `message: string` — Human-readable description
* `expression: string` — The invalid expression string

**Type Guard:**

```typescript
function isInvalidExpressionError(value): value is InvalidExpressionError;
```

#### 9.2 `NonConcreteNodeError`

**When Thrown:**

* During `pull(nodeName)` or `set(nodeName, value)` if `nodeName` contains free variables (is not a concrete expression).

**Error Properties:**

* `name: "NonConcreteNodeError"` (or equivalent: `"SchemaPatternNotAllowed"`)
* `message: string` — Human-readable description
* `pattern: string` — The non-concrete expression string

**Type Guard:**

```typescript
function isNonConcreteNodeError(value): value is NonConcreteNodeError;
```

**Alternative Names:**

Implementations MAY use the name `SchemaPatternNotAllowed` instead of `NonConcreteNodeError`. Both names refer to the same error condition and are acceptable for conformance as long as the choice is documented and stable.

#### 9.3 `InvalidNodeError`

**When Thrown:**

* During `pull(nodeName)` if no schema matches the concrete node.

**Error Properties:**

* `name: "InvalidNodeError"` (or equivalent: `"InvalidNode"`)
* `message: string` — Human-readable description
* `nodeName: string` — The canonical node name that was not found

**Type Guard:**

```typescript
function isInvalidNodeError(value): value is InvalidNodeError;
```

#### 9.4 `InvalidSetError`

**When Thrown:**

* During `set(nodeName, value)` if `nodeName` is not a source node.

**Error Properties:**

* `name: "InvalidSetError"`
* `message: string` — Human-readable description
* `nodeName: string` — The canonical node name that is not a source

**Type Guard:**

```typescript
function isInvalidSetError(value): value is InvalidSetError;
```

#### 9.5 `SchemaOverlapError`

**When Thrown:**

* During `makeDependencyGraph()` initialization if two or more schemas have overlapping `output` patterns.

**Error Properties:**

* `name: "SchemaOverlapError"`
* `message: string` — Human-readable description listing the overlapping patterns
* `patterns: string[]` — The overlapping canonical output patterns

**Type Guard:**

```typescript
function isSchemaOverlapError(value): value is SchemaOverlapError;
```

#### 9.6 `InvalidSchemaError`

**When Thrown:**

* During `makeDependencyGraph()` initialization if variable scope rules are violated or other schema definition problems occur (excluding overlaps and cycles, which have dedicated errors).

**Error Properties:**

* `name: "InvalidSchemaError"` (or equivalent: `"InvalidSchema"`)
* `message: string` — Human-readable description
* `schemaOutput: string` — The problematic schema output pattern

**Type Guard:**

```typescript
function isInvalidSchemaError(value): value is InvalidSchemaError;
```

#### 9.7 `SchemaCycleError`

**When Thrown:**

* During `makeDependencyGraph()` initialization if the schema structure forms a cycle.

**Error Properties:**

* `name: "SchemaCycleError"`
* `message: string` — Human-readable description including the cycle
* `cycle: string[]` — The nodes involved in the cycle (canonical names)

**Type Guard:**

```typescript
function isSchemaCycleError(value): value is SchemaCycleError;
```

#### 9.8 `MissingValueError`

**When Thrown:**

* During `pull(nodeName)` if a node is marked `up-to-date` but has no stored value (indicates database corruption or implementation bug).

**Error Properties:**

* `name: "MissingValueError"`
* `message: string` — Human-readable description
* `nodeName: string` — The canonical node name with missing value

**Type Guard:**

```typescript
function isMissingValueError(value): value is MissingValueError;
```

#### 9.9 Error Timing

Errors MUST be thrown at specific, predictable times:

| Error | Timing |
|-------|--------|
| `InvalidExpressionError` | Initialization (schema parsing) OR runtime (`pull`/`set` with invalid input) |
| `NonConcreteNodeError` | Runtime (`pull`/`set` with free variables) |
| `InvalidNodeError` | Runtime (`pull` on unknown node) |
| `InvalidSetError` | Runtime (`set` on non-source node) |
| `SchemaOverlapError` | Initialization (schema validation) |
| `InvalidSchemaError` | Initialization (schema validation) |
| `SchemaCycleError` | Initialization (schema validation) |
| `MissingValueError` | Runtime (`pull` detects corruption) |

### 10) Conformance Summary

An implementation conforms to this specification if and only if:

1. It provides all types, interfaces, and functions defined in this section with matching signatures and semantics.
2. It throws the documented errors with stable names/codes at the specified times.
3. It enforces all MUST requirements and respects all MUST NOT prohibitions.
4. It produces results consistent with the big-step semantics and correctness properties (P1-P4).
5. It passes all conformance tests derived from this specification.

Implementations MAY provide additional features (debug interfaces, performance optimizations, extended error information) as long as they do not violate the normative requirements or change observable behavior defined in this specification.
