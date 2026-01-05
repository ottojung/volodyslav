# Specification for the Dependency Graph

This document provides a formal specification for the dependency graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

* **NodeName** — unique identifier for a concrete node (fully instantiated expression)
* **NodeValue** — computed value at a node (arbitrary `DatabaseValue`)
* **Freshness** — conceptual state: `"up-to-date" | "potentially-outdated"`
* **Computor** — deterministic async function: `(inputs: DatabaseValue[], oldValue: DatabaseValue | undefined, bindings: DatabaseValue[]) => Promise<DatabaseValue | Unchanged>`
* **Unchanged** — unique sentinel value indicating unchanged computation result. MUST NOT be a valid `DatabaseValue` (cannot be stored via `set()` or returned by `pull()`).
* **Variable** — parameter placeholder in node schemas (identifiers in argument positions)
* **DatabaseValue** — a JSON serializable JavaScript value. MUST round-trip through database interfaces without semantic change.
* **BindingEnvironment** — a positional array of concrete values: `DatabaseValue[]`. Used to instantiate a specific node from an expression pattern. The array length MUST match the number of variables (arity) of the expression. Bindings are matched to variables by position, not by name.

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
2. A binding environment B: `DatabaseValue[]` that assigns concrete values to all argument positions in the expression

**Notation:** We write `expr@B` to denote a node instance, where:
* `expr` is the expression pattern
* `B` is the binding environment (positional array)

**Examples:**

* `full_event(e)` with `B = [{id: "evt_123"}]` identifies the specific node `full_event(e={id: "evt_123"})`.
* `enhanced_event(e, p)` with `B = [{id: "evt_123"}, {id: "photo_456"}]` identifies one specific enhanced event.
* Variable names do not affect identity: `full_event(e)@[{id: "123"}]` and `full_event(x)@[{id: "123"}]` are the same node instance.

**Identity:** Two node instances are identical if and only if:
1. Their expression patterns have the same functor and arity (after canonicalization), AND
2. Their binding environments are structurally equal (deep equality on `DatabaseValue` objects, compared positionally)

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

This means: **For every binding environment B** (a `DatabaseValue[]` of length 1), the node instance `full_event(e)@B` depends on:
* `event_data(e)@B` (same positional bindings)
* `metadata(e)@B` (same positional bindings)

The schema implicitly defines infinitely many dependency edges—one set for each possible binding environment.

**Note on Variable Names:** The variable name `e` is purely syntactic. The schemas `full_event(e)` and `full_event(x)` are functionally identical—both define an arity-1 family where the first (and only) argument position receives `bindings[0]`.

#### 1.2.4 Public Interface: Addressing Nodes

The public API requires both the pattern and bindings to address a specific node:

* `pull(nodeName, bindings)` — Evaluates the node instance identified by pattern `nodeName` and binding environment `bindings`
* `set(nodeName, value, bindings)` — Stores `value` at the node instance identified by `nodeName` and `bindings`

**For atom expressions** (expressions with no arguments like `all_events`):
* The binding environment is empty: `[]`
* The pattern alone identifies exactly one node
* `pull("all_events", [])` and `pull("all_events")` are equivalent

**For compound expressions** (expressions with arguments like `full_event(e)`):
* Bindings array length MUST match the number of arguments (arity)
* Bindings are matched to argument positions, not variable names
* Different bindings address different node instances
* `pull("full_event(e)", [{id: "123"}])` and `pull("full_event(e)", [{id: "456"}])` address distinct nodes
* `pull("full_event(e)", [{id: "123"}])` and `pull("full_event(x)", [{id: "123"}])` address the **same** node (variable names are irrelevant)

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

**REQ-CANON-04:** `pull(nodeName, bindings)` and `set(nodeName, value, bindings)` MUST accept any valid expression string and canonicalize it before processing. Canonicalization MUST NOT affect binding interpretation—bindings are always positional regardless of variable names in the expression.

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

### 1.6 Variable Name Mapping and Positional Bindings (Normative)

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

**REQ-BINDING-03:** When a user calls `pull(expr, bindings)` where `expr` uses different variable names than the matching schema output pattern:
1. The system matches by functor and arity (REQ-MATCH-01)
2. The positional bindings are used directly—no renaming occurs
3. Variable names in the user's expression are purely syntactic

**Example of Variable Name Independence:**
```javascript
// Schema: output: "full_event(e)", inputs: ["event_data(e)"]

// These calls are IDENTICAL semantically:
await graph.pull("full_event(e)", [{id: "123"}]);
await graph.pull("full_event(x)", [{id: "123"}]);
await graph.pull("full_event(my_event)", [{id: "123"}]);

// All address the same node instance because:
// - Same functor: "full_event"
// - Same arity: 1
// - Same positional bindings: [{id: "123"}] at position 0
```

**Pattern Instantiation Summary:** When evaluating a node instance `output@B`:
1. The computor receives the full output binding environment `B` as its third parameter
2. Each input pattern `input_i` is instantiated by extracting the relevant positional bindings based on variable name mapping
3. The computor receives the values of all instantiated input nodes in the order they appear in the `inputs` array

### 1.7 Pattern Matching (Normative)

**REQ-MATCH-01:** A schema output pattern `P` **matches** an expression `E` if and only if:
1. `P` and `E` have the same functor (head identifier), AND
2. `P` and `E` have the same arity (number of arguments)

**REQ-MATCH-02:** Two output patterns **overlap** if they have the same functor and the same arity.

**REQ-MATCH-03:** The system MUST reject graphs with overlapping output patterns at initialization (throw `SchemaOverlapError`).

**Note on Matching:** Pattern matching is purely structural and does not consider variable names or binding values. The pattern `full_event(e)` matches any expression of the form `full_event(x)` regardless of the variable name used. Since bindings are positional, variable names have no semantic significance—they serve only as documentation.

### 1.8 Cycle Detection (Normative)

**REQ-CYCLE-01:** A directed edge exists from Schema S to Schema T if:
1. S has input pattern I
2. T has output pattern O
3. Patterns I and O match (same functor and arity)

**REQ-CYCLE-02:** The system MUST reject graphs with cycles at initialization (throw `SchemaCycleError`).

### 1.9 Materialization (Normative)

**REQ-MAT-01:** A **materialized node** is any node instance for which the implementation maintains dependency tracking and freshness state.

**REQ-MAT-02:** Materialization occurs through:
* `pull(nodeName, bindings)` — creates node instance with dependencies, stores value, marks `up-to-date`
* `set(nodeName, value, bindings)` — materializes source node instance, marks `up-to-date`

---

## 2. Operational Semantics (Normative)

### 2.1 pull(nodeName, bindings) → NodeValue

**Signature:** `pull(nodeName: string, bindings?: DatabaseValue[]): Promise<DatabaseValue>`

**Preconditions:**
* `nodeName` MUST be a valid expression pattern
* `bindings` array length MUST match the arity (number of arguments) of `nodeName`
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

**REQ-PULL-03:** `pull` MUST throw `BindingArityMismatchError` if `bindings` array length does not match the arity of `nodeName`.

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

**Signature:** `set(nodeName: string, value: DatabaseValue, bindings?: DatabaseValue[]): Promise<void>`

**Preconditions:**
* `nodeName` MUST be a valid expression pattern
* `bindings` array length MUST match the arity (number of arguments) of `nodeName`
* `nodeName` MUST match a schema (throw `InvalidNodeError` otherwise)
* `nodeName` MUST match a source node schema (throw `InvalidSetError` if not)

**Effects:**
1. Store `value` at the node instance identified by `nodeName@bindings`
2. Mark that node instance as `up-to-date`
3. Mark all **materialized** transitive dependents as `potentially-outdated`

**REQ-SET-01:** `set` MUST return a `Promise<void>`.

**REQ-SET-02:** `set` MUST throw `InvalidNodeError` if no schema pattern matches `nodeName`.

**REQ-SET-03:** `set` MUST throw `BindingArityMismatchError` if `bindings` array length does not match the arity of `nodeName`.

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
  pull(nodeName: string, bindings?: DatabaseValue[]): Promise<DatabaseValue>;
  set(nodeName: string, value: DatabaseValue, bindings?: DatabaseValue[]): Promise<void>;
  getStorage(): SchemaStorage;
}
```

**REQ-IFACE-01:** Implementations MUST provide type guard `isDependencyGraph(value): boolean`.

**REQ-IFACE-02:** `getStorage()` MUST return the `SchemaStorage` instance for the graph.

**REQ-IFACE-03:** For atom-expressions (arity 0), `bindings` parameter defaults to `[]` and may be omitted.

**REQ-IFACE-04:** For compound-expressions (arity > 0), `bindings` MUST be provided with length matching the expression arity.

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
  bindings: DatabaseValue[]
) => Promise<DatabaseValue | Unchanged>;
```

**REQ-COMP-01:** Computors MUST be deterministic with respect to `(inputs, oldValue, bindings)`.

**REQ-COMP-04a:** The `bindings` parameter is a positional array matching the schema output pattern's arguments by position. For example, if the output pattern is `full_event(e)`, then `bindings[0]` contains the value for the first argument position.

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
| `BindingArityMismatchError` | `nodeName: string, expectedArity: number, actualArity: number` | Bindings array length does not match expression arity |

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
* `DependencyGraph.pull(nodeName: string, bindings?: DatabaseValue[]): Promise<DatabaseValue>` — Retrieve/compute node value
* `DependencyGraph.set(nodeName: string, value: DatabaseValue, bindings?: DatabaseValue[]): Promise<void>` — Write source node value
* `DependencyGraph.getStorage(): SchemaStorage` — Access schema storage for testing
* `isDependencyGraph(value): boolean` — Type guard

### 5.2 Observable Error Taxonomy

Tests MAY assert error names (via `.name` property) and required fields (see section 3.5 for complete taxonomy).

### 5.3 Canonicalization Requirement

Tests MAY assert:
* Whitespace normalization in expressions
* See REQ-CANON-03 and REQ-CANON-04 in section 1.3

### 5.4 Freshness Observability

**REQ-FRESH-01:** Internal freshness tracking mechanisms (versions, epochs, etc.) are implementation-defined and NOT observable to tests.

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
    computor: async ([meta], old, bindings) => {
      const e = bindings[0]; // First argument position
      return meta.find(ev => ev.id === e.id);
    } }
]
```

**Operations:**
```javascript
// Set source (atom expression, no bindings needed)
await graph.set('all_events', {events: [{id: 'evt_123', data: '...'}]});

// Pull derived atom expression
const meta = await graph.pull('meta_events');

// Pull parameterized node with positional bindings
const context = await graph.pull('event_context(e)', [{id: 'evt_123'}]);
```

**How it works:**
* `all_events` is an atom expression—it denotes a single node
* `event_context(e)` is a compound expression—it denotes an infinite family
* Calling `pull('event_context(e)', [{id: 'evt_123'}])` selects one specific member of that family
* The binding array `[{id: 'evt_123'}]` has length 1, matching the arity of `event_context(e)`
* Different bindings create different node instances: `event_context(e)@[{id:'evt_123'}]` vs `event_context(e)@[{id:'evt_456'}]`
* Variable names are irrelevant: `pull('event_context(e)', [{id: '123'}])` and `pull('event_context(x)', [{id: '123'}])` address the same node

#### A.2 Multiple Parameters

```javascript
[
  { output: "all_events", inputs: [], 
    computor: async ([], old) => old },
  { output: "photo_storage", inputs: [],
    computor: async ([], old) => old },
  { output: "event_context(e)", inputs: ["all_events"],
    computor: async ([all], _, bindings) => {
      const e = bindings[0]; // First position
      return all.events.find(ev => ev.id === e.id);
    } },
  { output: "photo(p)", inputs: ["photo_storage"],
    computor: async ([storage], _, bindings) => {
      const p = bindings[0]; // First position
      return storage.photos[p.id];
    } },
  { output: "enhanced_event(e, p)", 
    inputs: ["event_context(e)", "photo(p)"],
    computor: async ([ctx, photo], _, bindings) => {
      // bindings[0] is the event, bindings[1] is the photo
      return {...ctx, photo};
    } }
]
```

**Operations:**
```javascript
// Set sources
await graph.set('all_events', {events: [{id: 'evt_123'}]});
await graph.set('photo_storage', {photos: {'photo_456': {url: '...'}}});

// Pull with multiple positional bindings
const enhanced = await graph.pull('enhanced_event(e, p)', [
  {id: 'evt_123'},
  {id: 'photo_456'}
]);
```

**How it works:**
* `enhanced_event(e, p)` denotes the Cartesian product of all possible event and photo values
* The binding array has length 2, matching the arity of `enhanced_event(e, p)`
* Position 0 corresponds to the first argument, position 1 to the second
* The schema declares: for any bindings `B`, `enhanced_event(e,p)@B` depends on `event_context(e)@B[0..0]` and `photo(p)@B[1..1]`
* When we pull with `[{id: 'evt_123'}, {id: 'photo_456'}]`, the system instantiates both dependencies with the appropriate positional bindings

#### A.3 Variable Sharing

```javascript
[
  { output: "event_data", inputs: [],
    computor: async ([], old) => old },
  { output: "status(e)", inputs: ["event_data"],
    computor: async ([data], _, bindings) => {
      const e = bindings[0]; // First position
      return data.statuses[e.id];
    } },
  { output: "metadata(e)", inputs: ["event_data"],
    computor: async ([data], _, bindings) => {
      const e = bindings[0]; // First position
      return data.metadata[e.id];
    } },
  { output: "full_event(e)", 
    inputs: ["status(e)", "metadata(e)"],
    computor: async ([status, meta], _, bindings) => {
      const e = bindings[0]; // First position
      return {id: e.id, status, meta};
    } }
]
```

**Operations:**
```javascript
await graph.set('event_data', {
  statuses: {'evt_123': 'active'},
  metadata: {'evt_123': {created: '2024-01-01'}}
});

// Pull with positional binding
const fullEvent = await graph.pull('full_event(e)', [{id: 'evt_123'}]);
// Result: {id: 'evt_123', status: 'active', meta: {created: '2024-01-01'}}
```

**How it works:**
* All three parameterized expressions have arity 1 (one argument position)
* When pulling `full_event(e)@[{id:'evt_123'}]`, both dependencies are instantiated with the same positional binding
* The binding propagates through the entire dependency chain, ensuring consistency
* Variable names (`e` in this case) are purely documentary—only position matters

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

#### E.2 Binding Arity Mismatch

**Error:** `pull("event_context(e)", [])` with wrong number of bindings.

**Behavior:** Throw `BindingArityMismatchError`.

**Example:**
```javascript
// Schema has: output: "event_context(e)" (arity 1)

// ❌ Wrong: Missing binding (empty array)
await graph.pull("event_context(e)", []);

// ❌ Wrong: Too many bindings
await graph.pull("event_context(e)", [{id: 'evt_123'}, {extra: 'value'}]);

// ✅ Correct: Exactly one binding for arity-1 expression
await graph.pull("event_context(e)", [{id: 'evt_123'}]);
```

#### E.3 Missing Values

If node instance is `up-to-date` but has no stored value, this is database corruption. MUST throw `MissingValueError`.

#### E.4 Atom Expressions with Bindings

**Scenario:** Providing bindings for an atom expression (no arguments).

**Behavior:** Empty bindings array required for atom expressions (arity 0).

**Example:**
```javascript
// ✅ Correct for atom expressions (arity 0):
await graph.pull("all_events", []);
await graph.pull("all_events"); // bindings default to []

// ❌ Wrong: Non-empty bindings for atom expression
await graph.pull("all_events", [{x: "value"}]); // throws BindingArityMismatchError
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
