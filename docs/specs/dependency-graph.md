# Specification for the Dependency Graph

This document provides a formal specification for the dependency graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

* **NodeName** — unique identifier for a concrete node (fully instantiated expression)
* **NodeValue** — computed value at a node (arbitrary `DatabaseValue`)
* **Freshness** — conceptual state: `"up-to-date" | "potentially-outdated"`
* **Computor** — deterministic async function: `(inputs: DatabaseValue[], oldValue: DatabaseValue | undefined, bindings: Record<string, ConstValue>) => Promise<DatabaseValue | Unchanged>`
* **Unchanged** — unique sentinel value indicating unchanged computation result. MUST NOT be a valid `DatabaseValue` (cannot be stored via `set()` or returned by `pull()`).
* **Variable** — parameter placeholder in node schemas (identifiers in argument positions)
* **ConstValue** — typed constant: `{ type: "string" | "int"; value: string | number }`
* **DatabaseValue** — any JavaScript `object` (including subtypes like arrays, but excluding `null`). MUST NOT include the `Unchanged` sentinel. MUST round-trip through database interfaces without semantic change.

### 1.2 Expression Grammar (Normative)

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
* **atom-expression** — an expression with no arguments (e.g., `all_events`)
* **compound-expression** — an expression with arguments (e.g., `event_context(e)`)
* **free variables** — all identifiers occurring in argument positions
* **concrete expression** — an expression where `freeVars(expr) = ∅` (no free variables); only atom-expressions can be concrete

**Examples:**
* `all_events` — atom-expression (no arguments), also a concrete expression
* `event_context(e)` — compound-expression with free variable `e`
* `enhanced_event(e, p)` — compound-expression with free variables `e` and `p`

### 1.3 Canonical Serialization (Normative)

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

**REQ-CANON-03:** All node names used as database keys MUST use canonical serialization.

**REQ-CANON-04:** `pull(nodeName)` and `set(nodeName, value)` MUST accept any valid expression string and canonicalize it before processing.

### 1.4 Schema Definition

**REQ-SCHEMA-01:** A dependency graph is defined by a set of node schemas:

```typescript
type NodeDef = {
  output: string;     // Expression pattern (may contain variables)
  inputs: string[];   // Dependency expressions
  computor: Computor; // Computation function
};
```

**REQ-SCHEMA-02:** Variables in `output` MUST be a superset of all variables in `inputs` (Variable Scope Rule 1).

**REQ-SCHEMA-03:** A **source node** is a concrete node matching a schema where `inputs = []`.

### 1.5 Pattern Matching (Normative)

**REQ-MATCH-01:** Since arguments can only be variables, a schema output pattern `P` **matches** concrete node `N` if and only if `N` is an atom-expression (has no arguments) and has the same functor as `P`.

**REQ-MATCH-02:** Two output patterns **overlap** if they have the same head (functor) and the same arity.

**REQ-MATCH-03:** The system MUST reject graphs with overlapping output patterns at initialization (throw `SchemaOverlapError`).

### 1.6 Cycle Detection (Normative)

**REQ-CYCLE-01:** A directed edge exists from Schema S to Schema T if:
1. S has input pattern I
2. T has output pattern O
3. I and O overlap

**REQ-CYCLE-02:** The system MUST reject graphs with cycles at initialization (throw `SchemaCycleError`).

### 1.7 Materialization

**REQ-MAT-01:** A **materialized node** is any concrete node for which the implementation maintains dependency tracking and freshness state.

**REQ-MAT-02:** Materialization occurs through:
* `pull(nodeName)` — creates node with dependencies, stores value, marks `up-to-date`
* `set(nodeName, value)` — materializes source node, marks `up-to-date`

**REQ-MAT-03:** Unmaterialized nodes have no freshness state (`undefined` in `SchemaStorage.freshness`).

---

## 2. Operational Semantics (Normative)

### 2.1 pull(nodeName) → NodeValue

**Preconditions:**
* `nodeName` MUST be a concrete expression (no free variables)
* A matching schema pattern MUST exist

**Big-Step Semantics (Correctness Specification):**

```
pull(N):
  bindings = extract_bindings(N)
  inputs_values = [pull(I) for I in inputs_of(N)]
  old_value = stored_value(N)
  new_value = computor_N(inputs_values, old_value, bindings)
  if new_value ≠ Unchanged:
    store(N, new_value)
  mark_up_to_date(N)
  return stored_value(N)
```

**REQ-PULL-01:** `pull` MUST return a `Promise<DatabaseValue>`.

**REQ-PULL-02:** `pull` MUST throw `NonConcreteNodeError` if `nodeName` contains free variables.

**REQ-PULL-03:** `pull` MUST throw `InvalidNodeError` if no schema matches.

**REQ-PULL-04:** `pull` MUST ensure each computor is invoked at most once per top-level call (property P3).

**REQ-PULL-05:** Lazy instantiation: When pulling a concrete node, the system:
1. Searches for matching schema pattern
2. Extracts variable bindings from the match
3. Instantiates all input expressions by applying the bindings to produce concrete dependency nodes
4. Recursively pulls all concrete dependencies
5. Creates materialized concrete node on-demand with instantiated dependencies
6. Persists materialization marker for restart resilience

**Efficiency Optimization (Implementation-Defined):**

Implementations MAY use any strategy to achieve property P3 (e.g., memoization, freshness checks, in-flight tracking). The specific mechanism is not prescribed.

### 2.2 set(nodeName, value)

**Preconditions:**
* `nodeName` MUST be a concrete expression (no free variables)
* `nodeName` MUST match a schema (throw `InvalidNodeError` otherwise)
* `nodeName` MUST be a source node (throw `InvalidSetError` if not)

**Effects:**
1. Store `value` at canonical key
2. Mark `nodeName` as `up-to-date`
3. Mark all **materialized** transitive dependents as `potentially-outdated`

**REQ-SET-01:** `set` MUST return a `Promise<void>`.

**REQ-SET-02:** `set` MUST throw `NonConcreteNodeError` if `nodeName` contains free variables.

**REQ-SET-03:** `set` MUST throw `InvalidNodeError` if no schema matches.

**REQ-SET-04:** `set` MUST throw `InvalidSetError` if `nodeName` is not a source node.

**REQ-SET-05:** All operations MUST be executed atomically in a single database batch.

**REQ-SET-06:** Only dependents that have been previously materialized (pulled) are marked outdated. Unmaterialized nodes remain unmaterialized.

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
  pull(nodeName: string): Promise<DatabaseValue>;
  set(nodeName: string, value: DatabaseValue): Promise<void>;
  getStorage(): SchemaStorage;
}
```

**REQ-IFACE-01:** Implementations MUST provide type guard `isDependencyGraph(value): boolean`.

**REQ-IFACE-02:** `getStorage()` MUST return the `SchemaStorage` instance for the graph.

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
  bindings: Record<string, ConstValue>
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
| `NonConcreteNodeError` | `pattern: string` | Expression contains free variables in pull/set |
| `InvalidNodeError` | `nodeName: string` | No schema matches the node |
| `InvalidSetError` | `nodeName: string` | Node is not a source node |
| `SchemaOverlapError` | `patterns: string[]` | Overlapping output patterns at init |
| `InvalidSchemaError` | `schemaOutput: string` | Schema definition problems at init |
| `SchemaCycleError` | `cycle: string[]` | Cyclic schema dependencies at init |
| `MissingValueError` | `nodeName: string` | Up-to-date node has no stored value |

**REQ-ERR-01:** All error types MUST provide type guard functions (e.g., `isInvalidExpressionError(value): boolean`).

---

## 4. Persistence & Materialization (Normative)

### 4.1 Materialization Markers

**REQ-PERSIST-01:** Implementations MUST persist sufficient markers to reconstruct materialized node set after restart.

**REQ-PERSIST-02:** If node N was materialized before restart, then after restart (same `RootDatabase`, same schema):
* `set(source, v)` MUST mark all previously materialized transitive dependents as `potentially-outdated`
* This MUST occur WITHOUT requiring re-pull

**REQ-PERSIST-03:** The specific persistence mechanism (metadata keys, reverse index, etc.) is implementation-defined.

### 4.2 Invariants

The graph MUST maintain these invariants for all materialized nodes:

**I1 (Outdated Propagation):** If materialized node N is `potentially-outdated`, all materialized transitive dependents are also `potentially-outdated`.

**I2 (Up-to-Date Upstream):** If materialized node N is `up-to-date`, all materialized transitive dependencies are also `up-to-date`.

**I3 (Value Consistency):** If materialized node N is `up-to-date`, its value equals what would be computed by recursively evaluating dependencies and applying computor.

### 4.3 Correctness Properties

**P1 (Semantic Equivalence):** `pull(N)` produces same result as recomputing from scratch.

**P2 (Progress):** Every `pull(N)` call terminates (assuming computors terminate).

**P3 (Single Invocation):** Each computor invoked at most once per top-level `pull()`.

**P4 (Freshness Preservation):** After `pull(N)`, N and all transitive dependencies are `up-to-date`.

---

## 5. Test-Visible Contract (Normative)

This section defines exactly what conformance tests MAY assert. All other implementation details are internal and subject to change.

### 5.1 Public API

Tests MAY assert the existence and signatures of:

* `makeDependencyGraph(rootDatabase: RootDatabase, nodeDefs: NodeDef[]): DependencyGraph` — Factory function
* `DependencyGraph.pull(nodeName: string): Promise<DatabaseValue>` — Retrieve/compute node value
* `DependencyGraph.set(nodeName: string, value: DatabaseValue): Promise<void>` — Write source node value
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

**REQ-RESTART-01:** Materialized nodes MUST remain materialized across graph restarts (same `RootDatabase`, same schema).

**REQ-RESTART-02:** After restart, `set(source, value)` MUST invalidate all previously materialized transitive dependents WITHOUT requiring re-pull.

Tests MAY assert:
* Pull a node, restart graph instance, call `set()` on upstream source, verify downstream node is marked `potentially-outdated`

### 5.6 Behavioral Guarantees

**REQ-BEHAVE-01 = P1** (see §4.3): `pull(N)` MUST produce the same result as recomputing all values from scratch (Semantic Equivalence).

**REQ-BEHAVE-02 = P3** (see §4.3): Each computor MUST be invoked at most once per top-level `pull()` call (Single Invocation).

**REQ-BEHAVE-03 = P4** (see §4.3): After `pull(N)` completes, N and all its transitive dependencies MUST be marked `up-to-date` (Freshness Preservation).

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
    computor: async ([meta], old, {e}) => meta.find(ev => ev.id === e.value) }
]
```

**Operations:**
```javascript
await graph.set('all_events', {events: [{id: 'id123', data: '...'}]});
// Note: With the removal of constants, pulling event_context(e) requires
// passing a variable binding through a parameterized approach, or
// event_context must be redesigned to not use parameters.
```

#### A.2 Multiple Parameters

```javascript
[
  { output: "all_events", inputs: [], 
    computor: async ([], old) => old },
  { output: "event_context(e)", inputs: ["all_events"],
    computor: async ([all], _, {e}) => all.events.find(ev => ev.id === e.value) },
  { output: "photo(p)", inputs: ["photo_storage"],
    computor: async ([storage], _, {p}) => storage.photos[p.value] },
  { output: "enhanced_event(e, p)", 
    inputs: ["event_context(e)", "photo(p)"],
    computor: async ([ctx, photo], _, {e, p}) => combine(ctx, photo) }
]
```

#### A.3 Variable Sharing

```javascript
[
  { output: "status(e)", inputs: ["event_data"],
    computor: async ([data], _, {e}) => data.statuses[e.value] },
  { output: "metadata(e)", inputs: ["event_data"],
    computor: async ([data], _, {e}) => data.metadata[e.value] },
  { output: "full_event(e)", 
    inputs: ["status(e)", "metadata(e)"],
    computor: async ([status, meta], _, {e}) => ({id: e.value, status, meta}) }
]
```

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

**Error:** `pull("unknown_node")` but no schema matches.

**Behavior:** Throw `InvalidNodeError`.

#### E.2 Non-Concrete Pull/Set

**Error:** `pull("event_context(e)")` with free variable.

**Behavior:** Throw `NonConcreteNodeError`.

**Note:** Since only atom-expressions can be concrete (no arguments), any compound-expression will contain free variables and thus be rejected by `pull()` and `set()`.

#### E.3 Missing Values

If node is `up-to-date` but has no stored value, this is database corruption. MUST throw `MissingValueError`.

---

## Conformance Summary

An implementation conforms to this specification if and only if:

1. It provides all required types, interfaces, and functions with matching signatures
2. It throws documented errors with stable names at specified times
3. It enforces all REQ-* requirements
4. It produces results consistent with big-step semantics and correctness properties
5. It passes all conformance tests derived from this specification

Optional features (GraphStorage, Debug interface, etc.) MAY be provided without affecting conformance.
