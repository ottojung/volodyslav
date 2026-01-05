# Specification for the Dependency Graph

This document provides a formal specification for the dependency graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

- **NodeHead** — an identifier string (head/functor only), e.g., `"full_event"` or `"all_events"`. Used in public API calls to identify node families. Does NOT include variable syntax.
- **SchemaPattern** — an expression string that may contain variables, e.g., `"full_event(e)"` or `"all_events"`. Used ONLY in schema definitions to denote families of nodes and for variable mapping.
- **BindingEnvironment** — a positional array of concrete values: `DatabaseValue[]`. Used to instantiate a specific node from a family. The array length MUST match the arity of the node. Bindings are matched to argument positions by position, not by name.
- **NodeInstance** — a specific node identified by a `NodeHead` and `BindingEnvironment`. Conceptually: `{ head: NodeHead, bindings: BindingEnvironment }`. Notation: `head@bindings`.
- **NodeKey** — stable string key used for storage, derived from the head and bindings. This is the actual database key. Format: JSON serialization of `{ head: string, args: DatabaseValue[] }`.
- **NodeValue** — computed value at a node (arbitrary `DatabaseValue`)
- **Freshness** — conceptual state: `"up-to-date" | "potentially-outdated"`
- **Computor** — deterministic async function: `(inputs: DatabaseValue[], oldValue: DatabaseValue | undefined, bindings: DatabaseValue[]) => Promise<DatabaseValue | Unchanged>`
- **Unchanged** — unique sentinel value indicating unchanged computation result. MUST NOT be a valid `DatabaseValue` (cannot be stored via `set()` or returned by `pull()`).
- **Variable** — parameter placeholder in node schemas (identifiers in argument positions). Variables are internal to schema definitions and not exposed in public API.
- **DatabaseValue** — a JSON serializable JavaScript value. MUST round-trip through database interfaces without semantic change.

### 1.2 Expressions as an Infinite Graph (Normative)

This section establishes the fundamental mental model for understanding how expressions denote infinite families of nodes and how the dependency graph operates over this infinite space using a finite schema.

#### 1.2.1 Expressions Denote Node Families

An **expression** is a symbolic template that denotes a (possibly infinite) family of nodes. The expression defines the structure, while variable bindings select a specific member of that family.

**Components:**

- The **head** (or **functor**) of an expression is its identifier—the name that categorizes the family.
- The **arguments** are variable positions that can be assigned concrete `DatabaseValue` instances at runtime.

**Examples:**

- `all_events` — An atom expression with no variables. Denotes exactly one node (a family of size 1).
- `full_event(e)` — Denotes the infinite family `{ full_event(e=v) | v ∈ DatabaseValue }`.
    - Each distinct `DatabaseValue` for `e` identifies a different member of this family.
- `enhanced_event(e, p)` — Denotes `{ enhanced_event(e=v₁, p=v₂) | v₁, v₂ ∈ DatabaseValue }`.
    - The Cartesian product of all possible values for `e` and `p` forms this family.

#### 1.2.2 Node Instances (Addresses Within Families)

A **node instance** is a specific member of a node family, identified by:

1. An expression pattern (e.g., `full_event(e)`)
2. A binding environment B: `DatabaseValue[]` that assigns concrete values to all argument positions in the expression

**Notation:** We write `expr@B` to denote a node instance, where:

- `expr` is the expression pattern
- `B` is the binding environment (positional array)

**Examples:**

- `full_event(e)` with `B = [{id: "evt_123"}]` identifies the specific node `full_event(e={id: "evt_123"})`.
- `enhanced_event(e, p)` with `B = [{id: "evt_123"}, {id: "photo_456"}]` identifies one specific enhanced event.
- Variable names do not affect identity: `full_event(e)@[{id: "123"}]` and `full_event(x)@[{id: "123"}]` are the same node instance.

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

- `event_data(e)@B` (same positional bindings)
- `metadata(e)@B` (same positional bindings)

The schema implicitly defines infinitely many dependency edges—one set for each possible binding environment.

**Note on Variable Names:** The variable name `e` is purely syntactic. The schemas `full_event(e)` and `full_event(x)` are functionally identical—both define an arity-1 family where the first (and only) argument position receives `bindings[0]`.

#### 1.2.4 Public Interface: Addressing Nodes

**IMPORTANT: The public API uses head-only addressing. Expression patterns with variables are internal to schema definitions.**

The public API requires both the head and bindings to address a specific node:

- `pull(head, bindings)` — Evaluates the node instance identified by `NodeHead` and `BindingEnvironment`
- `set(head, value, bindings)` — Stores `value` at the node instance identified by `NodeHead` and `BindingEnvironment`

**For arity-0 nodes** (nodes with no arguments like `all_events`):

- The binding environment is empty: `[]`
- The head alone identifies exactly one node
- `pull("all_events", [])` and `pull("all_events")` are equivalent

**For arity > 0 nodes** (nodes with arguments):

- Bindings array length MUST match the arity of the node
- Bindings are matched to argument positions by position
- Different bindings address different node instances
- `pull("full_event", [{id: "123"}])` and `pull("full_event", [{id: "456"}])` address distinct nodes

**Schema Pattern vs Public Head:**

- Schema definition: `output: "full_event(e)"` — uses expression pattern with variable
- Public API call: `pull("full_event", [value])` — uses head only, no variable syntax
- The arity is determined by the schema, not by the caller

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

- **atom-expression** — an expression with no arguments (e.g., `all_events`). Denotes a family of exactly one node.
- **compound-expression** — an expression with one or more arguments (e.g., `event_context(e)`, `enhanced_event(e, p)`). Each argument is a variable. Denotes an infinite family of nodes.
- **variable** — an identifier in an argument position; represents a parameter that can be bound to any `DatabaseValue`
- **pattern** — an expression used in a schema definition to describe a family of nodes
- **free variables** — all variables (identifiers occurring in argument positions) in an expression

**Examples:**

- `all_events` — atom-expression with zero variables; denotes a singleton family
- `event_context(e)` — compound-expression with one variable `e`; denotes an infinite family indexed by values of `e`
- `enhanced_event(e, p)` — compound-expression with two variables `e` and `p`; denotes an infinite family indexed by pairs of values

### 1.4 Canonical Serialization (Normative)

**REQ-CANON-01:** The function `canonicalize(expr)` MUST produce a unique canonical string:

1. Format: `head/arity` where:
    - `head` is the expression name (identifier)
    - `arity` is the number of arguments
2. Atom-expressions: just the identifier (no `/0` suffix)
3. Compound-expressions: `name/N` where N is the number of arguments
4. Variable names and whitespace do NOT affect canonicalization

**REQ-CANON-02:** Equality and identity:

- Two expressions have the same canonical form if and only if they have the same head (functor) and same arity (number of arguments)
- Variable names in the original expression do NOT affect the canonical form
- The canonical form is NOT a parseable expression—it's an index key

**Examples:**

- `all_events` → `"all_events"`
- `event_context(e)` → `"event_context/1"`
- `event_context(x)` → `"event_context/1"` (same as above)
- `enhanced_event(e, p)` → `"enhanced_event/2"`
- `enhanced_event(x, y)` → `"enhanced_event/2"` (same as above)

**REQ-CANON-03:** Pattern Matching:

- The canonical form is used for pattern matching and schema indexing
- Original expression strings (with variable names) are preserved for error messages and NodeKey creation
- When creating concrete node instances, the original expression is parsed to extract arity

**REQ-CANON-04:** All storage operations MUST use NodeKey (not NodePattern) as database keys. A NodeKey is derived from: (1) parsing the pattern to extract head and arity, and (2) combining with the BindingEnvironment to produce a stable JSON key.

**REQ-CANON-05:** `pull(pattern, bindings)` and `set(pattern, value, bindings)` MUST accept any valid NodePattern string. The pattern is canonicalized for schema matching, but the original pattern is used (along with bindings) to create the NodeKey for storage. Canonicalization MUST NOT affect binding interpretation—bindings are always positional regardless of variable names in the expression.

### 1.5 NodeKey Format (Normative)

**REQ-KEY-01:** A NodeKey is a stable, JSON-serialized string that uniquely identifies a NodeInstance in storage. Format:

```json
{"head": "function_name", "args": [binding0, binding1, ...]}
```

**REQ-KEY-02:** NodeKey creation from (NodePattern, BindingEnvironment):

1. Parse the NodePattern to extract the head (function name) and arity
2. Verify that `bindings.length === arity` (throw ArityMismatchError otherwise)
3. Construct the key object: `{ head: string, args: bindings }`
4. Serialize to JSON string using `JSON.stringify()`

**Examples:**

- Pattern: `"all_events"`, Bindings: `[]` → NodeKey: `'{"head":"all_events","args":[]}'`
- Pattern: `"event_context(e)"`, Bindings: `[{id: "123"}]` → NodeKey: `'{"head":"event_context","args":[{"id":"123"}]}'`
- Pattern: `"event_context(x)"`, Bindings: `[{id: "123"}]` → **Same** NodeKey (variable names don't matter)

**REQ-KEY-03:** All database operations (storing values, freshness, dependencies) MUST use NodeKey as the storage key, NOT the NodePattern or canonical form.

### 1.6 Schema Definition (Normative)

**REQ-SCHEMA-01:** A dependency graph is defined by a set of node schemas:

```typescript
type NodeDef = {
    output: string; // Expression pattern (may contain variables)
    inputs: string[]; // Dependency expression patterns
    computor: Computor; // Computation function
};
```

**REQ-SCHEMA-02:** Variables in `output` MUST be a superset of all variables in `inputs` (Variable Scope Rule 1).

**REQ-SCHEMA-03:** A **source node** is any node instance matching a schema where `inputs = []`. Source nodes have no dependencies and their values are set explicitly via `set()`.

**REQ-SCHEMA-04:** All variable names within an expression MUST be unique. Expressions with duplicate variable names (e.g., `event(a, b, c, b, d)` where `b` appears twice) MUST be rejected with an `InvalidSchemaError`. This requirement applies to both `output` and `inputs` expressions in node definitions.

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

**REQ-BINDING-03:** When a user calls `pull(expr, bindings)` where `expr` uses different variable names than the matching schema output pattern:

1. The system matches by functor and arity (REQ-MATCH-01)
2. The positional bindings are used directly—no renaming occurs
3. Variable names in the user's expression are purely syntactic

**Example of Variable Name Independence:**

```javascript
// Schema: output: "full_event(e)", inputs: ["event_data(e)"]

// These calls are IDENTICAL semantically:
await graph.pull("full_event(e)", [{ id: "123" }]);
await graph.pull("full_event(x)", [{ id: "123" }]);
await graph.pull("full_event(my_event)", [{ id: "123" }]);

// All address the same node instance because:
// - Same functor: "full_event"
// - Same arity: 1
// - Same positional bindings: [{id: "123"}] at position 0
```

**Pattern Instantiation Summary:** When evaluating a node instance `output@B`:

1. The computor receives the full output binding environment `B` as its third parameter
2. Each input pattern `input_i` is instantiated by extracting the relevant positional bindings based on variable name mapping
3. The computor receives the values of all instantiated input nodes in the order they appear in the `inputs` array

### 1.8 Pattern Matching (Normative)

**REQ-MATCH-01:** A schema output pattern `P` **matches** a head `H` if and only if:

1. `P` and `H` have the same functor (head identifier), AND
2. The arity of `P` matches the expected arity for `H`

**REQ-MATCH-02:** Two output patterns **overlap** if they have the same functor and the same arity.

**REQ-MATCH-03:** The system MUST reject graphs with overlapping output patterns at initialization (throw `SchemaOverlapError`).

**REQ-MATCH-04 (NEW):** Each head (functor) MUST have a single, unique arity across all schema outputs. The system MUST reject graphs where the same head appears with different arities (throw `SchemaArityConflictError`).

**Note on Matching:** Pattern matching in schema definitions is purely structural and does not consider variable names. The pattern `full_event(e)` and `full_event(x)` are equivalent—both define an arity-1 node family. Variable names serve only for documentation and variable mapping between inputs and outputs.

**Note on Public API:** The public API uses only the head identifier (e.g., `"full_event"`), not expression patterns. The arity is determined by the schema, and callers must provide bindings that match the expected arity.

### 1.9 Cycle Detection (Normative)

**REQ-CYCLE-01:** A directed edge exists from Schema S to Schema T if:

1. S has input pattern I
2. T has output pattern O
3. Patterns I and O match (same functor and arity)

**REQ-CYCLE-02:** The system MUST reject graphs with cycles at initialization (throw `SchemaCycleError`).

### 1.10 Materialization (Normative)

**REQ-MAT-01:** A **materialized node** is any NodeInstance (identified by NodeKey) for which the implementation maintains dependency tracking and freshness state.

**REQ-MAT-02:** Materialization occurs through:

- `pull(head, bindings)` — creates NodeInstance with dependencies, stores value at NodeKey, marks `up-to-date`
- `set(head, value, bindings)` — materializes source NodeInstance at NodeKey, marks `up-to-date`

---

## 2. Operational Semantics (Normative)

### 2.1 pull(head, bindings) → NodeValue

**Signature:** `pull(head: NodeHead, bindings?: BindingEnvironment): Promise<DatabaseValue>`

**Preconditions:**

- `head` MUST be a valid node head identifier (string matching the `ident` production)
- A schema output with matching head MUST exist (throw `InvalidNodeError` otherwise)
- `bindings` array length MUST match the arity of the node as defined in the schema (throw `ArityMismatchError` otherwise)

**Big-Step Semantics (Correctness Specification):**

```
pull(H, B):
  schema = lookup_schema_by_head(H)  // O(1) lookup
  if schema is null: throw InvalidNodeError
  if schema.arity ≠ B.length: throw ArityMismatchError
  nodeKey = createNodeKey(H, B)  // {"head": H, "args": B}
  inputs_values = [pull(I_head, I_bindings) for I in inputs_of(schema)]
  old_value = stored_value(nodeKey)
  new_value = computor_of(schema)(inputs_values, old_value, B)
  if new_value ≠ Unchanged:
    store(nodeKey, new_value)
  mark_up_to_date(nodeKey)
  return stored_value(nodeKey)
```

**REQ-PULL-01:** `pull` MUST return a `Promise<DatabaseValue>`.

**REQ-PULL-02:** `pull` MUST throw `InvalidNodeError` if no schema output has the given head.

**REQ-PULL-03:** `pull` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema for the given head.

**REQ-PULL-04:** `pull` MUST ensure each computor is invoked at most once per top-level call for each unique node instance (property P3).

**REQ-PULL-05:** Lazy instantiation: When pulling a node instance, the system:

1. Looks up schema by head identifier (O(1))
2. Validates arity matches bindings length
3. Creates NodeKey from head and bindings
4. Instantiates all input dependencies using variable name mapping from schema
5. Recursively pulls all input node instances
6. Creates materialized node instance on-demand with instantiated dependencies
7. Persists materialization marker for restart resilience

**Efficiency Optimization (Implementation-Defined):**

Implementations MAY use any strategy to achieve property P3 (e.g., memoization, freshness checks, in-flight tracking). The specific mechanism is not prescribed.

### 2.2 set(head, value, bindings)

**Signature:** `set(head: NodeHead, value: DatabaseValue, bindings?: BindingEnvironment): Promise<void>`

**Preconditions:**

- `head` MUST be a valid node head identifier
- A schema output with matching head MUST exist (throw `InvalidNodeError` otherwise)
- `bindings` array length MUST match the arity of the node (throw `ArityMismatchError` otherwise)
- The matching schema MUST be a source node (throw `InvalidSetError` if it has inputs)

**Effects:**

1. Create NodeKey from `head@bindings`
2. Store `value` at that NodeKey
3. Mark that node instance as `up-to-date`
4. Mark all **materialized** transitive dependents as `potentially-outdated`

**REQ-SET-01:** `set` MUST return a `Promise<void>`.

**REQ-SET-02:** `set` MUST throw `InvalidNodeError` if no schema output has the given head.

**REQ-SET-03:** `set` MUST throw `ArityMismatchError` if `bindings` array length does not match the arity defined in the schema.

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
    nodeDefs: NodeDef[],
): DependencyGraph;
```

**REQ-FACTORY-01:** MUST validate all schemas at construction (throw on parse errors, scope violations, overlaps, cycles, and arity conflicts).

**REQ-FACTORY-02:** MUST compute schema identifier and obtain schema-namespaced storage via `rootDatabase.getSchemaStorage(schemaId)`.

**REQ-FACTORY-03:** MUST NOT mutate `nodeDefs` or `rootDatabase`.

**REQ-FACTORY-04 (NEW):** MUST reject schemas where the same head appears with different arities (throw `SchemaArityConflictError`).

### 3.2 DependencyGraph Interface

```typescript
interface DependencyGraph {
    pull(head: NodeHead, bindings?: BindingEnvironment): Promise<DatabaseValue>;
    set(
        head: NodeHead,
        value: DatabaseValue,
        bindings?: BindingEnvironment,
    ): Promise<void>;
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
    values: GenericDatabase<DatabaseValue>; // Node output values
    freshness: GenericDatabase<Freshness>; // Node freshness state
    inputs: GenericDatabase<InputsRecord>; // Node input dependencies
    revdeps: GenericDatabase<1>; // Reverse dependency edges
    batch(operations: DatabaseBatchOperation[]): Promise<void>;
}

type InputsRecord = { inputs: string[] };
```

**REQ-STORAGE-01:** `values` MUST store node values keyed by NodeKey (stable string derived from pattern and bindings).

**REQ-STORAGE-02:** `freshness` MUST store conceptual freshness (`"up-to-date" | "potentially-outdated"`) keyed by NodeKey.

**REQ-STORAGE-03:** `inputs` MUST store dependency arrays keyed by NodeKey.

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
    bindings: DatabaseValue[],
) => Promise<DatabaseValue | Unchanged>;
```

**REQ-COMP-01:** Computors MUST be deterministic with respect to `(inputs, oldValue, bindings)`.

**REQ-COMP-04a:** The `bindings` parameter is a positional array matching the schema output pattern's arguments by position. For example, if the output pattern is `full_event(e)`, then `bindings[0]` contains the value for the first argument position.

**REQ-COMP-02:** Computors MUST NOT have hidden side effects affecting output.

**REQ-COMP-03:** Computors MAY return `Unchanged` sentinel to indicate no value change.

**REQ-COMP-04:** Implementations MUST expose `makeUnchanged()` factory and `isUnchanged(value)` type guard.

### 3.5 Error Taxonomy

All errors MUST provide stable `.name` property and required fields:

| Error Name               | Required Fields                                                    | Thrown When                                           |
| ------------------------ | ------------------------------------------------------------------ | ----------------------------------------------------- |
| `InvalidExpressionError` | `expression: string`                                               | Invalid expression syntax                             |
| `InvalidNodeError`       | `pattern: NodePattern`                                             | No schema matches the node pattern                    |
| `InvalidSetError`        | `pattern: NodePattern`                                             | Node is not a source node                             |
| `SchemaOverlapError`     | `patterns: string[]`                                               | Overlapping output patterns at init                   |
| `InvalidSchemaError`     | `schemaOutput: string`                                             | Schema definition problems at init                    |
| `SchemaCycleError`       | `cycle: string[]`                                                  | Cyclic schema dependencies at init                    |
| `MissingValueError`      | `nodeKey: NodeKey`                                                 | Up-to-date node has no stored value                   |
| `ArityMismatchError`     | `pattern: NodePattern, expectedArity: number, actualArity: number` | Bindings array length does not match expression arity |

**REQ-ERR-01:** All error types MUST provide type guard functions (e.g., `isInvalidExpressionError(value): boolean`).

**Note:** The `NonConcreteNodeError` from earlier versions has been removed. Instead, missing bindings result in `MissingBindingsError`.

---

## 4. Persistence & Materialization (Normative)

### 4.1 Materialization Markers

**REQ-PERSIST-01:** Implementations MUST persist sufficient markers to reconstruct materialized node instance set after restart.

**REQ-PERSIST-02:** If node instance `N@B` was materialized before restart, then after restart (same `RootDatabase`, same schema):

- `set(source, v, bindings)` MUST mark all previously materialized transitive dependents as `potentially-outdated`
- This MUST occur WITHOUT requiring re-pull

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

- `makeDependencyGraph(rootDatabase: RootDatabase, nodeDefs: NodeDef[]): DependencyGraph` — Factory function
- `DependencyGraph.pull(pattern: NodePattern, bindings?: BindingEnvironment): Promise<DatabaseValue>` — Retrieve/compute node value
- `DependencyGraph.set(pattern: NodePattern, value: DatabaseValue, bindings?: BindingEnvironment): Promise<void>` — Write source node value
- `DependencyGraph.getStorage(): SchemaStorage` — Access schema storage for testing
- `isDependencyGraph(value): boolean` — Type guard

### 5.2 Observable Error Taxonomy

Tests MAY assert error names (via `.name` property) and required fields (see section 3.5 for complete taxonomy).

### 5.3 Canonicalization Requirement

Tests MAY assert:

- Whitespace normalization in expressions
- See REQ-CANON-03 and REQ-CANON-04 in section 1.3

### 5.4 Freshness Observability

**REQ-FRESH-01:** Internal freshness tracking mechanisms (versions, epochs, etc.) are implementation-defined and NOT observable to tests.

### 5.5 Restart Resilience

**REQ-RESTART-01:** Materialized node instances MUST remain materialized across graph restarts (same `RootDatabase`, same schema).

**REQ-RESTART-02:** After restart, `set(source, value, bindings)` MUST invalidate all previously materialized transitive dependents WITHOUT requiring re-pull.

Tests MAY assert:

- Pull a node instance, restart graph instance, call `set()` on upstream source with appropriate bindings, verify downstream node instance is marked `potentially-outdated`

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
    {
        output: "all_events",
        inputs: [],
        computor: async ([], old) => old || { events: [] },
    },
    {
        output: "meta_events",
        inputs: ["all_events"],
        computor: async ([all]) => extractMeta(all),
    },
    {
        output: "event_context(e)",
        inputs: ["meta_events"],
        computor: async ([meta], old, bindings) => {
            const e = bindings[0]; // First argument position
            return meta.find((ev) => ev.id === e.id);
        },
    },
];
```

**Operations:**

```javascript
// Set source (atom expression, no bindings needed)
await graph.set("all_events", { events: [{ id: "evt_123", data: "..." }] });

// Pull derived atom expression
const meta = await graph.pull("meta_events");

// Pull parameterized node with positional bindings
const context = await graph.pull("event_context(e)", [{ id: "evt_123" }]);
```

**How it works:**

- `all_events` is an atom expression—it denotes a single node
- `event_context(e)` is a compound expression—it denotes an infinite family
- Calling `pull('event_context(e)', [{id: 'evt_123'}])` selects one specific member of that family
- The binding array `[{id: 'evt_123'}]` has length 1, matching the arity of `event_context(e)`
- Different bindings create different node instances: `event_context(e)@[{id:'evt_123'}]` vs `event_context(e)@[{id:'evt_456'}]`
- Variable names irrelevancy: `pull('event_context(e)', [{id: '123'}])` and `pull('event_context(x)', [{id: '123'}])` address the same node

#### A.2 Multiple Parameters

```javascript
[
    { output: "all_events", inputs: [], computor: async ([], old) => old },
    { output: "photo_storage", inputs: [], computor: async ([], old) => old },
    {
        output: "event_context(e)",
        inputs: ["all_events"],
        computor: async ([all], _, bindings) => {
            const e = bindings[0]; // First position
            return all.events.find((ev) => ev.id === e.id);
        },
    },
    {
        output: "photo(p)",
        inputs: ["photo_storage"],
        computor: async ([storage], _, bindings) => {
            const p = bindings[0]; // First position
            return storage.photos[p.id];
        },
    },
    {
        output: "enhanced_event(e, p)",
        inputs: ["event_context(e)", "photo(p)"],
        computor: async ([ctx, photo], _, bindings) => {
            // bindings[0] is the event, bindings[1] is the photo
            return { ...ctx, photo };
        },
    },
];
```

**Operations:**

```javascript
// Set sources
await graph.set("all_events", { events: [{ id: "evt_123" }] });
await graph.set("photo_storage", { photos: { photo_456: { url: "..." } } });

// Pull with multiple positional bindings
const enhanced = await graph.pull("enhanced_event(e, p)", [
    { id: "evt_123" },
    { id: "photo_456" },
]);
```

**How it works:**

- `enhanced_event(e, p)` denotes the Cartesian product of all possible event and photo values
- The binding array has length 2, matching the arity of `enhanced_event(e, p)`
- Position 0 corresponds to the first argument, position 1 to the second
- The schema declares: for any bindings `B`, `enhanced_event(e,p)@B` depends on `event_context(e)@B[0..0]` and `photo(p)@B[1..1]`
- When we pull with `[{id: 'evt_123'}, {id: 'photo_456'}]`, the system instantiates both dependencies with the appropriate positional bindings

#### A.3 Variable Sharing

```javascript
[
    { output: "event_data", inputs: [], computor: async ([], old) => old },
    {
        output: "status(e)",
        inputs: ["event_data"],
        computor: async ([data], _, bindings) => {
            const e = bindings[0]; // First position
            return data.statuses[e.id];
        },
    },
    {
        output: "metadata(e)",
        inputs: ["event_data"],
        computor: async ([data], _, bindings) => {
            const e = bindings[0]; // First position
            return data.metadata[e.id];
        },
    },
    {
        output: "full_event(e)",
        inputs: ["status(e)", "metadata(e)"],
        computor: async ([status, meta], _, bindings) => {
            const e = bindings[0]; // First position
            return { id: e.id, status, meta };
        },
    },
];
```

**Operations:**

```javascript
await graph.set("event_data", {
    statuses: { evt_123: "active" },
    metadata: { evt_123: { created: "2024-01-01" } },
});

// Pull with positional binding
const fullEvent = await graph.pull("full_event(e)", [{ id: "evt_123" }]);
// Result: {id: 'evt_123', status: 'active', meta: {created: '2024-01-01'}}
```

**How it works:**

- All three parameterized expressions have arity 1 (one argument position)
- When pulling `full_event(e)@[{id:'evt_123'}]`, both dependencies are instantiated with the same positional binding
- The binding propagates through the entire dependency chain, ensuring consistency
- Variable names (`e` in this case) are purely documentary—only position matters

### Appendix B: Recommended Storage Architecture

This section describes the reference implementation's storage design. Implementations MAY use different designs as long as they satisfy the normative requirements.

#### B.1 Recommended Reverse Dependency Storage

**Edge-Based Storage:** Store each reverse dependency as a separate key:

- **Key format:** `"${inputNode}\x00${dependentNode}"`
- **Value:** Constant `1`

**Benefits:**

- Efficient iteration without deserializing arrays
- Incremental updates (add edge without reading full array)
- Scales better for high fan-out nodes

**Alternative:** Implementations MAY use adjacency lists (`inputNode -> [dependent1, dependent2, ...]`) if preferred.

#### B.2 Recommended Schema Identifier Algorithm

**Algorithm:**

```javascript
const schemaRepresentation = compiledNodes
    .map((node) => ({
        output: node.canonicalOutput,
        inputs: node.canonicalInputs,
    }))
    .sort((a, b) => a.output.localeCompare(b.output));

const schemaJson = JSON.stringify(schemaRepresentation);
const schemaId = crypto
    .createHash("md5")
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
    ensureMaterialized(
        node: string,
        inputs: string[],
        batch: BatchBuilder,
    ): Promise<void>;
    ensureReverseDepsIndexed(
        node: string,
        inputs: string[],
        batch: BatchBuilder,
    ): Promise<void>;
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
    debugGetFreshness(
        pattern: NodePattern,
        bindings?: BindingEnvironment,
    ): Promise<"up-to-date" | "potentially-outdated" | "missing">;
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
await graph.pull("event_context(e)", [{ id: "evt_123" }, { extra: "value" }]);

// ✅ Correct: Exactly one binding for arity-1 expression
await graph.pull("event_context(e)", [{ id: "evt_123" }]);
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
await graph.pull("all_events", [{ x: "value" }]); // throws BindingArityMismatchError
```

---

## Conformance Summary

An implementation conforms to this specification if and only if:

1. It provides all required types, interfaces, and functions with matching signatures
2. It throws documented errors with stable names at specified times
3. It enforces all REQ-\* requirements
4. It produces results consistent with big-step semantics and correctness properties
5. It passes all conformance tests derived from this specification

Optional features (GraphStorage, Debug interface, etc.) MAY be provided without affecting conformance.

---

## Related Documentation

For guidance on migrating data between different schema versions, see [DependencyGraph Migration Strategy](../dependency-graph-migrations.md).
