# Specification for the Dependency Graph

This document provides a formal specification for the dependency graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

* **NodeName** — unique identifier for a concrete node (fully instantiated expression)
* **NodeValue** — computed value at a node (arbitrary `DatabaseValue`)
* **Freshness** — conceptual state: `"up-to-date" | "potentially-outdated"`
* **Computor** — deterministic async function: `(inputs: DatabaseValue[], oldValue: DatabaseValue | undefined, bindings: Record<string, DatabaseValue>) => Promise<DatabaseValue | Unchanged>`
* **Unchanged** — unique sentinel value indicating unchanged computation result. MUST NOT be a valid `DatabaseValue` (cannot be stored via `set()` or returned by `pull()`).
* **Variable** — parameter placeholder in node schemas (identifiers in argument positions)
* **DatabaseValue** — any JavaScript `object` (including subtypes like arrays, but excluding `null`). MUST NOT include the `Unchanged` sentinel. MUST round-trip through database interfaces without semantic change.
* **BindingEnvironment** — a mapping from variable names to concrete values: `Record<string, DatabaseValue>`. Used to instantiate a specific node from an expression pattern.

### 1.2 Expressions as an Infinite Graph (Normative)

This section establishes the fundamental mental model for understanding how expressions denote infinite families of nodes and how the dependency graph operates over this infinite space using a finite schema.

#### 1.2.1 Expressions Denote Node Families

An **expression** is a symbolic template that denotes a (possibly infinite) family of nodes. The expression defines the structure, while variable bindings select a specific member of that family.

**Components:**
* The **head** (or **functor**) of an expression is its identifier—the name that categorizes the family.
* The **arguments** are variable positions that can be assigned concrete `DatabaseValue` instances at runtime.

**Examples:**

* `all_events` — An atom expression with no variables. Denotes exactly one node (a family of size 1).
* `full_event(e)` — Denotes the infinite family `{ full_event(e=v) | v ∈ DatabaseValue }`.
  - Each distinct `DatabaseValue` for `e` identifies a different member of this family.
* `enhanced_event(e, p)` — Denotes `{ enhanced_event(e=v₁, p=v₂) | v₁, v₂ ∈ DatabaseValue }`.
  - The Cartesian product of all possible values for `e` and `p` forms this family.

#### 1.2.2 Node Instances (Addresses Within Families)

A **node instance** is a specific member of a node family, identified by:
1. An expression pattern (e.g., `full_event(e)`)
2. A binding environment B: `Record<string, DatabaseValue>` that assigns concrete values to all variables in the expression

**Notation:** We write `expr@B` to denote a node instance, where:
* `expr` is the expression pattern
* `B` is the binding environment

**Examples:**

* `full_event(e)` with `B = { e: {id: "evt_123"} }` identifies the specific node `full_event(e={id: "evt_123"})`.
* `enhanced_event(e, p)` with `B = { e: {id: "evt_123"}, p: {id: "photo_456"} }` identifies one specific enhanced event.

**Identity:** Two node instances are identical if and only if:
1. Their expression patterns are syntactically identical (after canonicalization), AND
2. Their binding environments are structurally equal (deep equality on `DatabaseValue` objects)

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

This means: **For every binding environment B**, the node instance `full_event(e)@B` depends on:
* `event_data(e)@B` (same bindings)
* `metadata(e)@B` (same bindings)

The schema implicitly defines infinitely many dependency edges—one set for each possible binding environment.

#### 1.2.4 Public Interface: Addressing Nodes

The public API requires both the pattern and bindings to address a specific node:

* `pull(nodeName, bindings)` — Evaluates the node instance identified by pattern `nodeName` and binding environment `bindings`
* `set(nodeName, value, bindings)` — Stores `value` at the node instance identified by `nodeName` and `bindings`

**For atom expressions** (expressions with no arguments like `all_events`):
* The binding environment is empty: `{}`
* The pattern alone identifies exactly one node
* `pull("all_events", {})` and `pull("all_events")` are equivalent

**For compound expressions** (expressions with arguments like `full_event(e)`):
* Bindings MUST provide values for all variables
* Different bindings address different node instances
* `pull("full_event(e)", {e: {id: "123"}})` and `pull("full_event(e)", {e: {id: "456"}})` address distinct nodes

### 1.3 Expression Grammar (Normative)

**REQ-EXPR-01:** All expressions MUST conform to this grammar:

```
expr          := ws atom_expr ws | ws compound_expr ws
atom_expr     := ident
compound_expr := ident ws "(" ws args ws ")"

args          := arg (ws "," ws arg)*
arg           := var
var           := ident
ident         := [A-Za-z_][A-Za-z0-9_]*
ws            := [ \t\n\r]*
```

**Terminology:**
* **atom-expression** — an expression with no arguments (e.g., `all_events`). Denotes a family of exactly one node.
* **compound-expression** — an expression with one or more arguments (e.g., `event_context(e)`, `enhanced_event(e, p)`). Each argument is a variable. Denotes an infinite family of nodes.
* **variable** — an identifier in an argument position; represents a parameter that can be bound to any `DatabaseValue`
* **pattern** — an expression used in a schema definition to describe a family of nodes
* **free variables** — all variables (identifiers occurring in argument positions) in an expression

**Examples:**
* `all_events` — atom-expression with zero variables; denotes a singleton family
* `event_context(e)` — compound-expression with one variable `e`; denotes an infinite family indexed by values of `e`
* `enhanced_event(e, p)` — compound-expression with two variables `e` and `p`; denotes an infinite family indexed by pairs of values

### 1.4 Canonical Serialization (Normative)

**REQ-CANON-01:** The function `serialize(expr)` MUST produce a unique canonical string:

1. No whitespace is included
2. Arguments joined by commas with no spaces
3. Atom-expressions: just the identifier
4. Compound-expressions: `name(arg1,arg2,...)`

**REQ-CANON-02:** Round-trip requirement:
* `parse(serialize(ast))` MUST equal `ast` (modulo whitespace)
* `serialize(parse(s))` MUST canonicalize `s`

**Examples:**
* `all_events` → `"all_events"`
* `event_context(e)` → `"event_context(e)"`
* `enhanced_event(e, p)` → `"enhanced_event(e,p)"`

**REQ-CANON-03:** All node names used as database keys MUST use canonical serialization combined with binding information.

**REQ-CANON-04:** `pull(nodeName, bindings)` and `set(nodeName, value, bindings)` MUST accept any valid expression string and canonicalize it before processing.

### 1.5 Schema Definition (Normative)

**REQ-SCHEMA-01:** A dependency graph is defined by a set of node schemas:

```typescript
type NodeDef = {
  output: string;     // Expression pattern (may contain variables)
  inputs: string[];   // Dependency expression patterns
  computor: Computor; // Computation function
};
```

**REQ-SCHEMA-02:** Variables in `output` MUST be a superset of all variables in `inputs` (Variable Scope Rule 1).

**REQ-SCHEMA-03:** A **source node** is any node instance matching a schema where `inputs = []`. Source nodes have no dependencies and their values are set explicitly via `set()`.

**Pattern Instantiation:** When evaluating a node instance `output@B`:
1. Each input pattern `input_i` is instantiated with the same binding environment `B`
2. The computor receives the values of all instantiated input nodes
3. The computor receives `B` as its third parameter for reference

### 1.6 Pattern Matching (Normative)

**REQ-MATCH-01:** A schema output pattern `P` **matches** an expression `E` if and only if:
1. `P` and `E` have the same functor (head identifier), AND
2. `P` and `E` have the same arity (number of arguments)

**REQ-MATCH-02:** Two output patterns **overlap** if they have the same functor and the same arity.

**REQ-MATCH-03:** The system MUST reject graphs with overlapping output patterns at initialization (throw `SchemaOverlapError`).

**Note on Matching:** Pattern matching is purely structural and does not consider variable names or binding values. The pattern `full_event(e)` matches any expression of the form `full_event(x)` regardless of the variable name used.

### 1.7 Cycle Detection (Normative)

**REQ-CYCLE-01:** A directed edge exists from Schema S to Schema T if:
1. S has input pattern I
2. T has output pattern O
3. Patterns I and O match (same functor and arity)

**REQ-CYCLE-02:** The system MUST reject graphs with cycles at initialization (throw `SchemaCycleError`).

### 1.8 Materialization (Normative)

**REQ-MAT-01:** A **materialized node** is any node instance for which the implementation maintains dependency tracking and freshness state.

**REQ-MAT-02:** Materialization occurs through:
* `pull(nodeName, bindings)` — creates node instance with dependencies, stores value, marks `up-to-date`
* `set(nodeName, value, bindings)` — materializes source node instance, marks `up-to-date`

**REQ-MAT-03:** Unmaterialized node instances have no freshness state (`undefined` in `SchemaStorage.freshness`).

---

## 2. Operational Semantics (Normative)

### 2.1 pull(nodeName, bindings) → NodeValue

**Signature:** `pull(nodeName: string, bindings?: Record<string, DatabaseValue>): Promise<DatabaseValue>`

**Preconditions:**
* `nodeName` MUST be a valid expression pattern
* `bindings` MUST provide `DatabaseValue` for all variables in `nodeName`
* A matching schema pattern MUST exist

**Big-Step Semantics (Correctness Specification):**

```
pull(N, B):
  pattern = canonicalize(N)
  inputs_values = [pull(I, B) for I in inputs_of(pattern)]
  old_value = stored_value(pattern@B)
  new_value = computor_of(pattern)(inputs_values, old_value, B)
  if new_value ≠ Unchanged:
    store(pattern@B, new_value)
  mark_up_to_date(pattern@B)
  return stored_value(pattern@B)
```

**REQ-PULL-01:** `pull` MUST return a `Promise<DatabaseValue>`.

**REQ-PULL-02:** `pull` MUST throw `InvalidNodeError` if no schema pattern matches `nodeName`.

**REQ-PULL-03:** `pull` MUST throw an error if `bindings` does not provide values for all variables in `nodeName`.

**REQ-PULL-04:** `pull` MUST ensure each computor is invoked at most once per top-level call for each unique node instance (property P3).

**REQ-PULL-05:** Lazy instantiation: When pulling a node instance, the system:
1. Searches for matching schema pattern
2. Uses the provided binding environment `B`
3. Instantiates all input expressions by applying `B` to produce input node instances
4. Recursively pulls all input node instances (with the same bindings where variables overlap)
5. Creates materialized node instance on-demand with instantiated dependencies
6. Persists materialization marker for restart resilience

**Efficiency Optimization (Implementation-Defined):**

Implementations MAY use any strategy to achieve property P3 (e.g., memoization, freshness checks, in-flight tracking). The specific mechanism is not prescribed.

### 2.2 set(nodeName, value, bindings)

**Signature:** `set(nodeName: string, value: DatabaseValue, bindings?: Record<string, DatabaseValue>): Promise<void>`

**Preconditions:**
* `nodeName` MUST be a valid expression pattern
* `bindings` MUST provide `DatabaseValue` for all variables in `nodeName`
* `nodeName` MUST match a schema (throw `InvalidNodeError` otherwise)
* `nodeName` MUST match a source node schema (throw `InvalidSetError` if not)

**Effects:**
1. Store `value` at the node instance identified by `nodeName@bindings`
2. Mark that node instance as `up-to-date`
3. Mark all **materialized** transitive dependents as `potentially-outdated`

**REQ-SET-01:** `set` MUST return a `Promise<void>`.

**REQ-SET-02:** `set` MUST throw `InvalidNodeError` if no schema pattern matches `nodeName`.

**REQ-SET-03:** `set` MUST throw an error if `bindings` does not provide values for all variables in `nodeName`.

**REQ-SET-04:** `set` MUST throw `InvalidSetError` if the matching schema is not a source node (has non-empty `inputs`).

**REQ-SET-05:** All operations MUST be executed atomically in a single database batch.

**REQ-SET-06:** Only dependents that have been previously materialized (pulled) are marked outdated. Unmaterialized node instances remain unmaterialized.

### 2.3 Unchanged Propagation Optimization

**REQ-UNCH-01:** When a computor returns `Unchanged`:
1. Node's value MUST NOT be updated (keeps old value)
2. Node MUST be marked `up-to-date`

**REQ-UNCH-02:** An implementation MAY mark dependent D `up-to-date` without recomputing **if and only if** it can prove D's value would be unchanged given current input values.

---

## 3. Required Interfaces (Normative)

### 3.1 Factory Function

```typescript
function makeDependencyGraph(
  rootDatabase: RootDatabase,
  nodeDefs: NodeDef[]
): DependencyGraph;
```

**REQ-FACTORY-01:** MUST validate all schemas at construction (throw on parse errors, scope violations, overlaps, cycles).

**REQ-FACTORY-02:** MUST compute schema identifier and obtain schema-namespaced storage via `rootDatabase.getSchemaStorage(schemaId)`.

**REQ-FACTORY-03:** MUST NOT mutate `nodeDefs` or `rootDatabase`.

### 3.2 DependencyGraph Interface

```typescript
interface DependencyGraph {
  pull(nodeName: string, bindings?: Record<string, DatabaseValue>): Promise<DatabaseValue>;
  set(nodeName: string, value: DatabaseValue, bindings?: Record<string, DatabaseValue>): Promise<void>;
  getStorage(): SchemaStorage;
}
```

**REQ-IFACE-01:** Implementations MUST provide type guard `isDependencyGraph(value): boolean`.

**REQ-IFACE-02:** `getStorage()` MUST return the `SchemaStorage` instance for the graph.

**REQ-IFACE-03:** For atom-expressions (no variables), `bindings` parameter defaults to `{}` and may be omitted.

**REQ-IFACE-04:** For compound-expressions (with variables), `bindings` MUST be provided with values for all variables.

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

#### SchemaStorage

```typescript
interface SchemaStorage {
  values: GenericDatabase<DatabaseValue>;      // Node output values
  freshness: GenericDatabase<Freshness>;       // Node freshness state
  inputs: GenericDatabase<InputsRecord>;       // Node input dependencies
  revdeps: GenericDatabase<1>;                 // Reverse dependency edges
  batch(operations: DatabaseBatchOperation[]): Promise<void>;
}

type InputsRecord = { inputs: string[] };
```

**REQ-STORAGE-01:** `values` MUST store node values keyed by canonical node name.

**REQ-STORAGE-02:** `freshness` MUST store conceptual freshness (`"up-to-date" | "potentially-outdated"`) keyed by canonical node name.

**REQ-STORAGE-03:** `inputs` MUST store dependency arrays keyed by canonical node name.

**REQ-STORAGE-04:** `revdeps` MUST support querying dependents of a node (specific key format is implementation-defined).

**REQ-STORAGE-05:** `batch()` MUST execute operations atomically (all-or-nothing).

#### RootDatabase

```typescript
interface RootDatabase {
  getSchemaStorage(schemaId: string): SchemaStorage;
  listSchemas(): AsyncIterable<string>;
  close(): Promise<void>;
}
```

**REQ-ROOT-01:** `getSchemaStorage()` MUST return isolated storage per schema identifier.

**REQ-ROOT-02:** Different schema identifiers MUST NOT share storage or cause key collisions.

### 3.4 Computor Signature

```typescript
type Computor = (
  inputs: DatabaseValue[],
  oldValue: DatabaseValue | undefined,
  bindings: Record<string, DatabaseValue>
) => Promise<DatabaseValue | Unchanged>;
```

**REQ-COMP-01:** Computors MUST be deterministic with respect to `(inputs, oldValue, bindings)`.

**REQ-COMP-02:** Computors MUST NOT have hidden side effects affecting output.

**REQ-COMP-03:** Computors MAY return `Unchanged` sentinel to indicate no value change.

**REQ-COMP-04:** Implementations MUST expose `makeUnchanged()` factory and `isUnchanged(value)` type guard.

### 3.5 Error Taxonomy

All errors MUST provide stable `.name` property and required fields:

| Error Name | Required Fields | Thrown When |
|------------|----------------|-------------|
| `InvalidExpressionError` | `expression: string` | Invalid expression syntax |
| `InvalidNodeError` | `nodeName: string` | No schema matches the node pattern |
| `InvalidSetError` | `nodeName: string` | Node is not a source node |
| `SchemaOverlapError` | `patterns: string[]` | Overlapping output patterns at init |
| `InvalidSchemaError` | `schemaOutput: string` | Schema definition problems at init |
| `SchemaCycleError` | `cycle: string[]` | Cyclic schema dependencies at init |
| `MissingValueError` | `nodeName: string` | Up-to-date node has no stored value |
| `MissingBindingsError` | `nodeName: string, missingVars: string[]` | Required bindings not provided for variables |

**REQ-ERR-01:** All error types MUST provide type guard functions (e.g., `isInvalidExpressionError(value): boolean`).

**Note:** The `NonConcreteNodeError` from earlier versions has been removed. Instead, missing bindings result in `MissingBindingsError`.

---

## 4. Persistence & Materialization (Normative)

### 4.1 Materialization Markers

**REQ-PERSIST-01:** Implementations MUST persist sufficient markers to reconstruct materialized node instance set after restart.

**REQ-PERSIST-02:** If node instance `N@B` was materialized before restart, then after restart (same `RootDatabase`, same schema):
* `set(source, v, bindings)` MUST mark all previously materialized transitive dependents as `potentially-outdated`
* This MUST occur WITHOUT requiring re-pull

**REQ-PERSIST-03:** The specific persistence mechanism (metadata keys, reverse index, etc.) is implementation-defined.

### 4.2 Invariants

The graph MUST maintain these invariants for all materialized node instances:

**I1 (Outdated Propagation):** If materialized node instance `N@B` is `potentially-outdated`, all materialized transitive dependents are also `potentially-outdated`.

**I2 (Up-to-Date Upstream):** If materialized node instance `N@B` is `up-to-date`, all materialized transitive dependencies are also `up-to-date`.

**I3 (Value Consistency):** If materialized node instance `N@B` is `up-to-date`, its value equals what would be computed by recursively evaluating dependencies and applying computor.

### 4.3 Correctness Properties

**P1 (Semantic Equivalence):** `pull(N, B)` produces same result as recomputing from scratch.

**P2 (Progress):** Every `pull(N, B)` call terminates (assuming computors terminate).

**P3 (Single Invocation):** Each computor invoked at most once per top-level `pull()` for each unique node instance.

**P4 (Freshness Preservation):** After `pull(N, B)`, the node instance `N@B` and all transitive dependencies are `up-to-date`.

---

## 5. Test-Visible Contract (Normative)

This section defines exactly what conformance tests MAY assert. All other implementation details are internal and subject to change.

### 5.1 Public API

Tests MAY assert the existence and signatures of:

* `makeDependencyGraph(rootDatabase: RootDatabase, nodeDefs: NodeDef[]): DependencyGraph` — Factory function
* `DependencyGraph.pull(nodeName: string, bindings?: Record<string, DatabaseValue>): Promise<DatabaseValue>` — Retrieve/compute node value
* `DependencyGraph.set(nodeName: string, value: DatabaseValue, bindings?: Record<string, DatabaseValue>): Promise<void>` — Write source node value
* `DependencyGraph.getStorage(): SchemaStorage` — Access schema storage for testing
* `isDependencyGraph(value): boolean` — Type guard

### 5.2 Observable Error Taxonomy

Tests MAY assert error names (via `.name` property) and required fields (see section 3.5 for complete taxonomy).

### 5.3 Canonicalization Requirement

Tests MAY assert:
* Whitespace normalization in expressions
* See REQ-CANON-03 and REQ-CANON-04 in section 1.3

### 5.4 Freshness Observability

**REQ-FRESH-01:** Implementations MUST expose the conceptual freshness state via `SchemaStorage.freshness`:

* `"up-to-date"` — Node value is consistent with dependencies
* `"potentially-outdated"` — Node may need recomputation
* `undefined` — Node is not materialized

Tests MAY assert freshness state via `schemaStorage.freshness.get(canonicalNodeName)`.

**REQ-FRESH-02:** Internal freshness tracking mechanisms (versions, epochs, etc.) are implementation-defined and NOT observable to tests.

### 5.5 Restart Resilience

**REQ-RESTART-01:** Materialized node instances MUST remain materialized across graph restarts (same `RootDatabase`, same schema).

**REQ-RESTART-02:** After restart, `set(source, value, bindings)` MUST invalidate all previously materialized transitive dependents WITHOUT requiring re-pull.

Tests MAY assert:
* Pull a node instance, restart graph instance, call `set()` on upstream source with appropriate bindings, verify downstream node instance is marked `potentially-outdated`

### 5.6 Behavioral Guarantees

**REQ-BEHAVE-01 = P1** (see §4.3): `pull(N, B)` MUST produce the same result as recomputing all values from scratch (Semantic Equivalence).

**REQ-BEHAVE-02 = P3** (see §4.3): Each computor MUST be invoked at most once per top-level `pull()` call for each unique node instance (Single Invocation).

**REQ-BEHAVE-03 = P4** (see §4.3): After `pull(N, B)` completes, node instance `N@B` and all its transitive dependencies MUST be marked `up-to-date` (Freshness Preservation).

---

## 6. Appendices (Non-Normative)

### Appendix A: Examples

#### A.1 Simple Linear Chain

**Schema:**
```javascript
[
  { output: "all_events", inputs: [], 
    computor: async ([], old) => old || { events: [] } },
  { output: "meta_events", inputs: ["all_events"], 
    computor: async ([all]) => extractMeta(all) },
  { output: "event_context(e)", inputs: ["meta_events"], 
    computor: async ([meta], old, {e}) => meta.find(ev => ev.id === e.id) }
]
```

**Operations:**
```javascript
// Set source (atom expression, no bindings needed)
await graph.set('all_events', {events: [{id: 'evt_123', data: '...'}]});

// Pull derived atom expression
const meta = await graph.pull('meta_events');

// Pull parameterized node with bindings
const context = await graph.pull('event_context(e)', { e: {id: 'evt_123'} });
```

**How it works:**
* `all_events` is an atom expression—it denotes a single node
* `event_context(e)` is a compound expression—it denotes an infinite family
* Calling `pull('event_context(e)', {e: {id: 'evt_123'}})` selects one specific member of that family
* Different bindings create different node instances: `event_context(e)@{e:{id:'evt_123'}}` vs `event_context(e)@{e:{id:'evt_456'}}`

#### A.2 Multiple Parameters

```javascript
[
  { output: "all_events", inputs: [], 
    computor: async ([], old) => old },
  { output: "photo_storage", inputs: [],
    computor: async ([], old) => old },
  { output: "event_context(e)", inputs: ["all_events"],
    computor: async ([all], _, {e}) => all.events.find(ev => ev.id === e.id) },
  { output: "photo(p)", inputs: ["photo_storage"],
    computor: async ([storage], _, {p}) => storage.photos[p.id] },
  { output: "enhanced_event(e, p)", 
    inputs: ["event_context(e)", "photo(p)"],
    computor: async ([ctx, photo], _, {e, p}) => ({...ctx, photo}) }
]
```

**Operations:**
```javascript
// Set sources
await graph.set('all_events', {events: [{id: 'evt_123'}]});
await graph.set('photo_storage', {photos: {'photo_456': {url: '...'}}});

// Pull with multiple bindings
const enhanced = await graph.pull('enhanced_event(e, p)', {
  e: {id: 'evt_123'},
  p: {id: 'photo_456'}
});
```

**How it works:**
* `enhanced_event(e, p)` denotes the Cartesian product of all possible event and photo values
* The schema declares: for any bindings `B`, `enhanced_event(e,p)@B` depends on `event_context(e)@B` and `photo(p)@B`
* When we pull with `{e: {id: 'evt_123'}, p: {id: 'photo_456'}}`, the system instantiates both dependencies with the same bindings

#### A.3 Variable Sharing

```javascript
[
  { output: "event_data", inputs: [],
    computor: async ([], old) => old },
  { output: "status(e)", inputs: ["event_data"],
    computor: async ([data], _, {e}) => data.statuses[e.id] },
  { output: "metadata(e)", inputs: ["event_data"],
    computor: async ([data], _, {e}) => data.metadata[e.id] },
  { output: "full_event(e)", 
    inputs: ["status(e)", "metadata(e)"],
    computor: async ([status, meta], _, {e}) => ({id: e.id, status, meta}) }
]
```

**Operations:**
```javascript
await graph.set('event_data', {
  statuses: {'evt_123': 'active'},
  metadata: {'evt_123': {created: '2024-01-01'}}
});

// Pull with shared variable binding
const fullEvent = await graph.pull('full_event(e)', {e: {id: 'evt_123'}});
// Result: {id: 'evt_123', status: 'active', meta: {created: '2024-01-01'}}
```

**How it works:**
* All three parameterized expressions share the same variable `e`
* When pulling `full_event(e)@{e:{id:'evt_123'}}`, both dependencies are instantiated with the same binding
* The binding propagates through the entire dependency chain, ensuring consistency

### Appendix B: Recommended Storage Architecture

This section describes the reference implementation's storage design. Implementations MAY use different designs as long as they satisfy the normative requirements.

#### B.1 Recommended Reverse Dependency Storage

**Edge-Based Storage:** Store each reverse dependency as a separate key:

* **Key format:** `"${inputNode}\x00${dependentNode}"`
* **Value:** Constant `1`

**Benefits:**
* Efficient iteration without deserializing arrays
* Incremental updates (add edge without reading full array)
* Scales better for high fan-out nodes

**Alternative:** Implementations MAY use adjacency lists (`inputNode -> [dependent1, dependent2, ...]`) if preferred.

#### B.2 Recommended Schema Identifier Algorithm

**Algorithm:**
```javascript
const schemaRepresentation = compiledNodes
  .map(node => ({
    output: node.canonicalOutput,
    inputs: node.canonicalInputs,
  }))
  .sort((a, b) => a.output.localeCompare(b.output));

const schemaJson = JSON.stringify(schemaRepresentation);
const schemaId = crypto.createHash("md5")
  .update(schemaJson)
  .digest("hex")
  .substring(0, 16);
```

**Purpose:** Ensures graphs with identical schemas share storage; different schemas are isolated.

**Alternative:** Implementations MAY use different algorithms (SHA-256, UUIDs, etc.) or namespacing strategies.

#### B.3 Optional GraphStorage Helper Wrapper

Implementations MAY provide a convenience wrapper extending `SchemaStorage`:

```typescript
interface GraphStorage extends SchemaStorage {
  withBatch<T>(fn: (batch: BatchBuilder) => Promise<T>): Promise<T>;
  ensureMaterialized(node: string, inputs: string[], batch: BatchBuilder): Promise<void>;
  ensureReverseDepsIndexed(node: string, inputs: string[], batch: BatchBuilder): Promise<void>;
  listDependents(input: string): Promise<string[]>;
  getInputs(node: string): Promise<string[] | null>;
  listMaterializedNodes(): Promise<string[]>;
}
```

This is non-normative and not required for conformance.

### Appendix C: Optional Debug Interface

For testing and debugging, implementations MAY provide:

```typescript
interface DependencyGraphDebug {
  debugGetFreshness(nodeName: string): Promise<"up-to-date" | "potentially-outdated" | "missing">;
  debugListMaterializedNodes(): Promise<string[]>;
}
```

**Note:** `"missing"` represents `undefined` freshness (unmaterialized node).

### Appendix D: Implementation Notes

#### D.1 Batching

All database operations within a single `set()` call SHOULD be batched atomically.

Database operations during `pull()` SHOULD be batched per node recomputation.

#### D.2 Dependent Lookup Optimization

To efficiently implement invalidation, implementations SHOULD maintain a reverse dependency index allowing O(1) lookup of immediate dependents.

#### D.3 Reserved for Future Use

This section is reserved for future implementation notes.

### Appendix E: Edge Cases

#### E.1 Unmatched Pull Request

**Error:** `pull("unknown_node", {})` but no schema pattern matches.

**Behavior:** Throw `InvalidNodeError`.

#### E.2 Missing Bindings

**Error:** `pull("event_context(e)", {})` without providing required binding for `e`.

**Behavior:** Throw `MissingBindingsError` (or equivalent error indicating missing bindings).

**Example:**
```javascript
// Schema has: output: "event_context(e)"

// ❌ Wrong: Missing required binding for 'e'
await graph.pull("event_context(e)", {});

// ✅ Correct: Provide binding for all variables
await graph.pull("event_context(e)", {e: {id: 'evt_123'}});
```

#### E.3 Missing Values

If node instance is `up-to-date` but has no stored value, this is database corruption. MUST throw `MissingValueError`.

#### E.4 Atom Expressions with Bindings

**Scenario:** Providing bindings for an atom expression (no variables).

**Behavior:** Bindings are accepted but ignored. Atom expressions denote exactly one node regardless of bindings.

**Example:**
```javascript
// These are equivalent for atom expressions:
await graph.pull("all_events", {});
await graph.pull("all_events", {x: "ignored"});
await graph.pull("all_events"); // bindings default to {}
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
