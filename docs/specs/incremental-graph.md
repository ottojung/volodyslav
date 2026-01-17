# Specification for the Incremental Graph

This document provides a formal specification for the incremental graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

* **NodeName** — an identifier string (functor/head only), e.g., `"full_event"` or `"all_events"`. Used in public API calls to identify node families. Does NOT include variable syntax or arity suffix.
* **SchemaPattern** — an expression string that may contain variables, e.g., `"full_event(e)"` or `"all_events"`. Used ONLY in schema definitions to denote families of nodes and for variable mapping.
* **Serializable** - a serializable value type. Defined recursively as: `number | string | null | Array<Serializable> | Record<string, Serializable>`.
* **ConstValue** - A subtype of `Serializable`.
* **BindingEnvironment** — a positional array of concrete values: `Array<ConstValue>`. Used to instantiate a specific node from a family. The array length MUST match the arity of the node. Bindings are matched to argument positions by position, not by name.
* **NodeInstance** — a specific node identified by a `NodeName` and `BindingEnvironment`. Conceptually: `{ nodeName: NodeName, bindings: BindingEnvironment }`. Notation: `nodeName@bindings`.
* **NodeKey** — a string key used for storage, derived from the head and bindings. This is the actual database key.
* **NodeValue** — computed value at a node (arbitrary `DatabaseValue`)
* **Freshness** — conceptual state: `"up-to-date" | "potentially-outdated"`
* **Computor** — async function: `(inputs: Array<DatabaseValue>, oldValue: DatabaseValue | undefined, bindings: Array<ConstValue>) => Promise<DatabaseValue | Unchanged>`
* **Outcome set (spec-only)** — For any schema node def `S` and arguments `(inputs, oldValue, bindings)`, define `Outcomes(S, inputs, oldValue, bindings) ⊆ (DatabaseValue ∪ {Unchanged})`. This set may be infinite. This is a specification-only concept used to formalize nondeterminism; implementations do not enumerate this set.
* **Computor invocation (spec-only)** — When the operational semantics "invokes a computor", it nondeterministically selects `r ∈ Outcomes(...)` and treats `r` as the returned value of the Promise. In implementation, this corresponds to executing the computor function, which may produce different results on different invocations for nondeterministic computors.
* **Unchanged** — unique sentinel value indicating unchanged computation result. MUST NOT be a valid `DatabaseValue` (cannot be returned by `pull()`).
* **Variable** — parameter placeholder in node schemas (identifiers in argument positions). Variables are internal to schema definitions and not exposed in public API.
* **DatabaseValue** — a subtype of `Serializable`, excluding `null`.

### 1.2 Expressions as an Infinite Graph (Normative)

This section establishes the fundamental mental model for understanding how expressions denote infinite families of nodes and how the incremental graph operates over this infinite space using a finite schema.

#### 1.2.1 Expressions Denote Node Families

An **expression** is a symbolic template that denotes a (possibly infinite) family of nodes. The expression defines the structure, while variable bindings select a specific member of that family.

**Components:**
* The **head** (or **functor**) of an expression is its identifier—the name that categorizes the family.
* The **arguments** are variable positions that can be assigned concrete `ConstValue` instances at runtime.

**Examples:**

* `all_events` — An atom expression with no variables. Denotes exactly one node (a family of size 1).
* `full_event(e)` — Denotes the infinite family `{ full_event(e=v) | v ∈ ConstValue }`.
  - Each distinct `ConstValue` for `e` identifies a different member of this family.
* `enhanced_event(e, p)` — Denotes `{ enhanced_event(e=v₁, p=v₂) | v₁, v₂ ∈ ConstValue }`.
  - The Cartesian product of all possible values for `e` and `p` forms this family.

#### 1.2.2 Node Instances (Addresses Within Families)

A **node instance** is a specific member of a node family, identified by:
1. An expression pattern (e.g., `full_event(e)`)
2. A binding environment B: `Array<ConstValue>` that assigns concrete values to all argument positions in the expression

**Notation:** We write `expr@B` to denote a node instance, where:
* `expr` is the expression pattern
* `B` is the binding environment (positional array)

**Examples:**

* `full_event(e)` with `B = [{id: "evt_123"}]` identifies the specific node `full_event(e={id: "evt_123"})`.
* `enhanced_event(e, p)` with `B = [{id: "evt_123"}, {id: "photo_456"}]` identifies one specific enhanced event.
* Variable names do not affect identity: `full_event(e)@[{id: "123"}]` and `full_event(x)@[{id: "123"}]` are the same node instance.

**Identity:** Two node instances are identical if and only if:
1. Their expression patterns have the same functor and arity, AND
2. Their binding environments are strongly equal (equality of serialized `ConstValue` objects, compared positionally)

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

**Note on Variable Names:** The variable name `e` is purely syntactic. The schemas `full_event(e)` and `full_event(x)` are functionally identical—both define an arity-1 family where the first (and only) argument position receives `bindings[0]`.

#### 1.2.4 Public Interface: Addressing Nodes

The public API requires both the `nodeName` (functor) and bindings to address a specific node:

* `pull(nodeName, bindings)` — Evaluates the node instance identified by `NodeName` and `BindingEnvironment`
* `invalidate(nodeName, bindings)` — Marks the node instance as potentially-outdated, triggering recomputation on next pull

**For arity-0 nodes** (nodes with no arguments like `all_events`):
* The binding environment is empty: `[]`
* The head alone identifies exactly one node
* `pull("all_events", [])` and `pull("all_events")` are equivalent

**For arity > 0 nodes** (nodes with arguments):
* Bindings array length MUST match the arity of the node
* Bindings are matched to argument positions by position
* Different bindings address different node instances
* `pull("full_event", [{id: "123"}])` and `pull("full_event", [{id: "456"}])` address distinct nodes

**Schema Pattern vs Public NodeName:**
* Schema definition: `output: "full_event(e)"` — uses expression pattern with variable
* Public API call: `pull("full_event", [value])` — uses nodeName only, no variable syntax
* The arity is determined by the schema, not by the caller

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

**Terminology:**
* **atom-expression** — an expression with no brackets (e.g., `all_events`). Denotes a family of exactly one node.
* **compound-expression** — an expression with brackets (e.g., `event_context(e)`, `enhanced_event(e, p)`, `all_events()`). Each argument is a variable. Denotes an infinite family of nodes.
* **variable** — an identifier in an argument position; represents a parameter that can be bound to any `constvalue`
* **pattern** — an expression used in a schema definition to describe a family of nodes
* **free variables** — all variables (identifiers occurring in argument positions) in an expression

**Examples:**
* `all_events` — atom-expression with zero variables; denotes a singleton family
* `event_context(e)` — compound-expression with one variable `e`; denotes an infinite family indexed by values of `e`
* `enhanced_event(e, p)` — compound-expression with two variables `e` and `p`; denotes an infinite family indexed by pairs of values

### 1.4 Canonical Serialization (Normative)

**REQ-CANON-01:** The function `canonicalize(expr)` MUST produce a unique canonical string that is just the head (functor) of the expression. In particular, it does not include variable names or whitespace.

**Examples:**
* `"all_events"` → `"all_events"`
* `"event_context(e)"` → `"event_context"`
* `"event_context(x)"` → `"event_context"` (same as above)
* `"enhanced_event(e, p)"` → `"enhanced_event"`
* `"   enhanced_event   (   x, y)   "` → `"enhanced_event"` (same as above)

**REQ-CANON-03:** Pattern Matching:
* The canonical form is used for pattern matching and schema indexing
* Original expression strings (with variable names) are preserved for error messages
* Schema patterns are canonicalized at initialization for O(1) lookup

**REQ-CANON-04:** All storage operations MUST use NodeKey as database keys. A NodeKey is derived from: (1) the nodeName (functor), and (2) the BindingEnvironment to produce a key.

### 1.5 NodeKey Format (Normative)

**REQ-KEY-01:** A NodeKey is a deserializable string that uniquely identifies a `NodeInstance` in storage.

**REQ-KEY-02:** All database operations (storing values, freshness, dependencies) MUST use NodeKey as the storage key.

### 1.6 Schema Definition (Normative)

**REQ-SCHEMA-01:** A incremental graph is defined by a set of node schemas:

```typescript
type NodeDef = {
  output: string;     // Expression pattern (may contain variables)
  inputs: Array<string>;   // Dependency expression patterns
  computor: Computor; // Computation function
  isDeterministic: boolean; // Whether computor is deterministic (same inputs → same output)
  hasSideEffects: boolean;  // Whether computor has side effects beyond computing return value
};
```

**Note on Determinism and Side Effects:**
* `isDeterministic`: When `true`, the computor MUST be deterministic with respect to `(inputs, oldValue, bindings)`, meaning `Outcomes(S, inputs, oldValue, bindings)` is always a singleton (exactly one possible result). When `false`, the computor MAY produce different outputs even with identical inputs (the outcome set may contain multiple elements or depend on unmodeled factors).
* `hasSideEffects`: When `true`, the computor MAY perform actions beyond computing its return value (e.g., logging, network calls, file operations). When `false`, the computor MUST be observationally pure (no observable side effects). In the formal model, side effects are treated as a form of nondeterminism—they are not separately tracked in the observable contract.
* These fields are semantic claims about the computor's behavior and are NOT stored in the database. They are used to justify stronger correctness properties for the deterministic/pure subset of computors. When `isDeterministic=true` and `hasSideEffects=false`, the system can provide stronger guarantees about reproducibility.

**REQ-SCHEMA-02:** Variables in `output` MUST be a superset of all variables in `inputs` (Variable Scope Rule 1).

**REQ-SCHEMA-03:** A **source node** is any node instance matching a schema where `inputs = []`.

**REQ-SCHEMA-04:** All variable names within an expression MUST be unique. Expressions with duplicate variable names (e.g., `event(a, b, c, b, d)` where `b` appears twice) MUST be rejected with an `InvalidSchemaError`. This requirement applies to both `output` and `inputs` expressions in node definitions.

**REQ-SCHEMA-05:** The `isDeterministic` and `hasSideEffects` fields are REQUIRED in all `NodeDef` definitions. They MUST NOT be stored in the database persistence layer.

### 1.7 Variable Name Mapping and Positional Bindings (Normative)

**Key Principle:** Bindings are always positional arrays, but variable names in input patterns are mapped to output pattern variables by name to determine the correct positional slice.

**REQ-BINDING-01:** When instantiating input pattern dependencies:
1. Match each variable in the input pattern to the corresponding variable in the output pattern **by name**
2. Extract the positional bindings from the output binding environment according to the matched positions
3. Construct the input binding environment using only the positions needed for that input

**Example:**

```javascript
{
  output: "enhanced_event(e, p)",  // Arity 2: position 0 = e, position 1 = p
  inputs: ["event_context(e)", "photo(p)"],  // Both arity 1
  computor: async ([ctx, photo], old, bindings) => ({...ctx, photo})
}
```

When evaluating `enhanced_event(e, p)@[{id: "evt_123"}, {id: "photo_456"}]`:
- Output bindings: `B_output = [{id: "evt_123"}, {id: "photo_456"}]`
- For input `event_context(e)`: variable `e` maps to position 0 of output → `B_input = [{id: "evt_123"}]`
- For input `photo(p)`: variable `p` maps to position 1 of output → `B_input = [{id: "photo_456"}]`
- Computor receives full output bindings: `bindings = [{id: "evt_123"}, {id: "photo_456"}]`

**REQ-BINDING-02:** Variable names in the output pattern define a **namespace** for that schema. All variables in input patterns must exist in this namespace (enforced by REQ-SCHEMA-02).

**REQ-BINDING-03:** Public API calls use `nodeName` (functor only) with positional bindings:
1. The system matches the nodeName to a schema (REQ-MATCH-01)
2. The positional bindings are used directly
3. Variable names are schema-internal only

**Example:**
```javascript
// Schema: output: "full_event(e)", inputs: ["event_data(e)"]

// Public API uses nodeName only (no variable syntax):
await graph.pull("full_event", [{id: "123"}]);

// The nodeName "full_event" matches the schema
// Bindings [{id: "123"}] are positional (length must equal arity)
// Result addresses the node instance: full_event@[{id: "123"}]
// - Same positional bindings: [{id: "123"}] at position 0
```

**Pattern Instantiation Summary:** When evaluating a node instance `output@B`:
1. The computor receives the full output binding environment `B` as its third parameter
2. Each input pattern `input_i` is instantiated by extracting the relevant positional bindings based on variable name mapping
3. The computor receives the values of all instantiated input nodes in the order they appear in the `inputs` array

### 1.8 Pattern Matching (Normative)

**REQ-MATCH-01:** A schema output pattern `P` **matches** a nodeName `N` if and only if:
1. `P` and `N` have the same functor (identifier), AND
2. The arity of `P` matches the expected arity for `N`

**REQ-MATCH-02:** Two output patterns **overlap** if they have the same functor and the same arity.

**REQ-MATCH-03:** The system MUST reject graphs with overlapping output patterns at initialization (throw `SchemaOverlapError`).

**REQ-MATCH-04:** Each head (functor) MUST have a single, unique arity across all schema outputs. The system MUST reject graphs where the same head appears with different arities (throw `SchemaArityConflictError`).

**Note on Matching:** Pattern matching in schema definitions is purely structural and does not consider variable names. The pattern `full_event(e)` and `full_event(x)` are equivalent—both define an arity-1 node family. Variable names serve only for documentation and variable mapping between inputs and outputs.

**Note on Public API:** The public API uses only the nodeName (e.g., `"full_event"`), not expression patterns. The arity is determined by the schema, and callers must provide bindings that match the expected arity.

### 1.9 Cycle Detection (Normative)

**REQ-CYCLE-01:** A directed edge exists from Schema S to Schema T if:
1. S has input pattern I
2. T has output pattern O
3. Patterns I and O match (same functor and arity)

**REQ-CYCLE-02:** The system MUST reject graphs with cycles at initialization (throw `SchemaCycleError`).

### 1.10 Materialization (Normative)

**REQ-MAT-01:** A **materialized node** is any `NodeInstance` (identified by `NodeKey`) for which the implementation maintains dependency tracking and freshness state.

**REQ-MAT-02:** Materialization occurs through:
* `pull(nodeName, bindings)` — creates `NodeInstance` with dependencies, stores value at `NodeKey`, marks `up-to-date`
* `invalidate(nodeName, bindings)` — materializes a `NodeInstance` at `NodeKey` (so it can participate in persisted "materialized set"), marks `potentially-outdated`

### 1.11 Notes on Nondeterminism and Side Effects (Normative)

**Treatment of Side Effects:** In this specification, side effects performed by computors are treated as a form of nondeterminism. They are NOT separately tracked or made part of the observable contract. The formal model uses outcome sets to capture all sources of variation in computor results, whether from true nondeterminism (e.g., random number generation), external state (e.g., reading current time, network calls), or side effects (e.g., logging, metrics).

**Observable Contract:** The only observable aspect of a computor is its returned value. Side effects are:
* Permitted when `hasSideEffects=true`
* Treated as contributing to the nondeterministic choice from the outcome set
* Not guaranteed to execute exactly once, at-least-once, or at-most-once
* Subject to the recomputation policy: computors are NOT invoked for up-to-date nodes (REQ-PULL-04)

**Implications for Testing:** Tests cannot observe or verify side effects directly. Tests can only assert properties about returned values. The `hasSideEffects` flag is metadata that enables certain optimizations and reasoning, but does not affect the observable behavior from a testing perspective.

---

## 2. Operational Semantics (Normative)

### 2.1 pull(nodeName, bindings) → NodeValue

**Signature:** `pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<DatabaseValue>`

**Big-Step Semantics:**

```javascript
pull(nodeName, B):
  schema = lookup_schema_by_nodeName(nodeName)
  nodeKey = createNodeKey(nodeName, B)
  inputs_values = [pull(I_nodeName, I_bindings) for I in inputs_of(schema)]
  old_value = stored_value(nodeKey)
  r ∈ Outcomes(schema, inputs_values, old_value, B)  // nondeterministic choice
  if r == Unchanged:
    new_value = old_value
  else:
    new_value = r
  store(nodeKey, new_value)
  return stored_value(nodeKey)
```

Note: this specification describes the abstract input-output semantics using nondeterministic choice from outcome sets. It ignores implementation details like freshness tracking, caching, etc.

**REQ-PULL-01:** `pull` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-PULL-02:** `pull` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema for the given nodeName.

**REQ-PULL-03:** `pull` MUST ensure each computor is invoked at most once per top-level call for each unique node instance (property P3).

**REQ-PULL-04 (No spurious recomputation):** If a materialized node instance is `up-to-date` at the time it is encountered during a `pull()`, the implementation MUST return its stored value and MUST NOT invoke its computor. This makes `pull()` use call-by-need semantics and prevents repeated effects/resampling for up-to-date nodes.

**Efficiency Optimization (Implementation-Defined):**

Implementations MAY use any strategy to achieve property P3 (e.g., memoization, freshness checks, in-flight tracking). The specific mechanism is not prescribed.

### 2.2 invalidate(nodeName, bindings)

**Signature:** `invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>`

**Effects:**
1. Create `NodeKey` from `nodeName@bindings`
2. Ensure the node instance is materialized (persist markers sufficient for restart)
3. Mark that node instance as `potentially-outdated`
4. Mark all **materialized** transitive dependents as `potentially-outdated`

**Important:** `invalidate()` does NOT write a value. Values are provided by computors when nodes are pulled.

**REQ-INV-01:** `invalidate` MUST return a `Promise<void>`.

**REQ-INV-02:** `invalidate` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-INV-03:** `invalidate` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema.

**REQ-INV-04:** `invalidate` works on any node (source or derived). There is no restriction.

**REQ-INV-05:** All operations MUST be executed atomically in a single database batch.

**REQ-INV-06:** Only dependents that have been previously materialized (pulled or invalidated) are marked outdated. Unmaterialized node instances remain unmaterialized.

### 2.3 Unchanged Propagation Optimization

**REQ-UNCH-01:** When a computor returns `Unchanged`:
1. Node's value MUST NOT be updated (keeps old value)
2. Node MUST be marked `up-to-date`

**REQ-UNCH-02:** An implementation MAY mark dependent D `up-to-date` without recomputing **if and only if** it can prove D's value would be unchanged given current input values.

**REQ-UNCH-03:** A computor MUST NOT return `Unchanged` when `oldValue` is `undefined`. If it does, `pull` MAY throw `InvalidUnchangedError`.

---

## 3. Required Interfaces (Normative)

### 3.1 Factory Function

```typescript
function makeIncrementalGraph(
  rootDatabase: RootDatabase,
  nodeDefs: Array<NodeDef>
): IncrementalGraph;
```

**REQ-FACTORY-01:** MUST validate all schemas at construction (throw on parse errors, scope violations, overlaps, cycles, and arity conflicts).

**REQ-FACTORY-02:** MUST compute schema identifier for internal storage namespacing.

**REQ-FACTORY-03:** MUST reject schemas where the same head appears with different arities (throw `SchemaArityConflictError`).

### 3.2 IncrementalGraph Interface

```typescript
interface IncrementalGraph {
  pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<DatabaseValue>;
  invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>;
}
```

**REQ-IFACE-01:** Implementations MUST provide type guard `isIncrementalGraph(value): boolean`.

**REQ-IFACE-02:** For atom-expressions (arity 0), `bindings` parameter defaults to `[]` and may be omitted.

**REQ-IFACE-03:** For compound-expressions (arity > 0), `bindings` MUST be provided with length matching the expression arity.

### 3.3 Database Interfaces

#### GenericDatabase<T>

```typescript
interface GenericDatabase<T> {
  get(key: string): Promise<T | undefined>;
  put(key: string, value: T): Promise<void>;
  del(key: string): Promise<void>;
  putOp(key: string, value: T): DatabaseBatchOperation;
  delOp(key: string): DatabaseBatchOperation;
  keys(): AsyncIterable<string>;
  clear(): Promise<void>;
}
```

**REQ-DB-01:** Values MUST round-trip without semantic change.

**Note on Storage:** Internal storage organization (including how values, freshness, dependencies, and reverse dependencies are stored) is implementation-defined and not exposed in the public interface.

#### RootDatabase

```typescript
interface RootDatabase {
  // Internal interface - specifics are implementation-defined
  // Must support schema-namespaced storage and isolation
  listSchemas(): AsyncIterable<string>;
  close(): Promise<void>;
}
```

**REQ-ROOT-01:** Implementations MUST provide isolated storage per schema identifier.

**REQ-ROOT-02:** Different schema identifiers MUST NOT share storage or cause key collisions.

### 3.4 Computor Signature

```typescript
type Computor = (
  inputs: Array<DatabaseValue>,
  oldValue: DatabaseValue | undefined,
  bindings: Array<ConstValue>
) => Promise<DatabaseValue | Unchanged>;
```

**REQ-COMP-01′ (Conditional Determinism):** If `NodeDef.isDeterministic` is `true`, the computor MUST be deterministic with respect to `(inputs, oldValue, bindings)`. Formally, `Outcomes(S, inputs, oldValue, bindings)` MUST always be a singleton set. If `NodeDef.isDeterministic` is `false`, the computor MAY be nondeterministic (outcome set may contain multiple elements).

**REQ-COMP-02′ (Conditional Purity):** If `NodeDef.hasSideEffects` is `false`, the computor MUST NOT have observable side effects. If `NodeDef.hasSideEffects` is `true`, the computor MAY perform side effects (which are treated as nondeterminism in the formal model).

**REQ-COMP-03:** Computors MAY return `Unchanged` sentinel to indicate no value change.

**REQ-COMP-04:** Implementations MUST expose `makeUnchanged()` factory and `isUnchanged(value)` type guard.

**REQ-COMP-05:** The `bindings` parameter is a positional array matching the schema output pattern's arguments by position. For example, if the output pattern is `full_event(e)`, then `bindings[0]` contains the value for the first argument position, `e`.

### 3.5 Error Taxonomy

All errors MUST provide stable `.name` property and required fields:

| Error Name | Required Fields | Thrown When |
|------------|----------------|-------------|
| `InvalidExpressionError` | `expression: string` | Invalid expression syntax (schema parsing) |
| `InvalidNodeError` | `nodeName: string` | No schema matches the given nodeName (public API) |
| `InvalidSetError` | `nodeName: string` | Node is not a source node (deprecated - set() removed) |
| `SchemaOverlapError` | `patterns: Array<string>` | Overlapping output patterns at init (schema validation) |
| `InvalidSchemaError` | `schemaPattern: string` | Schema definition problems at init (schema validation) |
| `SchemaCycleError` | `cycle: Array<string>` | Cyclic schema dependencies at init (schema validation) |
| `MissingValueError` | `nodeKey: string` | Up-to-date node has no stored value (internal) |
| `ArityMismatchError` | `nodeName: string, expectedArity: number, actualArity: number` | Bindings array length does not match node arity (public API) |
| `SchemaArityConflictError` | `nodeName: string, arities: Array<number>` | Same head with different arities in schema (schema validation) |

**REQ-ERR-01:** All error types MUST provide type guard functions (e.g., `isInvalidExpressionError(value): boolean`).

---

## 4. Persistence & Materialization (Normative)

### 4.1 Materialization Markers

**REQ-PERSIST-01:** Implementations MUST persist sufficient markers to reconstruct materialized node instance set after restart.

**REQ-PERSIST-02:** If node instance `N@B` was materialized before restart, then after restart (same `RootDatabase`, same schema):
* `invalidate(nodeName, bindings)` MUST mark all previously materialized transitive dependents as `potentially-outdated`
* This MUST occur WITHOUT requiring re-pull

**REQ-PERSIST-03:** The specific persistence mechanism (metadata keys, reverse index, etc.) is implementation-defined.

### 4.2 Invariants

The graph MUST maintain these invariants for all materialized node instances:

**I1 (Outdated Propagation):** If materialized node instance `N@B` is `potentially-outdated`, all materialized transitive dependents are also `potentially-outdated`.

**I2 (Up-to-Date Upstream):** If materialized node instance `N@B` is `up-to-date`, all materialized transitive dependencies are also `up-to-date`.

**I3′ (Value Admissibility):** If materialized node instance `N@B` is `up-to-date`, then letting `inputs_values` be the stored values of its instantiated input node instances, the stored value `v` of `N@B` MUST satisfy:
* there exists some `oldValue` such that `v ∈ Outcomes(schema(N), inputs_values, oldValue, B)`.

This invariant uses an existential quantifier over `oldValue` to avoid requiring storage of the previous value. All nodes, including source nodes, satisfy I3′ the same way: their stored value must be consistent with their computor's `Outcomes(...)` set (possibly using the existential `oldValue` quantification).

### 4.3 Correctness Properties

**P1′ (Soundness under nondeterminism):** For any `pull(nodeName, B)` that returns value `v`, `v` is a value permitted by the nondeterministic big-step semantics. That is, there exists a derivation where all computor invocations choose elements from their `Outcomes(...)` sets and the final returned value is `v`.

**P1-det (Deterministic specialization, corollary):** If all computors reachable from node instance `N@B` have `isDeterministic=true` and `hasSideEffects=false`, then P1′ strengthens to: `pull(N, B)` produces the same result as recomputing all values from scratch with the same input values. This recovers the traditional semantic equivalence property for the deterministic and pure subset of computors.

**P2 (Progress):** Every `pull(N, B)` call terminates (assuming computors terminate).

**P3 (Single Invocation):** Each computor invoked at most once per top-level `pull()` for each unique node instance.

**P4 (Freshness Preservation):** After `pull(N, B)`, the node instance `N@B` and all transitive dependencies are `up-to-date`.

---

## 5. Test-Visible Contract (Normative)

This section defines exactly what conformance tests MAY assert. All other implementation details are internal and subject to change.

### 5.1 Public API

Tests MAY assert the existence and signatures of:

* `makeIncrementalGraph(rootDatabase: RootDatabase, nodeDefs: Array<NodeDef>): IncrementalGraph` — Factory function
* `IncrementalGraph.pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<DatabaseValue>` — Retrieve/compute node value
* `IncrementalGraph.invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>` — Mark node as potentially-outdated
* `isIncrementalGraph(value): boolean` — Type guard

### 5.2 Observable Error Taxonomy

Tests MAY assert error names (via `.name` property) and required fields (see section 3.5 for complete taxonomy).

### 5.3 Canonicalization Requirement

Tests MAY assert:
* Whitespace normalization in expressions
* See REQ-CANON-03 and REQ-CANON-04 in section 1.4

### 5.4 Freshness Observability

**REQ-FRESH-01:** Internal freshness tracking mechanisms (versions, epochs, etc.) are implementation-defined and NOT observable to tests.

### 5.5 Restart Resilience

**REQ-RESTART-01:** Materialized node instances MUST remain materialized across graph restarts (same `RootDatabase`, same schema).

**REQ-RESTART-02:** After restart, `invalidate(nodeName, bindings)` MUST invalidate all previously materialized transitive dependents WITHOUT requiring re-pull.

### 5.6 Behavioral Guarantees

**REQ-BEHAVE-01 = P1′** (see §4.3): `pull(N, B)` MUST produce a result that is permitted by the nondeterministic big-step semantics (Soundness under nondeterminism). For deterministic and pure computors (where all reachable computors have `isDeterministic=true` and `hasSideEffects=false`), this strengthens to the traditional semantic equivalence with recomputing from scratch.

**REQ-BEHAVE-02 = P3** (see §4.3): Each computor MUST be invoked at most once per top-level `pull()` call for each unique node instance (Single Invocation).

**REQ-BEHAVE-03 = P4** (see §4.3): After `pull(N, B)` completes, node instance `N@B` and all its transitive dependencies MUST be marked `up-to-date` (Freshness Preservation).

**REQ-BEHAVE-04 (Test Determinism Assumption):** Tests MUST NOT assume deterministic behavior unless all computors in the incremental graph being tested have `isDeterministic=true` and `hasSideEffects=false`. Tests may only assert deterministic equivalence (e.g., "pull produces same result as recomputing from scratch") for graphs where all computors are declared deterministic and side-effect-free.

---

## 6. Appendices (Non-Normative)

### Appendix A: Examples

#### A.1 Simple Linear Chain

**Schema:**
```javascript
[
  { output: "all_events", inputs: [], 
    computor: async ([], old) => old || { events: [] },
    isDeterministic: true,
    hasSideEffects: false },
  { output: "meta_events", inputs: ["all_events"], 
    computor: async ([all]) => extractMeta(all),
    isDeterministic: true,
    hasSideEffects: false },
  { output: "event_context(e)", inputs: ["meta_events"], 
    computor: async ([meta], old, bindings) => {
      const e = bindings[0]; // First argument position
      return meta.find(ev => ev.id === e.id);
    },
    isDeterministic: true,
    hasSideEffects: false }
]
```

**Operations:**
```javascript
// External state for source nodes
const allEventsCell = { value: {events: [{id: 'evt_123', data: '...'}]} };

// Invalidate source (atom expression, no bindings needed)
await graph.invalidate('all_events');

// Pull derived atom expression
const meta = await graph.pull('meta_events');

// Pull parameterized node with positional bindings
const context = await graph.pull('event_context', [{id: 'evt_123'}]);
```

**How it works:**
* `all_events` is an atom expression—it denotes a single node
* Schema defines `event_context(e)` as a compound expression—it denotes an infinite family
* Calling `pull('event_context', [{id: 'evt_123'}])` uses nodeName only, selects one specific member of that family
* The binding array `[{id: 'evt_123'}]` has length 1, matching the arity defined in the schema
* Different bindings create different node instances: `event_context@[{id:'evt_123'}]` vs `event_context@[{id:'evt_456'}]`
* NodeName is constant for a family; only bindings vary between instances

#### A.2 Multiple Parameters

```javascript
// External state cells
const allEventsCell = { value: {events: []} };
const photoStorageCell = { value: {photos: {}} };

[
  { output: "all_events", inputs: [], 
    computor: async () => allEventsCell.value,
    isDeterministic: true,
    hasSideEffects: false },
  { output: "photo_storage", inputs: [],
    computor: async () => photoStorageCell.value,
    isDeterministic: true,
    hasSideEffects: false },
  { output: "event_context(e)", inputs: ["all_events"],
    computor: async ([all], _, bindings) => {
      const e = bindings[0]; // First position
      return all.events.find(ev => ev.id === e.id);
    },
    isDeterministic: true,
    hasSideEffects: false },
  { output: "photo(p)", inputs: ["photo_storage"],
    computor: async ([storage], _, bindings) => {
      const p = bindings[0]; // First position
      return storage.photos[p.id];
    },
    isDeterministic: true,
    hasSideEffects: false },
  { output: "enhanced_event(e, p)", 
    inputs: ["event_context(e)", "photo(p)"],
    computor: async ([ctx, photo], _, bindings) => {
      // bindings[0] is the event, bindings[1] is the photo
      return {...ctx, photo};
    },
    isDeterministic: true,
    hasSideEffects: false }
]
```

**Operations:**
```javascript
// External state for source nodes
const allEventsCell = { value: {events: [{id: 'evt_123'}]} };
const photoStorageCell = { value: {photos: {'photo_456': {url: '...'}}} };

// Invalidate sources
await graph.invalidate('all_events');
await graph.invalidate('photo_storage');

// Pull with multiple positional bindings
const enhanced = await graph.pull('enhanced_event', [
  {id: 'evt_123'},
  {id: 'photo_456'}
]);
```

**How it works:**
* Schema defines `enhanced_event(e, p)` denoting the Cartesian product of all possible event and photo values
* Public call uses nodeName `"enhanced_event"` with binding array of length 2
* Position 0 corresponds to the first argument, position 1 to the second
* The schema declares: for any bindings `B`, `enhanced_event@B` depends on `event_context@B[0..0]` and `photo@B[1..1]`
* When we pull with `[{id: 'evt_123'}, {id: 'photo_456'}]`, the system instantiates both dependencies with the appropriate positional bindings

#### A.3 Variable Sharing

```javascript
// External state cell
const eventDataCell = { value: { statuses: {}, metadata: {} } };

[
  { output: "event_data", inputs: [],
    computor: async () => eventDataCell.value,
    isDeterministic: true,
    hasSideEffects: false },
  { output: "status(e)", inputs: ["event_data"],
    computor: async ([data], _, bindings) => {
      const e = bindings[0]; // First position
      return data.statuses[e.id];
    },
    isDeterministic: true,
    hasSideEffects: false },
  { output: "metadata(e)", inputs: ["event_data"],
    computor: async ([data], _, bindings) => {
      const e = bindings[0]; // First position
      return data.metadata[e.id];
    },
    isDeterministic: true,
    hasSideEffects: false },
  { output: "full_event(e)", 
    inputs: ["status(e)", "metadata(e)"],
    computor: async ([status, meta], _, bindings) => {
      const e = bindings[0]; // First position
      return {id: e.id, status, meta};
    },
    isDeterministic: true,
    hasSideEffects: false }
]
```

**Operations:**
```javascript
// External state for source node
const eventDataCell = { value: {
  statuses: {'evt_123': 'active'},
  metadata: {'evt_123': {created: '2024-01-01'}}
} };

// Invalidate source
await graph.invalidate('event_data');

// Pull with positional binding
const fullEvent = await graph.pull('full_event', [{id: 'evt_123'}]);
// Result: {id: 'evt_123', status: 'active', meta: {created: '2024-01-01'}}
```

**How it works:**
* Schema defines all three expressions with arity 1 (one argument position)
* When pulling `full_event` with `[{id:'evt_123'}]`, both dependencies are instantiated with the same positional binding
* The binding propagates through the entire dependency chain
* Variable names (`e` in this case) are schema-internal—public API uses `nodeName` only

### Appendix C: Optional Debug Interface

For testing and debugging, implementations MAY provide:

```typescript
interface IncrementalGraphDebug {
  // Query freshness state of a specific node instance
  debugGetFreshness(nodeName: NodeName, bindings?: BindingEnvironment): Promise<"up-to-date" | "potentially-outdated" | "missing">;
  
  // List all materialized node instances (NodeKey strings)
  debugListMaterializedNodes(): Promise<Array<string>>;
  
  // Get the schema hash/identifier for this graph (for storage inspection)
  debugGetSchemaHash(): string;
}
```

**Purpose:** These methods expose internal state for testing purposes only. They are not part of the normative public API.

**Notes:**
- `"missing"` represents `undefined` freshness (unmaterialized node)
- `debugListMaterializedNodes()` returns NodeKey strings
- `debugGetSchemaHash()` returns the schema identifier used for storage namespacing
- Tests MAY use these methods to inspect internal state and validate behavior

### Appendix D: Implementation Notes

#### D.1 Batching

All database operations within a single `invalidate()` call SHOULD be batched atomically.

Database operations during `pull()` SHOULD be batched per node recomputation.

#### D.2 Dependent Lookup Optimization

To efficiently implement invalidation, implementations SHOULD maintain a reverse dependency index allowing O(1) lookup of immediate dependents.

#### D.3 Reserved for Future Use

This section is reserved for future implementation notes.

### Appendix E: Edge Cases

#### E.1 Unmatched Pull Request

**Error:** `pull("unknown_node", [])` but no schema pattern matches.

**Behavior:** Throw `InvalidNodeError`.

#### E.2 Binding Arity Mismatch

**Error:** `pull("event_context", [])` where we have `event_context(e)` in the schema: wrong number of bindings.

**Behavior:** Throw `ArityMismatchError`.

**Example:**
```javascript
// Schema has: output: "event_context(e)" (arity 1)

// ❌ Wrong: Missing binding (empty array)
await graph.pull("event_context", []);

// ❌ Wrong: Too many bindings
await graph.pull("event_context", [{id: 'evt_123'}, {extra: 'value'}]);

// ✅ Correct: Exactly one binding for arity-1 expression
await graph.pull("event_context", [{id: 'evt_123'}]);
```

#### E.3 Missing Values

If node instance is `up-to-date` but has no stored value, this is database corruption. MUST throw `MissingValueError`.

#### E.4 Atom Expressions with Bindings

**Scenario:** Providing bindings for an atom expression (no arguments).

**Behavior:** Empty bindings array required for atom expressions (arity 0).

**Example:**
```javascript
// ✅ Correct for arity 0 node:
await graph.pull("all_events", []);
await graph.pull("all_events"); // bindings default to []

// ❌ Wrong: Non-empty bindings for arity 0 node:
await graph.pull("all_events", [{x: "value"}]); // throws `ArityMismatchError`
```

---

## Conformance Summary

An implementation conforms to this specification if and only if:

1. It provides all required types, interfaces, and functions with matching signatures
2. It throws documented errors with stable names at specified times
3. It enforces all REQ-* requirements
4. It produces results consistent with big-step semantics and correctness properties
5. It passes all conformance tests derived from this specification

Optional features (GraphStorage, Debug interface, etc.) MAY be provided without affecting conformance.
