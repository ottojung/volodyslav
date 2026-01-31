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

**Arity-0 Equivalence:** For nodes with no arguments:
* `ident` and `ident()` in schema patterns are equivalent
* `pull("nodeName", [])` and `pull("nodeName")` are equivalent (REQ-ARGS-01)

**Variable Names:** Variable names in schema patterns do NOT affect node identity or matching:
* `full_event(e)` and `full_event(x)` define the same node family (arity-1, functor `"full_event"`)
* Variable names exist only for documentation and variable mapping between inputs/outputs (§1.8)
* Node identity depends solely on `(nodeName, bindings)` where bindings are compared positionally

**Identity:** Two node instances are identical if and only if:

1. Their `nodeName` values are equal (same functor)
2. Their `bindings` arrays are equal (compared positionally using `isEqual`)

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

**REQ-EXPR-02 (Arity-0 Equivalence):** For arity-0 expressions, `ident` and `ident()` MUST be treated as semantically equivalent. Both denote the same schema expression (a family of size 1 with no arguments). Parsing, schema matching, and semantics MUST treat them identically.

**Terminology:**
* **atom-expression** — an expression with no brackets (e.g., `all_events`). Denotes a family of exactly one node.
* **compound-expression** — an expression with brackets (e.g., `event_context(e)`, `enhanced_event(e, p)`, `all_events()`). Each argument is a variable. If it has one or more variables, it denotes an infinite family of nodes; if it has zero variables (e.g., `all_events()`), it denotes a singleton family (arity 0).
* **variable** — an identifier in an argument position; represents a parameter that can be bound to any `constvalue`
* **pattern** — an expression used in a schema definition to describe a family of nodes
* **free variables** — all variables (identifiers occurring in argument positions) in an expression

**Examples:**
* `all_events` — atom-expression with zero variables; denotes a singleton family
* `event_context(e)` — compound-expression with one variable `e`; denotes an infinite family indexed by values of `e`
* `enhanced_event(e, p)` — compound-expression with two variables `e` and `p`; denotes an infinite family indexed by pairs of values

#### 1.3.1 Expression Normalization (Normative)

For schema parsing and pattern matching, expressions are normalized using these semantic equivalence rules:

1. **Whitespace:** Surrounding and internal whitespace is ignored. `event(e)` and `  event  (  e  )  ` are equivalent.

2. **Arity-0 Forms:** For arity-0 expressions, the atom form `ident` and compound form `ident()` are semantically equivalent (REQ-EXPR-02). Both denote the same node family with zero arguments.

3. **Variable Names:** Variable names are ignored for identity and matching purposes. `event(e)` and `event(x)` are equivalent—both define an arity-1 family with functor `"event"`. Variable names matter only for variable mapping (§1.8).

**Purpose:** These normalization rules define semantic equivalence for schema matching, overlap detection, and cycle detection. They do NOT prescribe any internal representation or storage encoding.

### 1.4 Functor Extraction and Pattern Matching (Normative)

**DEF-FUNCTOR-01 (Functor Extraction):** The function `functor(expr)` extracts and returns the functor (identifier) of an expression. Normalization rules from §1.3.1 apply (whitespace and variable names are ignored).

**Examples:**
* `functor("all_events")` → `"all_events"`
* `functor("event_context(e)")` → `"event_context"`
* `functor("event_context(x)")` → `"event_context"` (same functor per §1.3.1)
* `functor("enhanced_event(e, p)")` → `"enhanced_event"`

### 1.5 Deep Equality (Normative)

**DEF-EQUAL-01 (Deep Equality):** The function `isEqual` defines deep equality for `SimpleValue` instances. It is defined recursively as follows:

```typescript
function isEqual(a: SimpleValue, b: SimpleValue): boolean {
  if (typeof a === 'number' && typeof b === 'number') {
    if (isNaN(a) && isNaN(b)) {
      return true; // NaN is equal to NaN
    }
  }

  // Primitive types: use JavaScript ===
  if (typeof a !== 'object' || typeof b !== 'object') {
    return a === b;
  }

  // Arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) {
      if (!isEqual(a[i], b[i])) return false;
    }
    return true;
  }

  // One array, one not
  if (Array.isArray(a) || Array.isArray(b)) {
    return false;
  }

  // Records (objects)
  // Important: key order does matter.
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);

  if (keysA.length !== keysB.length) return false;

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!isEqual(a[keysA[i]], b[keysA[i]])) return false;
  }

  return true;
}
```

Two values are equal if and only if `isEqual(a, b)` returns `true`.

Implementations MAY use any internal representation for storage as long as values retrieved from storage are deeply equal (according to DEF-EQUAL-01) to the values that were stored.

### 1.6 NodeKey Format (Normative)

**DEF-KEY-01** A NodeKey is a string that uniquely identifies a `NodeInstance` in storage. It is derived from `(nodeName, bindings)`. The specific format of NodeKey is implementation-defined.
Different implementations MAY use different key formats as long as NodeKey respects node instance identity (see §1.2.5).

**REQ-KEY-01 (Identity-preserving NodeKey):**
If two node instances are identical per §1.2.5 (same `nodeName` and position-wise `isEqual` on `bindings`), they MUST map to the same NodeKey.
If they are not identical per §1.2.5, they MUST map to different NodeKeys.

### 1.7 Schema Definition (Normative)

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

**REQ-SCHEMA-02:** Variables in `output` MUST be a superset of all variables in `inputs` (Variable Scope Rule 1).

**TERM (source node):** A **source node** is any node instance matching a schema where `inputs = []`.

**REQ-SCHEMA-03:** All variable names within an expression MUST be unique. Expressions with duplicate variable names (e.g., `event(a, b, c, b, d)` where `b` appears twice) MUST be rejected with an `InvalidSchemaError`. This requirement applies to both `output` and `inputs` expressions in node definitions.

### 1.8 Variable Name Mapping and Positional Bindings (Normative)

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
1. The system matches the nodeName to a schema (DEF-MATCH-01)
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

### 1.9 Pattern Matching (Normative)

**DEF-MATCH-01 (Pattern Matching):** A schema output pattern `P` matches a nodeName `N` if and only if they have the same functor (identifier). Normalization rules from §1.3.1 apply.

**DEF-OVERLAP-01 (Pattern Overlap):** Two output patterns overlap if they have the same functor and the same arity.

**REQ-MATCH-01 (Duplicate Functor Rejection):** If the same functor appears more than once across schema outputs, the system MUST reject the schema with one of the following errors:
1. If the arities differ, throw `SchemaArityConflictError`.
2. If the arities are the same, throw `SchemaOverlapError`.

**REQ-MATCH-02 (Unique Arity):** Each functor MUST have a single, unique arity across all schema outputs.

**Note:** See §1.2.5 for the complete addressing and identity rules, including how schema arity is determined and validated.

### 1.10 Cycle Detection (Normative)

**DEF-SCHEMA-EDGE-01 (Schema Dependency Edge):** A directed edge exists from Schema S to Schema T if:
1. S has input pattern I
2. T has output pattern O
3. Patterns I and O match (same functor, per DEF-MATCH-01)

**REQ-CYCLE-01 (Acyclic Schema):** The system MUST reject schemas with cycles at initialization (throw `SchemaCycleError`). Cycle detection uses the edge relation defined in DEF-SCHEMA-EDGE-01.

### 1.11 Materialization (Normative)

**DEF-MATERIALIZED-01 (Materialized Node):** A materialized node is any `NodeInstance` (identified by `NodeKey`) for which the implementation maintains state (values, freshness, dependencies, etc.).

**REQ-MAT-01 (Materialization Triggers):** Materialization occurs through:
* `pull(nodeName, bindings)` — materializes `NodeInstance`, computes and stores value, marks `up-to-date`
* `invalidate(nodeName, bindings)` — materializes `NodeInstance`, marks `potentially-outdated`

**REQ-MAT-02 (Persistent Materialization):** Once materialized, a node instance MUST remain materialized across restarts (required by REQ-PERSIST-01 behavioral equivalence).

### 1.12 Notes on Nondeterminism and Side Effects (Normative)

**Treatment of Side Effects:** In this specification, side effects performed by computors are treated as a form of nondeterminism. They are NOT separately tracked or made part of the observable contract. The formal model uses outcome sets to capture all sources of variation in computor results, whether from true nondeterminism (e.g., random number generation), external state (e.g., reading current time, network calls), or side effects (e.g., logging, metrics).

**Observable Contract:** The only observable aspect of a computor is its returned value. Side effects are:
* Permitted when `hasSideEffects=true`
* Treated as contributing to the nondeterministic choice from the outcome set
* Not guaranteed to execute exactly once, at-least-once, or at-most-once
* Subject to the recomputation policy: computors are NOT invoked for up-to-date nodes (REQ-PULL-04)

**Implications for Testing:** Tests cannot observe or verify side effects directly. Tests can only assert properties about returned values. The `hasSideEffects` flag is metadata that enables certain optimizations and reasoning, but does not affect the observable behavior from a testing perspective.

---

## 2. Operational Semantics (Normative)

### 2.0 Semantic Baseline vs Optimization Requirements

**Important:** The operational semantics presented in this section describe a **baseline semantics** that defines the observable input/output behavior of the incremental graph system.

**Relationship:** An implementation is correct if:
1. Its observable behavior matches the baseline semantics (properties PROP-01, PROP-02, PROP-03, PROP-04)
2. It satisfies all additional normative requirements not captured by PROP-01..04

### 2.1 pull(nodeName, bindings) → NodeValue

**Signature:** `pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<ComputedValue>`

**Big-Step Semantics:**

```javascript
pull(nodeName, bindings):
  nodeKey = createNodeKey(nodeName, bindings)
  if isUpToDate(nodeKey): return stored_value(nodeKey)
  inputs_instances = instantiate_inputs(nodeKey)
  inputs_values = [pull(I_nodeName, I_bindings) for I in inputs_instances]
  old_value = stored_value(nodeKey)
  r ∈ Outcomes(nodeName, bindings, inputs_values, old_value)  // nondeterministic choice
  store(nodeKey, r)
  return r
```

**Note:** This pseudocode describes the abstract input-output semantics using nondeterministic choice from outcome sets. It deliberately omits many essential details.

**REQ-PULL-01:** `pull` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-PULL-02:** `pull` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema for the given nodeName.

**REQ-PULL-03:** `pull` MUST ensure each computor is invoked at most once per top-level call for each unique node instance (property PROP-03).

**REQ-PULL-04 (No spurious recomputation):** If a materialized node instance is `up-to-date` at the time it is encountered during a `pull()`, the implementation MUST return its stored value and MUST NOT invoke its computor. This makes `pull()` use call-by-need semantics and prevents repeated effects/resampling for up-to-date nodes.

**Efficiency Optimization (Implementation-Defined):**

Implementations MAY use any strategy to achieve property PROP-03 (e.g., memoization, freshness checks, in-flight tracking). The specific mechanism is not prescribed.

### 2.2 invalidate(nodeName, bindings)

**Signature:** `invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>`

**Effects:**
1. Create `NodeKey` from `nodeName@bindings`
2. Mark that node instance as `potentially-outdated`
3. Mark all materialized transitive dependents as `potentially-outdated`

**Important:** `invalidate()` does NOT write a value. Values are provided by computors when nodes are pulled.

**REQ-INV-01:** `invalidate` MUST return a `Promise<void>`.

**REQ-INV-02:** `invalidate` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-INV-03:** `invalidate` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema.

**REQ-INV-04:** Only dependents that have been previously materialized (pulled or invalidated) are marked outdated. Unmaterialized node instances remain unmaterialized.

### 2.3 Unchanged Propagation Optimization

**Note:** The rules in this section describe an **optimization mechanism** using the `Unchanged` sentinel. `Unchanged` is not part of the semantic outcome set—it is purely an implementation optimization for avoiding unnecessary storage writes and enabling efficient propagation of unchanged values.

**REQ-UNCH-01:** When a computor returns `Unchanged`:
1. Node's value MUST NOT be updated (keeps old value)
2. Node MUST be marked `up-to-date`
3. The stored value must remain a valid `ComputedValue` (never the sentinel itself)

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

**REQ-FACTORY-03:** MUST reject schemas where the same functor appears with different arities (throw `SchemaArityConflictError`).

### 3.2 IncrementalGraph Interface

```typescript
interface IncrementalGraph {
  pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<ComputedValue>;
  invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>;
  
  // Debug interface (REQUIRED)
  debugGetFreshness(nodeName: NodeName, bindings?: BindingEnvironment): Promise<"up-to-date" | "potentially-outdated" | "missing">;
  debugListMaterializedNodes(): Promise<Array<[NodeName, BindingEnvironment]>>;
  debugGetSchemaHash(): string;
}
```

**REQ-IFACE-01:** Implementations MUST provide type guard `isIncrementalGraph(value): boolean`.

**REQ-IFACE-02:** For atom-expressions (arity 0), `bindings` parameter defaults to `[]` and may be omitted.

**REQ-IFACE-03:** For compound-expressions (arity > 0), `bindings` MUST be provided with length matching the expression arity.

**REQ-IFACE-04:** Implementations MUST provide the debug interface methods:
* `debugGetFreshness(nodeName, bindings?)` — Returns the freshness state of a specific node instance. Returns `"missing"` for unmaterialized nodes.
* `debugListMaterializedNodes()` — Returns an array of tuples `[NodeName, BindingEnvironment]` for all materialized node instances.
* `debugGetSchemaHash()` — Returns the schema identifier used for storage namespacing.

### 3.3 Database Interfaces

#### GenericDatabase<TValue>

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

**REQ-DB-01:** Values MUST preserve deep equality across storage operations. That is, if value `v` is stored and later retrieved as `v'`, then `isEqual(v, v')` MUST be `true`.

**REQ-DB-02:** The type parameter `TValue` is consistently used throughout all method signatures to ensure type safety.

**Note on Storage:** Internal storage organization (including how values, freshness, dependencies, and reverse dependencies are stored) is implementation-defined and not exposed in the public interface. Implementations MAY choose any internal representation for storing values as long as REQ-DB-01 (deep equality preservation) is satisfied.

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
  inputs: Array<ComputedValue>,
  oldValue: ComputedValue | undefined,
  bindings: Array<ConstValue>
) => Promise<ComputedValue | Unchanged>;
```

**Note on Return Type:** Computors MAY return `Unchanged` as an optimization sentinel. However, `Unchanged` is NOT part of the semantic `Outcomes` set (see §1.1). When a computor returns `Unchanged`, it is semantically equivalent to returning the current stored value (which must be a `ComputedValue`). The `pull()` operation always returns `Promise<ComputedValue>` — the `Unchanged` sentinel is handled internally and never exposed to callers.

**REQ-COMP-01A (Conditional Determinism):** If `NodeDef.isDeterministic` is `true`, the computor MUST be treated as deterministic with respect to `(nodeName, bindings, inputs, oldValue)`. Formally, `Outcomes(nodeName, bindings, inputs, oldValue)` (per DEF-OUTCOMES-01) MUST always be a singleton set.

**REQ-COMP-02A (Conditional Purity):** If `NodeDef.hasSideEffects` is `false`, the computor MUST be treated as one that does not have observable side effects.

**REQ-COMP-03 (Unchanged Return):** Computors MAY return `Unchanged` sentinel to indicate no value change.

**REQ-COMP-04 (Unchanged API):** Implementations MUST expose `makeUnchanged()` factory and `isUnchanged(value)` type guard.

**REQ-COMP-05 (Binding Parameter):** The `bindings` parameter is a positional array matching the schema output pattern's arguments by position. For example, if the output pattern is `full_event(e)`, then `bindings[0]` contains the value for the first argument position, `e`.

### 3.5 Error Taxonomy

**REQ-ERR-00 (Error Properties):** All errors MUST provide a stable `.name` property and the required fields specified in the table below.

| Error Name | Required Fields | Thrown When |
|------------|----------------|-------------|
| `InvalidExpressionError` | `expression: string` | Invalid expression syntax (schema parsing) |
| `InvalidNodeError` | `nodeName: string` | No schema matches the given nodeName (public API) |
| `InvalidNodeNameError` | `nodeName: string` | nodeName is not a valid `ident` (public API) |
| `SchemaOverlapError` | `patterns: Array<string>` | Overlapping output patterns at init (schema validation) |
| `InvalidSchemaError` | `schemaPattern: string` | Schema definition problems at init (schema validation) |
| `InvalidNodeDefError` | `index: number, field: string` | nodeDefs entry has invalid shape/type (schema validation) |
| `SchemaCycleError` | `cycle: Array<string>` | Cyclic schema dependencies at init (schema validation) |
| `ArityMismatchError` | `nodeName: string, expectedArity: number, actualArity: number` | Bindings array length does not match node arity (public API) |
| `SchemaArityConflictError` | `nodeName: string, arities: Array<number>` | Same functor with different arities in schema (schema validation) |
| `InvalidUnchangedError` | `nodeKey: string` | Computor returned `Unchanged` when oldValue is `undefined` (internal) |

**REQ-ERR-01 (Error Type Guards):** All error types MUST provide type guard functions (e.g., `isInvalidExpressionError(value: unknown): value is InvalidExpressionError`).

---

## 4. Persistence (Normative)

### 4.1 Behavioral Equivalence Across Restarts

**REQ-PERSIST-01 (Observable Equivalence):** Given the same `RootDatabase` and schema, the observable behavior of the incremental graph MUST be identical whether or not a shutdown/restart occurred between any two operations.

Formally: For any sequence of operations `Op₁, Op₂, ..., Opₙ` where each `Opᵢ` is either `pull(nodeName, bindings)` or `invalidate(nodeName, bindings)`, the following two executions MUST produce observably equivalent results:

1. **Without restart:** Execute `Op₁, Op₂, ..., Opₙ` consecutively
2. **With restart:** Execute `Op₁, Op₂, ..., Opₖ`, then shutdown and restart the graph with the same `RootDatabase` and schema, then execute `Opₖ₊₁, ..., Opₙ`

**Observable equivalence** means:
* All `pull()` calls return equal values (according to `isEqual`)
* All `invalidate()` calls have the same effect on subsequent operations

**REQ-PERSIST-02:** Implementations MAY use any persistence strategy (storing values, freshness markers, dependency graphs, etc.) as long as REQ-PERSIST-01 is satisfied. The specific mechanism is implementation-defined.

### 4.2 Invariants

**INV-01 (Outdated Propagation):** If node instance `N@B` is `potentially-outdated`, all transitive dependents of `N@B` that have been previously materialized (pulled or invalidated) are also `potentially-outdated`.

**INV-02 (Up-to-Date Upstream):** If node instance `N@B` is `up-to-date`, all transitive dependencies of `N@B` are also `up-to-date`.

**INV-03 (Value Admissibility):** If node instance `N@B` is `up-to-date`, then letting `inputs_values` be the stored values of its instantiated input node instances, the stored value `v` of `N@B` must satisfy:
* there exists some `oldValue` such that `v ∈ Outcomes(N, B, inputs_values, oldValue)` (per DEF-OUTCOMES-01).

This invariant uses an existential quantifier over `oldValue` to avoid requiring storage of the previous value. All nodes, including source nodes, satisfy INV-03 the same way: their stored value must be consistent with their computor's `Outcomes(...)` set.

### 4.3 Correctness Properties

**REQ-CORR-01 (Correctness Requirements):** Implementations MUST satisfy properties PROP-01, PROP-02, PROP-03, and PROP-04.

**PROP-01 (Soundness under nondeterminism):** For any `pull(nodeName, B)` that returns value `v`, `v` is a value permitted by the nondeterministic big-step semantics. That is, there exists a derivation where all computor invocations choose elements from their `Outcomes(...)` sets and the final returned value is `v`.

**PROP-01A (Deterministic specialization, corollary):** If all computors reachable from node instance `N@B` have `isDeterministic=true` and `hasSideEffects=false`, then PROP-01 strengthens to: `pull(N, B)` produces the same result as recomputing all values from scratch with the same input values. This recovers the traditional semantic equivalence property for the deterministic and pure subset of computors.

**PROP-02 (Progress):** Every `pull(N, B)` call terminates (assuming computors terminate).

**PROP-03 (Single Invocation):** Each computor invoked at most once per top-level `pull()` for each unique node instance.

**PROP-04 (Freshness Preservation):** After `pull(N, B)`, the node instance `N@B` and all transitive dependencies are `up-to-date`.

---

## 5. Concurrency (Normative)

**REQ-CONCUR-01 (Sequential Consistency):** All `pull()` and `invalidate()` operations MUST behave as if they were executed in some sequential order, even when invoked concurrently.

Formally: For any concurrent execution with operations `{Op₁, Op₂, ..., Opₙ}`, there MUST exist a sequential ordering `Opₚ₍₁₎, Opₚ₍₂₎, ..., Opₚ₍ₙ₎` (where `p` is a permutation) such that the observable results are identical to executing the operations in that sequential order.

**REQ-CONCUR-02:** The observable state of the graph (values, freshness, materialization) MUST be consistent with some sequential execution at all times. No operation may observe partial state from another concurrent operation.

**Note:** Implementations MAY use any concurrency control mechanism to achieve these requirements. The specific strategy (locks, transactions, queuing, etc.) is implementation-defined.
