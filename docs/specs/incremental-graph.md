# Incremental Graph Specification

This specification defines the semantics, implementation constraints, and observable interfaces for an incremental computation graph system.

The document is organized in five parts, each building on the previous:

1. **Part I** establishes pure dataflow semantics without any caching or persistence
2. **Part II** adds incrementality through materialization and freshness tracking  
3. **Part III** describes optimization mechanisms that preserve Part II semantics
4. **Part IV** defines persistence contracts for restart resilience
5. **Part V** specifies the JavaScript API and test surface

---

## Part I — Dataflow Core

This part defines the abstract semantics of computation: what values mean and how they relate to each other. It deliberately excludes all mention of caching, freshness, persistence, or implementation details.

### 1.1 Foundational Concepts

#### Node Families and Node Instances

A **node family** is identified by a **functor** (an identifier like `all_events` or `full_event`) and an **arity** (the number of parameter positions). A family with arity `n` represents a conceptually infinite set of computation points, one for each possible combination of `n` argument values.

A **node instance** is a specific member of a family, pinpointed by providing concrete values for all parameter positions. We denote this as `functor@bindings` where `bindings` is a positional array of values.

**Examples:**
- Family `all_events` with arity 0 contains exactly one instance: `all_events@[]`
- Family `event_data` with arity 1 contains infinitely many instances: `event_data@[{id:"e1"}]`, `event_data@[{id:"e2"}]`, etc.
- Family `join` with arity 2 contains instances like `join@[{id:"e1"}, {id:"p1"}]`

#### Binding Environment

A **binding environment** is a positional array of concrete values (type: `Array<ConstValue>`). Its length must equal the arity of the node family. Position 0 holds the value for the first parameter, position 1 for the second, and so on.

The type `ConstValue` is a subtype of `Serializable`, defined recursively as:  
`number | string | null | boolean | Array<Serializable> | Record<string, Serializable>`

**Identity principle:** Two node instances are identical if and only if they have the same functor, same arity, and structurally equal binding environments (compared position by position).

### 1.2 Expressions and Patterns

An **expression** is a textual notation that describes a node family. Expressions appear in schema definitions to declare computation structure.

#### Expression Grammar

```
expression    := atom | compound
atom          := identifier
compound      := identifier "(" arguments ")"
arguments     := ε | variable ("," variable)*
variable      := identifier
identifier    := [A-Za-z_][A-Za-z0-9_]*
```

Whitespace is allowed and ignored. An atom-expression (no parentheses) and a compound-expression with zero arguments (empty parentheses) denote the same family: both have arity 0.

**REQ-EXPR-01:** All expressions must conform to this grammar.

**REQ-EXPR-02:** For arity-0 families, `identifier` and `identifier()` must be treated as semantically identical.

**Examples:**
- `all_events` — atom, arity 0
- `all_events()` — compound with zero variables, arity 0, equivalent to above
- `event_data(e)` — compound, arity 1, variable `e` at position 0
- `join(x, y)` — compound, arity 2, variables `x` at position 0 and `y` at position 1

#### Canonicalization

The **canonical form** of an expression is its functor alone: the identifier before any parentheses, with whitespace removed.

**REQ-CANON-01:** `canonicalize(expr)` extracts the functor.

**Examples:**
- `"all_events"` → `"all_events"`
- `"event_data(e)"` → `"event_data"`
- `"event_data(x)"` → `"event_data"` (same as above; variable names are syntactic only)
- `"  join  ( a, b )  "` → `"join"`

Variable names serve documentation and variable-correspondence purposes in schemas but do not affect identity or canonicalization.

**REQ-CANON-02:** Schema pattern matching uses canonical form for O(1) lookup by functor.

### 1.3 Schema Structure

A **schema** is a finite set of **node definitions**, each declaring:

```javascript
{
  output: <expression>,       // defines the node family being computed
  inputs: [<expression>, ...], // dependency families
  computor: <function>,        // computation logic
  isDeterministic: <boolean>,  // true if outcome is unique for given inputs
  hasSideEffects: <boolean>    // true if computor performs actions beyond return value
}
```

The `output` expression declares a node family. The `inputs` array declares dependency families. Each input expression's variables must be a subset of the output expression's variables (by name).

**REQ-SCHEMA-01:** Every node definition must have all five fields.

**REQ-SCHEMA-02:** Variables appearing in any input expression must also appear in the output expression (Variable Scope Rule).

**REQ-SCHEMA-03:** All variable names within a single expression must be unique. Expressions like `f(a, b, a)` are invalid.

**REQ-SCHEMA-04:** The `isDeterministic` and `hasSideEffects` fields are semantic declarations about computor behavior. They are not persisted to storage; they guide correctness reasoning.

#### Schema Validation Rules

**REQ-SCHEMA-05 (Uniqueness):** No two node definitions may have output patterns that canonicalize to the same functor with the same arity. This ensures each node family has exactly one definition.

**REQ-SCHEMA-06 (Arity Consistency):** If multiple patterns share the same functor, they must all have the same arity. A functor cannot simultaneously represent families of different arities.

**REQ-SCHEMA-07 (Acyclicity):** Define a directed graph where each node is a schema definition. Draw an edge from definition A to definition B if some input of A matches the output of B (same functor and arity). This graph must be acyclic.

Violations of these rules must cause initialization-time errors: `SchemaOverlapError`, `SchemaArityConflictError`, and `SchemaCycleError` respectively.

### 1.4 Variable Correspondence and Binding Propagation

When a node instance is evaluated, its binding environment determines the binding environments of its dependencies through **variable correspondence by name**.

**Principle:** The output expression defines a namespace of variable names. Each input expression's variables are matched to this namespace by name, and the corresponding positional values are extracted to form the input's binding environment.

**Example:**

```javascript
{
  output: "enhanced(e, p)",     // position 0 = e, position 1 = p
  inputs: ["event(e)", "photo(p)"],
  ...
}
```

When evaluating `enhanced@[V_e, V_p]`:
- Input `event(e)`: variable `e` at output position 0 → binding environment `[V_e]`
- Input `photo(p)`: variable `p` at output position 1 → binding environment `[V_p]`

**REQ-BINDING-01:** Binding propagation from outputs to inputs proceeds by:
1. Identify each variable in the input expression
2. Find that variable's position in the output expression
3. Extract the value at that position from the output's binding environment
4. Assemble these values positionally to form the input's binding environment

**REQ-BINDING-02:** Variable names are schema-internal only. They do not affect identity of individual expressions.

### 1.5 Computors and Outcome Sets

A **computor** is an async function with signature:

```javascript
(inputs: Array<ComputedValue>, 
 oldValue: ComputedValue | undefined, 
 bindings: Array<ConstValue>) 
  => Promise<ComputedValue | Unchanged>
```

Where `ComputedValue` is a subtype of `Serializable` excluding `null`.

The `inputs` array contains the values of all dependencies, in the order listed in the schema's `inputs` field.

The `oldValue` parameter represents the previously computed value at this node instance, if any. It may be `undefined` for first-time evaluations.

The `bindings` parameter is the full binding environment for this node instance (the output's bindings, not sliced per-input).

#### Outcome Set Model (Spec-Only Abstraction)

For any node definition `D` and arguments `(inputs_vals, old_val, bind_vals)`, define:

**Outcomes(D, inputs_vals, old_val, bind_vals)** ⊆ ComputedValue

This is the set of all **semantically valid** values the computor may produce. For deterministic computors (`isDeterministic: true`), this set contains exactly one element. For nondeterministic computors, it may contain multiple elements or depend on external factors not modeled in the signature.

The outcome set is a specification device: it describes what values are correct, not how to compute them. Implementations do not enumerate outcome sets; they execute computors and observe results.

**Treatment of Side Effects and Nondeterminism:**

When `hasSideEffects: true`, the computor may perform actions beyond computing a return value (e.g., logging, network requests, state updates). This specification treats side effects as a form of nondeterminism: they contribute to the variation in possible computor results but are not separately tracked or guaranteed. The only observable contract is the returned value.

When `hasSideEffects: false` and `isDeterminism: true`, the computor is a pure function, and stronger equivalence properties hold (see Part II).

**REQ-COMP-01:** Computors must return a `Promise` resolving to either a `ComputedValue` or the special sentinel `Unchanged` (discussed in Part III).

### 1.6 Baseline Evaluation Semantics

This section defines the **abstract meaning** of computation using a big-step evaluation rule. This baseline intentionally ignores all optimization concerns such as caching, memoization, and freshness tracking.

#### Big-Step Rule: eval(node_instance) → value

Given a node instance `F@B` (functor F, bindings B):

1. **Lookup schema:** Find the unique node definition `D` whose output pattern has functor `F` and arity matching `|B|`.
2. **Evaluate dependencies:** For each input pattern `I` in `D.inputs`:
   - Compute the binding environment `B_I` for input `I` using variable correspondence with `B`
   - Recursively evaluate `eval(I_functor @ B_I)` to obtain value `v_I`
   - Collect all dependency values in order: `inputs_vals = [v_0, v_1, ...]`
3. **Retrieve prior value:** Let `old_val` be the previously computed value at `F@B`, or `undefined` if this is the first evaluation.
4. **Select outcome:** Nondeterministically choose `result ∈ Outcomes(D, inputs_vals, old_val, B)`.
5. **Handle Unchanged (see Part III):** If `result` is the special sentinel `Unchanged`, set `new_val = old_val`. Otherwise set `new_val = result`.
6. **Store and return:** Record `new_val` as the value at `F@B` and return `new_val`.

**Important:** This pseudocode describes input-output behavior only. It does not specify any caching strategy, does not track freshness, and does not mandate "do not recompute if cached." Those constraints appear in Part II as **refinements** of this baseline.

The notation "nondeterministically choose" models both true nondeterminism (random values) and hidden dependencies (external state, time, etc.). Implementations execute the computor function, which may produce different results across invocations for nondeterministic computors.

**Source Nodes:**

A node definition with `inputs: []` is called a **source node**. Its computor receives an empty `inputs` array and is responsible for obtaining values from external state, user input, or initial conditions.

**REQ-EVAL-01:** For any acyclic schema and any node instance, evaluation must terminate (assuming all computors terminate).

**REQ-EVAL-02:** The result of evaluating a node instance is always a `ComputedValue` (never `undefined`, never the sentinel `Unchanged`).

---

## Part II — Incremental Evaluation

This part introduces state tracking and defines how the system avoids redundant computation while preserving the semantics from Part I.

### 2.1 Materialization

A node instance becomes **materialized** when the system records its existence in persistent state. Materialized nodes have:
- A stored value
- A freshness marker
- Dependency and dependent relationships tracked for invalidation propagation

**REQ-MAT-01:** Only materialized node instances participate in freshness tracking and invalidation propagation.

**REQ-MAT-02:** A node instance becomes materialized when:
- It is evaluated by a top-level request (see §2.2), or
- It is explicitly marked via an invalidation operation (see §2.3).

**REQ-MAT-03:** Unmaterialized node instances have no stored state. They may be computed as needed during evaluation but are not tracked.

### 2.2 Freshness and the Incremental pull Operation

Each materialized node instance has a **freshness state**: either `up-to-date` or `potentially-outdated`.

An **up-to-date** node instance has a stored value that is known to be consistent with its current dependencies. The system must not re-invoke its computor.

A **potentially-outdated** node instance may have a stale value. Its computor must be invoked on the next access.

#### pull Operation

The **pull** operation is the incremental refinement of the baseline evaluation from Part I. It accepts a functor and binding environment, evaluates the corresponding node instance, and returns a `ComputedValue`.

**Signature:** `pull(functor: string, bindings: Array<ConstValue>) → Promise<ComputedValue>`

**REQ-PULL-01:** If no schema output pattern has the given functor, throw `InvalidNodeError`.

**REQ-PULL-02:** If the length of `bindings` does not match the arity of the schema pattern with the given functor, throw `ArityMismatchError`.

**REQ-PULL-03:** The return value must always be a `ComputedValue` (never `undefined`, never `Unchanged`).

**Incremental Evaluation Strategy:**

When `pull(F, B)` is called:

1. **Lookup and validate:** Ensure schema pattern exists with functor `F` and arity `|B|`.
2. **Check freshness:** If node instance `F@B` is materialized and `up-to-date`, return its stored value immediately. Do **not** invoke its computor.
3. **Recompute if needed:** If `F@B` is unmaterialized or `potentially-outdated`:
   - Recursively pull all dependencies (which may themselves recompute if outdated)
   - Invoke the computor with the dependency values, the old stored value (or `undefined`), and `B`
   - Handle the computor's result (possibly `Unchanged`, see Part III)
   - Store the resulting value
   - Mark `F@B` as `up-to-date`
4. **Materialize and track:** Ensure `F@B` is materialized (record dependencies for future invalidation propagation).

**REQ-PULL-04 (Single Invocation per Call):** Within a single top-level `pull` request, each unique node instance's computor must be invoked at most once. This requires tracking in-flight evaluations or using memoization.

**REQ-PULL-05 (No Spurious Recomputation):** An up-to-date materialized node instance must return its stored value without invoking its computor. This is not merely an optimization—it is a mandatory constraint to prevent repeated side effects and resampling of nondeterministic computors.

**Correctness Property P1′ (Soundness Under Nondeterminism):**

For any `pull(F, B)` that returns value `v`, there must exist a valid execution trace of the baseline evaluation (Part I) that produces `v`. In other words, `v` must be consistent with some nondeterministic choice sequence from the `Outcomes` sets of all involved computors.

**Property P1-det (Deterministic Specialization, Corollary):**

If all computors reachable from `F@B` have `isDeterministic: true` and `hasSideEffects: false`, then `pull(F, B)` produces the same result as recomputing the entire dependency subtree from scratch with the same input values. This recovers traditional semantic equivalence for the pure deterministic subset.

**Correctness Property P2 (Progress):**

Every `pull` call terminates, assuming all computors terminate and the schema is acyclic.

**Correctness Property P3 (Single Invocation):**

See REQ-PULL-04. Each node instance's computor is invoked at most once per top-level `pull`.

**Correctness Property P4 (Freshness Preservation):**

After `pull(F, B)` completes, `F@B` and all its transitive dependencies are marked `up-to-date`.

### 2.3 Invalidation

The **invalidate** operation marks a node instance and all its materialized transitive dependents as `potentially-outdated`. This forces recomputation on the next `pull`.

**Signature:** `invalidate(functor: string, bindings: Array<ConstValue>) → Promise<void>`

**REQ-INV-01:** If no schema output pattern has the given functor, throw `InvalidNodeError`.

**REQ-INV-02:** If the length of `bindings` does not match the arity of the schema pattern, throw `ArityMismatchError`.

**REQ-INV-03:** `invalidate` does not write or compute values. It only updates freshness markers.

**Propagation Semantics:**

When `invalidate(F, B)` is called:

1. **Materialize target:** Ensure node instance `F@B` is materialized (even if it has never been pulled). Record sufficient state for persistence (see Part IV).
2. **Mark outdated:** Set freshness of `F@B` to `potentially-outdated`.
3. **Propagate to dependents:** For every materialized node instance `D@B_D` that transitively depends on `F@B`, mark it `potentially-outdated`.
4. **Atomicity:** All freshness updates must occur atomically (in a single batch operation). Either all succeed or none succeed.

**REQ-INV-04:** Only materialized dependents are marked outdated. Unmaterialized node instances remain unmaterialized (no transitive materialization).

**REQ-INV-05:** Invalidation applies to any node instance, whether source or derived. There is no restriction.

**REQ-INV-06 (Atomicity):** All state updates during a single `invalidate` call must be executed atomically.

### 2.4 Invariants

The system must maintain these invariants for all materialized node instances:

**Invariant I1 (Outdated Propagation):**

If materialized node instance `N@B` is `potentially-outdated`, then every materialized node instance that transitively depends on `N@B` is also `potentially-outdated`.

**Invariant I2 (Up-to-Date Upstream):**

If materialized node instance `N@B` is `up-to-date`, then every materialized node instance that `N@B` transitively depends on is also `up-to-date`.

**Invariant I3′ (Value Admissibility):**

If materialized node instance `N@B` is `up-to-date` with stored value `v`, then there exists some `oldValue` (possibly `undefined`) such that:

`v ∈ Outcomes(schema(N), inputs_values, oldValue, B)`

where `inputs_values` are the current stored values of `N@B`'s instantiated dependencies.

This invariant uses existential quantification over `oldValue` to avoid requiring storage of historical values. The stored value must be consistent with the computor's outcome set for current inputs and some prior value.

---

## Part III — Optimization Layer: Unchanged

This part describes optimization mechanisms that reduce storage operations and propagation work while preserving the semantics and constraints from Parts I and II.

### 3.1 The Unchanged Sentinel

**Unchanged** is a unique sentinel value distinct from all `ComputedValue` instances. Computors may return it to indicate "the result is the same as the prior value."

**REQ-UNCH-01:** `Unchanged` is **not** part of the `Outcomes` set. It is an optimization mechanism only.

**REQ-UNCH-02:** When a computor returns `Unchanged`:
- The node instance's stored value must not be updated (it retains its existing `ComputedValue`)
- The node instance must be marked `up-to-date`
- The sentinel itself must never be stored or exposed to callers

**REQ-UNCH-03:** `Unchanged` may only be returned when `oldValue` (the second parameter to the computor) is not `undefined`. If a computor returns `Unchanged` when `oldValue` is `undefined`, the implementation may throw `InvalidUnchangedError`.

**REQ-UNCH-04:** From the perspective of callers, a computor returning `Unchanged` is semantically equivalent to returning the current stored value. `pull` always returns a `ComputedValue`, never `Unchanged`.

**Semantic Equivalence:**

```javascript
// These two behaviors are indistinguishable to callers:
// (1) computor returns Unchanged → system keeps old_val
// (2) computor returns old_val → system stores old_val
```

### 3.2 Propagation Optimizations

**REQ-UNCH-05:** When a node instance `N@B` is recomputed and returns `Unchanged`, implementations **may** (but are not required to) mark some or all of its materialized dependents as `up-to-date` without recomputing them, **if and only if** it can be proven that their values would remain unchanged.

This optimization is not required and must not alter observable behavior beyond performance. Implementations that choose not to implement it remain conformant.

### 3.3 Exposure and Type Guards

**REQ-UNCH-06:** Implementations must expose:
- A factory function `makeUnchanged()` returning the sentinel
- A type guard `isUnchanged(value)` returning `true` only for the sentinel

These are provided for computor implementations to construct and test for the sentinel.

---

## Part IV — Persistence and Restart Contracts

This part defines storage obligations for restart resilience without mandating specific encodings or data structures.

### 4.1 Restart Resilience Requirements

A **restart** occurs when the incremental graph is reconstructed from the same schema definition and the same underlying storage (database).

**REQ-PERSIST-01:** If node instance `N@B` was materialized before restart, then after restart:
- `N@B` must still be materialized
- Its stored value must be retrievable
- Its freshness marker must be preserved
- Its dependency relationships must be reconstructable (for propagation during invalidate)

**REQ-PERSIST-02:** After restart, calling `invalidate(F, B)` must mark all previously materialized transitive dependents as `potentially-outdated`, without requiring any `pull` operations first.

This ensures that invalidation propagation works immediately after restart based on the persisted dependency graph.

**REQ-PERSIST-03:** The specific persistence mechanism (metadata keys, reverse dependency indices, auxiliary tables, etc.) is implementation-defined. Only the behavioral contract above is normative.

### 4.2 Storage Namespacing and Schema Identity

**REQ-PERSIST-04:** Each schema (set of node definitions) must be assigned a unique **schema identifier**. Storage must be isolated per schema identifier to prevent key collisions when multiple schemas use the same functors.

**REQ-PERSIST-05:** Changing the schema definition (adding nodes, removing nodes, changing arities, changing dependency structure) should result in a different schema identifier, causing the system to use separate storage.

The exact mechanism for computing schema identifiers (hash of definitions, user-provided label, etc.) is implementation-defined.

### 4.3 Encoding and Serialization Freedom

**REQ-PERSIST-06:** Implementations may choose any serialization strategy for `ComputedValue` objects. There is no requirement for:
- Canonical encoding of JSON-like structures
- Sorted keys in `Record<string, Serializable>` objects
- Specific representations of arrays, numbers, booleans, or strings

**REQ-PERSIST-07:** The only encoding requirement is semantic round-trip fidelity: if value `v` is stored and then retrieved, the deserialized result must be structurally equal to `v` according to JavaScript value equality semantics (deep equality for nested objects and arrays).

**REQ-PERSIST-08:** Implementations may optimize storage layout (compressed formats, columnar representations, external blob storage) as long as retrieval produces structurally equivalent values.

### 4.4 Database Interface Contract

Implementations interact with storage via a **database interface** (exact TypeScript/JavaScript signature provided in Part V). The database interface abstracts storage backends (filesystem, SQLite, network databases, etc.).

**REQ-DB-01:** The database must support:
- Key-value storage with keys of type `string`
- Retrieval returning stored values or `undefined` for missing keys
- Batch operations (multiple puts/deletes executed atomically)
- Enumeration of keys (for listing materialized nodes)

**REQ-DB-02:** The database need not provide ordering guarantees on key enumeration.

**REQ-DB-03:** Database operations for a single `invalidate` call must be atomic (see REQ-INV-06). This typically requires batch or transaction support.

---

## Part V — JavaScript API and Test Surface

This part consolidates all public interface definitions, error types, and test-observable behavior.

### 5.1 Factory and Core Interface

#### Factory Function

```typescript
function makeIncrementalGraph(
  rootDatabase: RootDatabase,
  nodeDefs: Array<NodeDef>
): IncrementalGraph
```

**REQ-FACTORY-01:** Must validate all node definitions at construction time. Throw errors immediately for:
- Invalid expression syntax (`InvalidExpressionError`)
- Variable scope violations (`InvalidSchemaError`)
- Overlapping output patterns (`SchemaOverlapError`)
- Arity conflicts for the same functor (`SchemaArityConflictError`)
- Cyclic dependency graphs (`SchemaCycleError`)

**REQ-FACTORY-02:** Must compute and record a schema identifier for storage namespacing.

#### IncrementalGraph Interface

```typescript
interface IncrementalGraph {
  pull(functor: string, bindings?: Array<ConstValue>): Promise<ComputedValue>;
  invalidate(functor: string, bindings?: Array<ConstValue>): Promise<void>;
  
  // Required debug interface
  debugGetFreshness(
    functor: string, 
    bindings?: Array<ConstValue>
  ): Promise<"up-to-date" | "potentially-outdated" | "missing">;
  
  debugListMaterializedNodes(): Promise<Array<string>>;
  
  debugGetSchemaHash(): string;
}
```

**REQ-IFACE-01:** For arity-0 node families (atom expressions), the `bindings` parameter defaults to `[]` and may be omitted in calls.

**REQ-IFACE-02:** For node families with arity > 0, `bindings` must be provided and its length must match the arity.

**REQ-IFACE-03:** Implementations must provide a type guard:
```typescript
function isIncrementalGraph(value: unknown): boolean
```

### 5.2 Node Definition Structure

```typescript
type NodeDef = {
  output: string;              // Expression pattern
  inputs: Array<string>;       // Dependency expression patterns
  computor: Computor;          // Async computation function
  isDeterministic: boolean;    // True if outcome is unique for given inputs
  hasSideEffects: boolean;     // True if computor has observable effects
}
```

**REQ-NODEDEF-01:** All five fields are required. Omitting any field must cause a validation error.

### 5.3 Computor Signature

```typescript
type Computor = (
  inputs: Array<ComputedValue>,
  oldValue: ComputedValue | undefined,
  bindings: Array<ConstValue>
) => Promise<ComputedValue | Unchanged>
```

**REQ-COMP-01:** The `inputs` array contains dependency values in the order they appear in the node definition's `inputs` field.

**REQ-COMP-02:** The `oldValue` parameter is the previously stored value at this node instance, or `undefined` for first-time evaluations.

**REQ-COMP-03:** The `bindings` parameter is the full binding environment for this node instance (positional array matching the output pattern's arity).

**REQ-COMP-04:** Computors may return the `Unchanged` sentinel (obtained via `makeUnchanged()`) to indicate no value change. See Part III for semantics.

### 5.4 Debug Interface (Required)

The debug interface provides observability into internal state for testing and diagnostics. It is **not optional**.

**REQ-DEBUG-01:** `debugGetFreshness(functor, bindings)` must return:
- `"up-to-date"` if the node instance is materialized and up-to-date
- `"potentially-outdated"` if the node instance is materialized and outdated
- `"missing"` if the node instance is not materialized

**REQ-DEBUG-02:** `debugListMaterializedNodes()` must return an array of strings, each uniquely identifying a materialized node instance (implementation-defined key format, often `functor:serialized_bindings`).

**REQ-DEBUG-03:** `debugGetSchemaHash()` must return the schema identifier used for storage namespacing.

### 5.5 Error Taxonomy

All errors must have a stable `.name` property (string matching the error class name) and required fields:

| Error Name                    | Required Fields                                      | Thrown When                                      |
|-------------------------------|------------------------------------------------------|--------------------------------------------------|
| `InvalidExpressionError`      | `expression: string`                                 | Expression fails to parse (schema validation)    |
| `InvalidNodeError`            | `nodeName: string`                                   | Functor not found in schema (public API)         |
| `ArityMismatchError`          | `nodeName: string, expectedArity: number, actualArity: number` | Binding count doesn't match arity (public API)   |
| `SchemaOverlapError`          | `patterns: Array<string>`                            | Multiple definitions for same functor+arity      |
| `SchemaArityConflictError`    | `nodeName: string, arities: Array<number>`           | Same functor with different arities              |
| `SchemaCycleError`            | `cycle: Array<string>`                               | Cyclic dependency detected                       |
| `InvalidSchemaError`          | `schemaPattern: string`                              | General schema validation failure                |
| `MissingValueError`           | `nodeKey: string`                                    | Up-to-date node has no stored value (corruption) |
| `InvalidUnchangedError`       | (optional additional context)                        | Computor returned Unchanged when oldValue is undefined |

**REQ-ERR-01:** Each error type must have a corresponding type guard function, e.g.:
```typescript
function isInvalidNodeError(value: unknown): boolean
```

### 5.6 Database Interfaces

#### GenericDatabase

```typescript
interface GenericDatabase<TValue> {
  get(key: string): Promise<TValue | undefined>;
  put(key: string, value: TValue): Promise<void>;
  del(key: string): Promise<void>;
  putOp(key: string, value: TValue): DatabaseBatchOperation;
  delOp(key: string): DatabaseBatchOperation;
  keys(): AsyncIterable<string>;
  clear(): Promise<void>;
}
```

**REQ-DBGEN-01:** Values must round-trip without semantic change (structural equality must be preserved).

**REQ-DBGEN-02:** The type parameter `TValue` applies consistently to all operations.

#### RootDatabase

```typescript
interface RootDatabase {
  listSchemas(): AsyncIterable<string>;
  close(): Promise<void>;
  // Internal methods for schema-namespaced storage (implementation-defined)
}
```

**REQ-DBROOT-01:** Must provide isolated storage per schema identifier (no key collisions across schemas).

**REQ-DBROOT-02:** Must support batch operations for atomicity (required by invalidate).

### 5.7 Test-Observable Behavior

This section defines what conformance tests **may** assert.

**REQ-TEST-01 (API Shape):** Tests may assert the presence and signatures of:
- `makeIncrementalGraph`
- `IncrementalGraph.pull`
- `IncrementalGraph.invalidate`
- `IncrementalGraph.debugGetFreshness`
- `IncrementalGraph.debugListMaterializedNodes`
- `IncrementalGraph.debugGetSchemaHash`
- `isIncrementalGraph`
- Type guards for all error types

**REQ-TEST-02 (Error Behavior):** Tests may assert error types (via `.name` property) and required fields for expected error conditions.

**REQ-TEST-03 (Correctness Properties):** Tests may assert properties P1′, P2, P3, P4 as specified in Part II.

**REQ-TEST-04 (Deterministic Equivalence):** Tests may assert that `pull` produces the same result as recomputing from scratch **only** when all reachable computors have `isDeterministic: true` and `hasSideEffects: false`. Tests must not assume determinism otherwise.

**REQ-TEST-05 (Freshness Observability):** Tests may use `debugGetFreshness` to assert freshness states but may not assume any particular internal implementation (versions, epochs, timestamps, etc.).

**REQ-TEST-06 (Restart Resilience):** Tests may assert that after restart (same schema, same database), materialized nodes remain materialized and invalidation propagates correctly without requiring re-pull (see Part IV).

**REQ-TEST-07 (Non-Observables):** Tests **may not** assert:
- Internal storage layout or key formats (beyond behavior)
- Specific serialization encodings
- Order of keys in database enumeration
- Internal data structures or algorithms

---

## Appendix — Requirement Index and Crosswalk

This appendix maps all normative requirements to their defining sections and provides a coverage checklist ensuring no requirements from the original specification were silently dropped.

### A.1 Requirement Index

| Requirement ID          | Part | Section | Description                                           |
|-------------------------|------|---------|-------------------------------------------------------|
| REQ-EXPR-01             | I    | 1.2     | Expression grammar conformance                        |
| REQ-EXPR-02             | I    | 1.2     | Arity-0 equivalence: `id` and `id()`                  |
| REQ-CANON-01            | I    | 1.2     | Canonicalize extracts functor                         |
| REQ-CANON-02            | I    | 1.2     | Pattern matching uses canonical form                  |
| REQ-SCHEMA-01           | I    | 1.3     | All node definition fields required                   |
| REQ-SCHEMA-02           | I    | 1.3     | Variable scope rule (inputs ⊆ output)                 |
| REQ-SCHEMA-03           | I    | 1.3     | Unique variable names per expression                  |
| REQ-SCHEMA-04           | I    | 1.3     | isDeterministic and hasSideEffects required           |
| REQ-SCHEMA-05           | I    | 1.3     | No overlapping output patterns                        |
| REQ-SCHEMA-06           | I    | 1.3     | Arity consistency for same functor                    |
| REQ-SCHEMA-07           | I    | 1.3     | Schema must be acyclic                                |
| REQ-BINDING-01          | I    | 1.4     | Binding propagation by variable name correspondence   |
| REQ-BINDING-02          | I    | 1.4     | Variable names are schema-internal                    |
| REQ-COMP-01             | I    | 1.5     | Computor returns Promise<ComputedValue \| Unchanged>  |
| REQ-EVAL-01             | I    | 1.6     | Evaluation terminates for acyclic schemas             |
| REQ-EVAL-02             | I    | 1.6     | Evaluation result is ComputedValue                    |
| REQ-MAT-01              | II   | 2.1     | Only materialized nodes tracked                       |
| REQ-MAT-02              | II   | 2.1     | Materialization occurs via pull or invalidate        |
| REQ-MAT-03              | II   | 2.1     | Unmaterialized nodes have no stored state             |
| REQ-PULL-01             | II   | 2.2     | Throw InvalidNodeError if functor not found           |
| REQ-PULL-02             | II   | 2.2     | Throw ArityMismatchError if binding count wrong       |
| REQ-PULL-03             | II   | 2.2     | pull returns ComputedValue (never undefined/Unchanged)|
| REQ-PULL-04             | II   | 2.2     | Single invocation per node instance per call          |
| REQ-PULL-05             | II   | 2.2     | Up-to-date nodes skip computor invocation             |
| REQ-INV-01              | II   | 2.3     | invalidate throws InvalidNodeError if functor unknown |
| REQ-INV-02              | II   | 2.3     | invalidate throws ArityMismatchError if arity wrong   |
| REQ-INV-03              | II   | 2.3     | invalidate does not compute values                    |
| REQ-INV-04              | II   | 2.3     | Only materialized dependents marked outdated          |
| REQ-INV-05              | II   | 2.3     | invalidate applies to any node                        |
| REQ-INV-06              | II   | 2.3     | invalidate is atomic                                  |
| REQ-UNCH-01             | III  | 3.1     | Unchanged not part of Outcomes                        |
| REQ-UNCH-02             | III  | 3.1     | Unchanged preserves old value, marks up-to-date       |
| REQ-UNCH-03             | III  | 3.1     | Unchanged invalid when oldValue is undefined          |
| REQ-UNCH-04             | III  | 3.1     | Unchanged semantically equivalent to returning oldVal |
| REQ-UNCH-05             | III  | 3.2     | Optional propagation optimization                     |
| REQ-UNCH-06             | III  | 3.3     | Expose makeUnchanged() and isUnchanged()              |
| REQ-PERSIST-01          | IV   | 4.1     | Materialized nodes survive restart                    |
| REQ-PERSIST-02          | IV   | 4.1     | Invalidate propagates after restart without pull      |
| REQ-PERSIST-03          | IV   | 4.1     | Persistence mechanism is implementation-defined       |
| REQ-PERSIST-04          | IV   | 4.2     | Schema identifier isolates storage                    |
| REQ-PERSIST-05          | IV   | 4.2     | Schema changes cause different identifiers            |
| REQ-PERSIST-06          | IV   | 4.3     | No required canonical encoding                        |
| REQ-PERSIST-07          | IV   | 4.3     | Semantic round-trip fidelity required                 |
| REQ-PERSIST-08          | IV   | 4.3     | Storage layout optimization allowed                   |
| REQ-DB-01               | IV   | 4.4     | Database supports key-value + batch + enumeration     |
| REQ-DB-02               | IV   | 4.4     | No ordering guarantees required                       |
| REQ-DB-03               | IV   | 4.4     | Atomic batch for invalidate                           |
| REQ-FACTORY-01          | V    | 5.1     | Validate schemas at construction                      |
| REQ-FACTORY-02          | V    | 5.1     | Compute schema identifier                             |
| REQ-IFACE-01            | V    | 5.1     | Arity-0 bindings default to []                        |
| REQ-IFACE-02            | V    | 5.1     | Arity>0 requires bindings of correct length           |
| REQ-IFACE-03            | V    | 5.1     | Provide isIncrementalGraph type guard                 |
| REQ-NODEDEF-01          | V    | 5.2     | All NodeDef fields required                           |
| REQ-COMP-01             | V    | 5.3     | inputs array matches definition order                 |
| REQ-COMP-02             | V    | 5.3     | oldValue is previous stored value or undefined        |
| REQ-COMP-03             | V    | 5.3     | bindings is full output binding environment           |
| REQ-COMP-04             | V    | 5.3     | Computors may return Unchanged                        |
| REQ-DEBUG-01            | V    | 5.4     | debugGetFreshness returns correct state               |
| REQ-DEBUG-02            | V    | 5.4     | debugListMaterializedNodes returns key array          |
| REQ-DEBUG-03            | V    | 5.4     | debugGetSchemaHash returns identifier                 |
| REQ-ERR-01              | V    | 5.5     | All error types have type guards                      |
| REQ-DBGEN-01            | V    | 5.6     | GenericDatabase values round-trip                     |
| REQ-DBGEN-02            | V    | 5.6     | Type parameter consistency                            |
| REQ-DBROOT-01           | V    | 5.6     | RootDatabase isolates per schema                      |
| REQ-DBROOT-02           | V    | 5.6     | RootDatabase supports batch operations                |
| REQ-TEST-01             | V    | 5.7     | Tests may assert API shape                            |
| REQ-TEST-02             | V    | 5.7     | Tests may assert error behavior                       |
| REQ-TEST-03             | V    | 5.7     | Tests may assert correctness properties               |
| REQ-TEST-04             | V    | 5.7     | Deterministic equivalence only for pure computors     |
| REQ-TEST-05             | V    | 5.7     | Freshness observable via debug interface              |
| REQ-TEST-06             | V    | 5.7     | Restart resilience testable                           |
| REQ-TEST-07             | V    | 5.7     | Internal implementation details not observable        |

### A.2 Invariants and Properties Index

| Identifier | Part | Section | Description                                           |
|------------|------|---------|-------------------------------------------------------|
| I1         | II   | 2.4     | Outdated propagates to dependents                     |
| I2         | II   | 2.4     | Up-to-date requires up-to-date dependencies           |
| I3′        | II   | 2.4     | Value admissibility with existential oldValue         |
| P1′        | II   | 2.2     | Soundness under nondeterminism                        |
| P1-det     | II   | 2.2     | Deterministic equivalence (pure computors)            |
| P2         | II   | 2.2     | Progress (termination)                                |
| P3         | II   | 2.2     | Single invocation per node per call                   |
| P4         | II   | 2.2     | Freshness preservation after pull                     |

### A.3 Coverage Checklist

This section verifies that all concepts and requirements from the original specification are addressed in the rewrite.

**Expressions and Grammar:**
- [x] Expression grammar (REQ-EXPR-01)
- [x] Arity-0 equivalence (REQ-EXPR-02)
- [x] Canonicalization (REQ-CANON-01, REQ-CANON-02)
- [x] Variable correspondence (REQ-BINDING-01, REQ-BINDING-02)

**Schema Validation:**
- [x] Variable scope rule (REQ-SCHEMA-02)
- [x] Unique variables per expression (REQ-SCHEMA-03)
- [x] No overlapping patterns (REQ-SCHEMA-05, SchemaOverlapError)
- [x] Arity consistency (REQ-SCHEMA-06, SchemaArityConflictError)
- [x] Acyclicity (REQ-SCHEMA-07, SchemaCycleError)
- [x] isDeterministic and hasSideEffects required (REQ-SCHEMA-04)

**Computors and Semantics:**
- [x] Computor signature (REQ-COMP-01, REQ-COMP-02, REQ-COMP-03)
- [x] Outcome sets and nondeterminism (Part I §1.5)
- [x] Side effects as nondeterminism (Part I §1.5)
- [x] Baseline evaluation semantics (Part I §1.6)

**Materialization and Freshness:**
- [x] Materialization definition (REQ-MAT-01, REQ-MAT-02, REQ-MAT-03)
- [x] Freshness states (Part II §2.2)
- [x] Up-to-date nodes skip computor (REQ-PULL-05)

**pull Operation:**
- [x] Error handling (REQ-PULL-01, REQ-PULL-02)
- [x] Return type (REQ-PULL-03)
- [x] Single invocation (REQ-PULL-04, P3)
- [x] Incremental strategy (Part II §2.2)

**invalidate Operation:**
- [x] Error handling (REQ-INV-01, REQ-INV-02)
- [x] No value computation (REQ-INV-03)
- [x] Propagation to materialized dependents (REQ-INV-04)
- [x] Atomicity (REQ-INV-06)
- [x] Applies to any node (REQ-INV-05)

**Unchanged Sentinel:**
- [x] Not part of Outcomes (REQ-UNCH-01)
- [x] Preserves old value (REQ-UNCH-02)
- [x] Invalid when oldValue undefined (REQ-UNCH-03)
- [x] Semantic equivalence (REQ-UNCH-04)
- [x] Optional propagation optimization (REQ-UNCH-05)
- [x] Factory and type guard (REQ-UNCH-06)

**Persistence and Restart:**
- [x] Materialized nodes survive restart (REQ-PERSIST-01)
- [x] Invalidate works after restart (REQ-PERSIST-02)
- [x] Schema namespacing (REQ-PERSIST-04, REQ-PERSIST-05)
- [x] Encoding freedom (REQ-PERSIST-06, REQ-PERSIST-07, REQ-PERSIST-08)
- [x] Database interface contracts (REQ-DB-01, REQ-DB-02, REQ-DB-03)

**JavaScript API:**
- [x] Factory function (REQ-FACTORY-01, REQ-FACTORY-02)
- [x] IncrementalGraph interface (REQ-IFACE-01, REQ-IFACE-02, REQ-IFACE-03)
- [x] NodeDef structure (REQ-NODEDEF-01)
- [x] Debug interface required (REQ-DEBUG-01, REQ-DEBUG-02, REQ-DEBUG-03)
- [x] Error taxonomy (Part V §5.5, REQ-ERR-01)
- [x] Database interfaces (Part V §5.6)

**Test Surface:**
- [x] Observable API (REQ-TEST-01)
- [x] Error behavior (REQ-TEST-02)
- [x] Correctness properties (REQ-TEST-03)
- [x] Deterministic equivalence constraints (REQ-TEST-04)
- [x] Freshness observability (REQ-TEST-05)
- [x] Restart resilience (REQ-TEST-06)
- [x] Non-observables (REQ-TEST-07)

**Invariants and Properties:**
- [x] I1 (Outdated propagation)
- [x] I2 (Up-to-date upstream)
- [x] I3′ (Value admissibility)
- [x] P1′ (Soundness under nondeterminism)
- [x] P1-det (Deterministic specialization)
- [x] P2 (Progress)
- [x] P3 (Single invocation)
- [x] P4 (Freshness preservation)

**Semantic Notes and Clarifications:**
No semantic changes were required during this rewrite. All requirements preserve their original meaning. The reorganization clarifies the distinction between:
- Baseline semantics (Part I) vs incremental constraints (Part II)
- Semantic requirements (Parts I-II) vs optimization allowances (Part III)
- Abstract contracts (Parts I-IV) vs implementation interfaces (Part V)

---

## Conformance Summary

An implementation conforms to this specification if and only if:

1. It provides all required types, interfaces, and functions with matching signatures (Part V)
2. Its observable behavior matches the baseline evaluation semantics modulo nondeterministic choice (Part I §1.6)
3. It enforces all normative requirements (all REQ-* labeled constraints)
4. It maintains all invariants (I1, I2, I3′) for materialized nodes (Part II §2.4)
5. It satisfies all correctness properties (P1′, P2, P3, P4) (Part II §2.2)
6. It passes all conformance tests derived from this specification

Conformance does not require any specific internal algorithm, data structure, or optimization strategy. Any implementation meeting these observable requirements is conformant.
