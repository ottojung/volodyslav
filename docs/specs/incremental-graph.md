# Specification for the Incremental Graph

This document provides a formal specification for the incremental graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

**TERM-01 (NodeName):** An `ident` string (see §1.3; the functor), e.g., `"full_event"` or `"all_events"`. Used in public API calls to identify node families. Does not include variable syntax or arity suffix.

**TERM-02 (SchemaPattern):** An expression string that may contain variables, e.g., `"full_event(e)"` or `"all_events"`. Used only in schema definitions to denote families of nodes and for variable mapping.

**TERM-03 (SimpleValue):** A value type defined recursively as: `number | string | boolean | Array<SimpleValue> | Record<string, SimpleValue>`. Two `SimpleValue` objects are equal iff `isEqual` returns `true` for them (see DEF-EQUAL-01). Excludes `undefined`, `null`, functions, and symbols.

**TERM-04 (ConstValue):** A subtype of `SimpleValue`.

**TERM-05 (ComputedValue):** A subtype of `SimpleValue`.

**TERM-06 (BindingEnvironment):** A positional array of concrete values: `Array<ConstValue>`. Used to instantiate a specific node from a family. Bindings are matched to argument positions by position, not by name.

**REQ-BINDING-00 (Well-formed Bindings):** The length of a `BindingEnvironment` array MUST match the arity of the node it is used with.

**TERM-07 (NodeInstance):** A specific node identified by a `NodeName` and `BindingEnvironment`. Conceptually: `{ nodeName: NodeName, bindings: BindingEnvironment }`. Notation: `nodeName@bindings`.

**TERM-08 (NodeKey):** A string key used for storage, derived from `(nodeName, bindings)`.

**TERM-09 (NodeValue):** Computed value at a node (always a `ComputedValue`). The term `NodeValue` is an alias for `ComputedValue` in the context of stored node values.

**TERM-10 (Freshness):** Conceptual state: `"up-to-date" | "potentially-outdated"`.

**REQ-MAT-CLOSURE:** Materialized nodes form a dependency-closed set. For every materialized node N, every concrete input of N is materialized. Consequently, materializing N materializes its complete transitive dependency cone first, and removing any materialization requires removing all of its materialized transitive dependents.

A materialization persists across restarts unless an explicit closure-preserving migration or synchronization operation removes it. Stale does not mean structurally incomplete: a potentially-outdated node may lack validity proofs, but it still has every concrete input materialized.


**TERM-11 (Computor):** Async function: `(inputs: Array<ComputedValue>, oldValue: ComputedValue | undefined, bindings: Array<ConstValue>) => Promise<ComputedValue | Unchanged>`.

**DEF-OUTCOMES-01 (Outcomes Set):** For any schema node definition and arguments `(inputs, oldValue, bindings)`, `Outcomes(nodeName, bindings, inputs, oldValue) ⊆ ComputedValue` (equivalently `Outcomes(NodeInstance, inputs, oldValue)`) represents the set of all semantic values that could be produced by the computor in any permitted execution context. This set may be infinite. `Unchanged` is not part of `Outcomes`—it is an optimization sentinel only. `NodeKey` may be used as a storage key derived from the node instance, but it is not a semantic argument to `Outcomes`.

**DEF-COMP-INVOKE-01 (Computor Invocation):** When the operational semantics "invokes a computor", it nondeterministically selects `r ∈ Outcomes(...)` and treats `r` as the returned value of the Promise. In implementation, this corresponds to executing the computor function, which may produce different results on different invocations for nondeterministic computors.

**TERM-12 (Unchanged):** Unique sentinel value indicating unchanged computation result. This is an optimization-only mechanism: when a computor returns `Unchanged`, the runtime stores the previous value without rewriting it. `Unchanged` does not expand the set of valid semantic results—it is only a shortcut for returning the existing value when that value is semantically admissible for the current inputs.

**REQ-UNCH-00 (Unchanged Validity):** `Unchanged` MUST NOT be a valid `ComputedValue` and cannot be returned by `pull()`.

**TERM-13 (Variable):** Parameter placeholder in node schemas (identifiers in argument positions). Variables are internal to schema definitions and not exposed in public API.

### 1.2 Expressions as an Infinite Graph (Normative)

This section establishes the fundamental mental model for understanding how expressions denote infinite families of nodes and how the incremental graph operates over this infinite space using a finite schema.

#### 1.2.1 Expressions Denote Node Families

An **expression** is a symbolic template that denotes a (possibly infinite) family of nodes. The expression defines the structure, while variable bindings select a specific member of that family.

**Components:**
* The **functor** of an expression is its identifier—the name that categorizes the family.
* The **arguments** are variable positions that can be assigned concrete `ConstValue` instances at runtime.

**Examples:**

* `all_events` — An atom expression with no variables. Denotes exactly one node (a family of size 1).
* `full_event(e)` — Denotes the infinite family `{ full_event(e=v) | v ∈ ConstValue }`.
  - Each distinct `ConstValue` for `e` identifies a different member of this family.
* `enhanced_event(e, p)` — Denotes `{ enhanced_event(e=v₁, p=v₂) | v₁, v₂ ∈ ConstValue }`.
  - The Cartesian product of all possible values for `e` and `p` forms this family.

#### 1.2.2 Node Instances (Addresses Within Families)

A **node instance** is a specific member of a node family. As defined in §1.1, node instances are identified by `(nodeName, bindings)` where:
* `nodeName` is the functor (e.g., `"full_event"`)
* `bindings` is a `BindingEnvironment` (positional array of `ConstValue` instances)

**Schema-side notation:** In the context of schema definitions, we may write `expr@B` to denote a node instance where `expr` is an expression pattern (e.g., `full_event(e)`) and `B` is the binding environment. This notation is explanatory: `expr@B` denotes the same node instance as `functor(expr)@B`. This is not a separate addressing mechanism—public API addressing always uses `(nodeName, bindings)` as specified in §1.2.5. In a well-formed schema, each functor corresponds to exactly one arity.

**Examples:**

* `full_event(e)` with `B = [{id: "evt_123"}]` identifies the node instance `"full_event"@[{id: "evt_123"}]`.
* `enhanced_event(e, p)` with `B = [{id: "evt_123"}, {id: "photo_456"}]` identifies the node instance `"enhanced_event"@[{id: "evt_123"}, {id: "photo_456"}]`.

**Identity is defined in §1.2.5.**

#### 1.2.3 Schema as a Template for Infinite Edges

A **schema** defines the dependency structure between node families, not between individual nodes.

When a schema declares:
```javascript
{
  output: "full_event(e)",
  inputs: ["event_data(e)", "metadata(e)"],
  computor: async ([data, meta], old, bindings) => ({ ...data, ...meta })
}
```

This means: **For every binding environment B** (a `Array<ConstValue>` of length 1), the node instance `full_event(e)@B` depends on:
* `event_data(e)@B` (same positional bindings)
* `metadata(e)@B` (same positional bindings)

The schema implicitly defines infinitely many dependency edges—one set for each possible binding environment.

#### 1.2.4 Public Interface: Addressing Nodes

The public API requires both the `nodeName` (functor) and bindings to address a specific node:

* `pull(nodeName, bindings)` — Evaluates the node instance identified by `NodeName` and `BindingEnvironment`
* `invalidate(nodeName, bindings)` — Marks the node instance as potentially-outdated, triggering recomputation on next pull

**For arity-0 nodes** (nodes with no arguments like `all_events`):
* `pull("all_events", [])` and `pull("all_events")` are equivalent

**For arity > 0 nodes**:
* `pull("full_event", [{id: "123"}])` and `pull("full_event", [{id: "456"}])` address distinct nodes

**REQ-ARGS-01 (Bindings Normalization):** If `bindings` is omitted or `undefined`, treat it as `[]`. If the schema arity is not 0, the runtime MUST throw an `ArityMismatchError`.

**See §1.2.5 for complete addressing and identity rules.**

#### 1.2.5 Node Addressing and Identity (Normative)

This subsection consolidates the rules for how node instances are addressed and identified.

**Addressing:** A node instance is addressed in the public API by `(nodeName, bindings)`:
* `nodeName` is an `ident` identifier (the functor) without variable syntax or arity suffix
* `bindings` is a positional array of `ConstValue` instances

**Arity Source of Truth:** The schema is the **single source of truth** for the arity of each `nodeName`:
* Each `nodeName` (functor) has exactly one arity across all schema outputs (enforced by REQ-MATCH-02)
* The arity is determined by the number of variables in the schema's output pattern
* `bindings.length` equals the schema-defined arity (otherwise `ArityMismatchError` per REQ-PULL-02, REQ-INV-03)

**Arity-0 Equivalence:** For arity-0 nodes:
* `ident` and `ident()` in schema patterns are equivalent
* `pull("nodeName", [])` and `pull("nodeName")` are equivalent (REQ-ARGS-01)

**Variable Names:** Variable names in schema patterns DO NOT affect node identity or matching.

### 1.3 Expression Grammar (Normative)

**REQ-EXPR-01:** All expressions MUST conform to this grammar:

```
expr          := ws atom_expr ws | ws compound_expr ws
atom_expr     := ident
compound_expr := ident ws "(" ws args ws ")"

args          := "" | arg (ws "," ws arg)*
arg           := var
var           := ident
ident         := [A-Za-z_][A-Za-z0-9_]*
ws            := [ \t\n\r]*
```

**REQ-EXPR-02 (Arity-0 Equivalence):** For arity-0 expressions, `ident` and `ident()` MUST be treated as semantically equivalent.

### 1.5 Deep Equality (Normative)

**DEF-EQUAL-01 (Deep Equality):** The function `isEqual` defines deep equality for `SimpleValue` instances.

### 1.6 NodeKey Format (Normative)

**DEF-KEY-01** A NodeKey is a string that uniquely identifies a `NodeInstance` in storage.

### 1.7 Schema Definition (Normative)

**REQ-SCHEMA-01:** A incremental graph is defined by a set of node schemas.

**REQ-SCHEMA-02:** Variables in `output` MUST be a superset of all variables in `inputs` (Variable Scope Rule 1).

**TERM (source node):** A **source node** is any node instance matching a schema where `inputs = []`.

**REQ-SCHEMA-03:** All variable names within an expression MUST be unique.

### 1.8 Variable Name Mapping and Positional Bindings (Normative)

**REQ-BINDING-01:** When instantiating input pattern dependencies, match variables by name and derive positional bindings from the output binding environment.

### 1.9 Pattern Matching (Normative)

**DEF-MATCH-01 (Pattern Matching):** A schema output pattern `P` matches a nodeName `N` if and only if they have the same functor.

**REQ-MATCH-01 (Duplicate Functor Rejection):** Duplicate output functors are rejected.

**REQ-MATCH-02 (Unique Arity):** Each functor MUST have a single, unique arity across all schema outputs.

### 1.10 Cycle Detection (Normative)

**REQ-CYCLE-01 (Acyclic Schema):** The system MUST reject schemas with cycles at initialization.

### 1.11 Materialization (Normative)

**REQ-MAT-01 (Materialization Triggers):** Materialization occurs through `pull()`.

**REQ-MAT-02 (Persistent Materialization):** Once materialized, a node instance MUST remain materialized across restarts.

---

## 2. Operational Semantics (Normative)

### 2.1 pull(nodeName, bindings) → NodeValue

**REQ-PULL-01:** `pull` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-PULL-02:** `pull` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema for the given nodeName.

**REQ-PULL-03:** `pull` MUST ensure each computor is invoked at most once per top-level call for each unique node instance.

**REQ-PULL-04 (No spurious recomputation):** If a materialized node instance is `up-to-date` at the time it is encountered during a `pull()`, the implementation MUST return its stored value and MUST NOT invoke its computor.

### 2.2 invalidate(nodeName, bindings)

**REQ-INV-01:** `invalidate` MUST return a `Promise<void>`.

**REQ-INV-02:** `invalidate` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-INV-03:** `invalidate` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema.

**REQ-INV-04:** Only dependents that have been previously materialized are marked outdated.

---

## 3. Required Interfaces (Normative)

### 3.2 IncrementalGraph Interface

**REQ-IFACE-05 (Timestamp API):** Implementations MUST record timestamps for each node instance when its value is first set or changed.

**REQ-IFACE-06 (getCreationTime):** `getCreationTime(nodeName, bindings?)` MUST return the `DateTime` at which the node instance was first given a value.

**REQ-IFACE-07 (getModificationTime):** `getModificationTime(nodeName, bindings?)` MUST return the `DateTime` at which the node instance's stored semantic value last changed.

**REQ-IFACE-08 (Timestamp Invariants):**
* `getCreationTime(N, B) <= getModificationTime(N, B)` for any materialized node instance `N@B`.
* `getCreationTime(N, B)` MUST NOT advance. It may move earlier only when synchronization learns an earlier creation of the same semantic node instance; synchronization merges `createdAt` as the minimum represented creation time for that NodeKey.
* `getModificationTime(N, B)` is a version timestamp for the stored semantic value.
* A **new timestamp record** is created when a semantic value is first stored for a node (including migration `create` and the node's initial computation). `createdAt` and `modifiedAt` are both set to the current time at this point.
* An existing `modifiedAt` **advances** only when a computor produces a changed value that replaces the previous stored value. `modifiedAt` MUST NOT advance in any other circumstance.
* Synchronization which adopts another replica's value occurrence copies that occurrence's existing `modifiedAt` together with its payload, merges `createdAt` by minimum across the receiver and source representations of the same NodeKey, and MUST NOT substitute merge execution time or another manufactured timestamp. Minimum is idempotent, commutative, and associative, so `createdAt` converges without Journal authority. It never advances, and because every represented creation time is no later than the corresponding represented modification time, the merged `createdAt` remains no later than the selected occurrence's `modifiedAt`.
* `modifiedAt` MUST NOT change when a node becomes stale, when invalidation propagates, when validity flags change, when a computor returns `Unchanged`, when synchronization keeps the same value occurrence, during identifier reconciliation, or merely because freshness changes.
* Migration invalidation follows the same invariant: invalidation of a cached node does not change `modifiedAt`.

### 3.5 Error Taxonomy

**REQ-ERR-00 (Error Properties):** All errors MUST provide a stable `.name` property and the required fields specified by this specification.

---

## 4. Persistence (Normative)

### 4.1 Behavioral Equivalence Across Restarts

**REQ-PERSIST-01 (Observable Equivalence):** Given the same `RootDatabase` and schema, the observable behavior of the incremental graph MUST be identical whether or not a shutdown/restart occurred between any two operations.

### 4.2 Invariants

**INV-01 (Outdated Downstream):** If node instance `N@B` is `potentially-outdated`, all transitive dependents of `N@B` that have been previously materialized are also `potentially-outdated`.

**INV-02 (Up-to-Date Upstream):** If node instance `N@B` is `up-to-date`, all transitive dependencies of `N@B` are also `up-to-date`.

### 4.3 Correctness Properties

**PROP-01 (Soundness under nondeterminism):** A returned pull value must be permitted by the nondeterministic big-step semantics.

**PROP-02 (Progress):** Every `pull(N, B)` call terminates assuming computors terminate.

**PROP-03 (Single Invocation):** Each computor is invoked at most once per top-level `pull()` for each unique node instance.

**PROP-04 (Freshness Preservation):** After `pull(N, B)`, the node instance `N@B` and all transitive dependencies are `up-to-date`.

---

## 5. Concurrency (Normative)

**REQ-CONCUR-01 (Sequential Consistency):** All `pull()` and `invalidate()` operations MUST behave as if they were executed in some sequential order, even when invoked concurrently.

**REQ-CONCUR-02:** The observable state of the graph MUST be consistent with some sequential execution at all times.

### 5.1 Locking Model

The implementation uses mode mutexes. A mode mutex allows multiple callers in the same mode to proceed concurrently while callers in different modes are mutually exclusive.

| Mode | Description |
|------|-------------|
| `daytime` | Non-`pull` graph operations. |
| `nighttime` | Recomputation operations. |
| `holiday` | Lifecycle operations. Blocks all other modes. |

**REQ-CONCUR-05 (Mode acquisition fairness):** A waiting acquirer of one mode MUST NOT be indefinitely overtaken by repeated acquirers of another mode. Once an incompatible mode is waiting, admission of new callers in the currently active mode must eventually stop; after existing holders drain, a waiting incompatible-mode acquirer must be allowed to proceed at the next mode boundary. This requirement does not impose FIFO ordering within one mode.

### 5.2 Locking Properties per Method

`pull()` uses `nighttime`; ordinary inspection and invalidation use `daytime`; lifecycle operations use `holiday`.

**REQ-CONCUR-03 (Read-only Safety):** Read-only methods MUST NOT modify stored graph state.

**REQ-CONCUR-04 (Daytime-mode Atomicity):** A `daytime`-mode method MUST NOT observe a partial write from a concurrent `pull()`.

---
