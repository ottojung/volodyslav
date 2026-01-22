# Specification for the Incremental Graph

This document provides a formal specification for the incremental graph's operational semantics and correctness properties.

---

## 1. Core Definitions (Normative)

### 1.1 Types

#### 1.1.1 Core Identity Types

* **Functor** — an identifier string (the head of an expression), e.g., `"full_event"` or `"all_events"`. Alias for "head".
* **Arity** — a non-negative integer representing the number of argument positions in an expression pattern.
* **NodeSignature** — a pair `(functor: Functor, arity: Arity)` that uniquely identifies a node family. Two patterns have the same NodeSignature if and only if they have the same functor and the same arity. NodeSignature is the true identity of a node family—all schema operations (matching, overlap detection, cycle detection, hashing) are based on NodeSignature, not on variable names or surface syntax.
* **ParsedPattern** — the normalized abstract syntax tree of an expression pattern. Conceptually: `{ signature: NodeSignature, varsByPos: Array<string>, raw: string }`. The `signature` determines identity and matching; `varsByPos` preserves variable names in positional order for variable mapping; `raw` preserves the original string for diagnostics.
* **NodeName** — an identifier string (functor only), e.g., `"full_event"` or `"all_events"`. Used in public API calls to identify node families. Does NOT include variable syntax or arity suffix. **Schema Well-Formedness Invariant:** Each functor appears with exactly one arity in the schema set (enforced by REQ-MATCH-04 and REQ-FACTORY-03). Therefore, at runtime, a `NodeName` uniquely determines a `NodeSignature`.

#### 1.1.2 Schema and Pattern Types

* **SchemaPattern** — an expression string that may contain variables, e.g., `"full_event(e)"` or `"all_events"`. Used ONLY in schema definitions to denote families of nodes and for variable mapping. Must conform to the expression grammar (Section 1.3).

#### 1.1.3 Value Types

* **SimpleValue** - a value type. Defined recursively as: `number | string | boolean | Array<SimpleValue> | Record<string, SimpleValue>`. Two `SimpleValue` objects are equal iff `isEqual` returns `true` for them. Note that it excludes `undefined`, `null`, functions, symbols.
* **ConstValue** - a subtype of `SimpleValue`.
* **ComputedValue** — a subtype of `SimpleValue`.
* **NodeValue** — computed value at a node (always a `ComputedValue`). The term `NodeValue` is an alias for `ComputedValue` in the context of stored node values.

#### 1.1.4 Addressing and Storage Types

* **BindingEnvironment** — a positional array of concrete values: `Array<ConstValue>`. Used to instantiate a specific node from a family. The array length MUST match the arity of the node. Bindings are matched to argument positions by position, not by name.
* **NodeInstance** — a specific node identified by a `NodeName` and `BindingEnvironment`. Conceptually: `{ nodeName: NodeName, bindings: BindingEnvironment }`. Notation: `nodeName@bindings`. Two node instances are identical if they have the same NodeSignature and their bindings are equal (positionally, using `isEqual`).
* **NodeKey** — a string key used for storage, derived from the NodeSignature (or nodeName + arity, given the invariant) and bindings. The specific format is implementation-defined (see Section 1.6).
* **Freshness** — conceptual state: `"up-to-date" | "potentially-outdated"`

#### 1.1.5 Computation Types

* **Computor** — async function: `(inputs: Array<ComputedValue>, oldValue: ComputedValue | undefined, bindings: Array<ConstValue>) => Promise<ComputedValue | Unchanged>`
* **Outcomes** — For any schema node def `S` and arguments `(inputs, oldValue, bindings)`, define `Outcomes(nodeKey, inputs, oldValue) ⊆ ComputedValue`. It represents the set of all **semantic** values that could be produced by the computor in any permitted execution context. This set may be infinite. Note: `Unchanged` is NOT part of `Outcomes` — it is an optimization sentinel only.
* **Computor invocation (spec-only)** — When the operational semantics "invokes a computor", it nondeterministically selects `r ∈ Outcomes(...)` and treats `r` as the returned value of the Promise. In implementation, this corresponds to executing the computor function, which may produce different results on different invocations for nondeterministic computors.
* **Unchanged** — unique sentinel value indicating unchanged computation result. This is an **optimization-only** mechanism: when a computor returns `Unchanged`, the runtime stores the previous value without rewriting it. `Unchanged` MUST NOT be a valid `ComputedValue` (cannot be returned by `pull()`). `Unchanged` does not expand the set of valid semantic results—it is only a shortcut for returning the existing value when that value is semantically admissible for the current inputs.
* **Variable** — parameter placeholder in node schemas (identifiers in argument positions). Variables are internal to schema definitions and not exposed in public API.

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
1. Their expression patterns have the same `NodeSignature` (same functor and arity), AND
2. Their binding environments are equal (compared positionally using `isEqual`)

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

**REQ-ARGS-01 (Bindings Normalization):** If `bindings` is omitted or `undefined`, treat it as `[]`. If the schema arity is not 0, the runtime MUST throw an `ArityMismatchError`.

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

### 1.4 Expression Parsing and Canonicalization (Normative)

This section defines normative procedures for parsing expression patterns into a canonical abstract syntax tree and for canonicalizing schema definitions to make identity and equivalence explicit.

#### 1.4.1 Expression Parsing

**REQ-PARSE-01:** The function `parseExpr(expr: string) -> ParsedPattern` parses an expression string into its canonical abstract syntax tree with the following properties:

1. **Whitespace Normalization:** Leading, trailing, and internal whitespace is normalized according to the grammar (Section 1.3).
2. **Arity-0 Normalization:** Both `ident` and `ident()` parse to the same AST: `{ signature: (ident, 0), varsByPos: [], raw: expr }`.
3. **Variable Extraction:** Variables are extracted in positional order and stored in `varsByPos`.
4. **Signature Computation:** The `signature` field contains `(functor, arity)` where `functor` is the identifier and `arity` is the length of `varsByPos`.

**Example:**

```javascript
parseExpr("all_events")
  → { signature: ("all_events", 0), varsByPos: [], raw: "all_events" }

parseExpr("all_events()")
  → { signature: ("all_events", 0), varsByPos: [], raw: "all_events()" }

parseExpr("full_event(e)")
  → { signature: ("full_event", 1), varsByPos: ["e"], raw: "full_event(e)" }

parseExpr("full_event(x)")
  → { signature: ("full_event", 1), varsByPos: ["x"], raw: "full_event(x)" }

parseExpr("   enhanced_event  ( e , p )   ")
  → { signature: ("enhanced_event", 2), varsByPos: ["e", "p"], raw: "   enhanced_event  ( e , p )   " }
```

**REQ-PARSE-02:** Pattern identity and matching MUST be based solely on `signature` (functor + arity), never on variable names or surface syntax.

#### 1.4.2 Canonical Variable Naming for Schema Equivalence

To make schema hashing and equivalence checking invariant under consistent variable renaming (alpha-equivalence), schemas are canonicalized before hashing or comparison.

**REQ-CANON-01:** The function `canonicalizeNodeDef(nodeDef: NodeDef) -> CanonicalNodeDef` performs the following transformation:

1. **Parse Output:** Parse `nodeDef.output` to get `outputParsed = parseExpr(nodeDef.output)`.
2. **Assign Canonical Variables:** Create a mapping from original output variables to canonical variables `v0, v1, ..., v(n-1)` based on their positional order in `outputParsed.varsByPos`.
3. **Canonicalize Output:** Represent the canonical output as `(functor, arity)` with canonical variable list `["v0", "v1", ..., "v(n-1)"]`.
4. **Canonicalize Inputs:** For each input pattern:
   * Parse the input pattern to get its `signature` and `varsByPos`.
   * Map each input variable to its corresponding output variable by name, then to the canonical variable.
   * Construct the canonical input pattern with the signature and remapped canonical variables.

**Example:**

Original schema:
```javascript
{
  output: "full_event(e)",
  inputs: ["event_data(e)", "metadata(e)"]
}
```

Canonical form:
```javascript
{
  output: { signature: ("full_event", 1), vars: ["v0"] },
  inputs: [
    { signature: ("event_data", 1), vars: ["v0"] },
    { signature: ("metadata", 1), vars: ["v0"] }
  ]
}
```

Renaming `e` to `x` produces the same canonical form:
```javascript
{
  output: "full_event(x)",
  inputs: ["event_data(x)", "metadata(x)"]
}
// Canonicalizes to the same result as above
```

**REQ-CANON-02:** Schema hashing (for storage namespacing and schema identification) MUST use the canonical form of all NodeDefs. Two schemas that differ only in consistent variable renaming MUST produce the same schema hash.

**REQ-CANON-03:** Overlap detection, cycle detection, and arity conflict detection MUST use `NodeSignature` (functor + arity) for pattern matching, independent of variable names.

#### 1.4.3 Canonical Representation Concepts

The canonical representation is used internally for:
* **Schema Indexing:** Organizing schemas by `(functor, arity)` for O(1) lookup.
* **Overlap Detection:** Checking if two patterns have the same `NodeSignature`.
* **Arity Conflict Detection:** Ensuring each functor maps to exactly one arity.
* **Cycle Detection:** Building and analyzing the dependency graph using `NodeSignature` edges.
* **Schema Hashing:** Computing a deterministic hash of the schema for storage namespacing.

**REQ-CANON-04 (Canonical Pattern Signature):** For diagnostic and internal indexing purposes, a NodeSignature MAY be represented as the string `functor + "/" + arity` (e.g., `"full_event/1"`, `"all_events/0"`), but this representation is for human readability only and is not required for storage.

**REQ-CANON-05 (Canonical Expression Form):** For diagnostic purposes, a canonical expression form MAY be rendered as `functor(v0, v1, ..., v(n-1))` with canonical variables. This form is used only for error messages and debugging, not for storage or identity.

**REQ-CANON-06 (Independence from NodeKey):** The canonical representation used for schema operations is distinct from the NodeKey format used for storage. NodeKey format remains implementation-defined (Section 1.7), but MUST be functionally derived from `(NodeSignature, bindings)` and MUST NOT depend on variable names or surface syntax.

#### 1.4.4 End-to-End Examples

These examples demonstrate how the parsing, canonicalization, and addressing model works in practice.

**Example 1: Arity-0 Equivalence**

```javascript
// Schema definitions with arity-0 patterns:
const schema1 = { output: "all_events", inputs: [], computor: async () => [...] };
const schema2 = { output: "all_events()", inputs: [], computor: async () => [...] };

// Both parse to the same NodeSignature:
parseExpr("all_events")    → { signature: ("all_events", 0), varsByPos: [], ... }
parseExpr("all_events()")  → { signature: ("all_events", 0), varsByPos: [], ... }

// Therefore, they are considered overlapping and would trigger SchemaOverlapError
// if both were included in the same schema set.

// Public API calls:
pull("all_events")        // bindings normalized to []
pull("all_events", [])    // equivalent to above

// Both produce the same NodeKey (implementation-defined format, but functionally
// determined by NodeSignature ("all_events", 0) and bindings [])
```

**Example 2: Variable Renaming Invariance**

```javascript
// These two schemas are alpha-equivalent (differ only in variable naming):
const schemaA = {
  output: "full_event(e)",
  inputs: ["event_data(e)", "metadata(e)"],
  computor: async ([data, meta], old, bindings) => ({ ...data, ...meta })
};

const schemaB = {
  output: "full_event(x)",
  inputs: ["event_data(x)", "metadata(x)"],
  computor: async ([data, meta], old, bindings) => ({ ...data, ...meta })
};

// Parsing produces different varsByPos but same signature:
parseExpr("full_event(e)")  → { signature: ("full_event", 1), varsByPos: ["e"], ... }
parseExpr("full_event(x)")  → { signature: ("full_event", 1), varsByPos: ["x"], ... }

// Canonicalization produces identical representations:
canonicalizeNodeDef(schemaA) → {
  output: { signature: ("full_event", 1), vars: ["v0"] },
  inputs: [
    { signature: ("event_data", 1), vars: ["v0"] },
    { signature: ("metadata", 1), vars: ["v0"] }
  ]
}

canonicalizeNodeDef(schemaB) → same as above

// Therefore:
// - They produce the same schema hash
// - They are considered overlapping (would trigger SchemaOverlapError)
// - For the same bindings, they produce the same NodeKey

// Public API:
pull("full_event", [{id: "123"}])
// Works with either schema (but not both in the same graph)
// NodeKey depends on NodeSignature ("full_event", 1) and bindings [{id: "123"}],
// not on whether the schema used variable "e" or "x"
```

**Example 3: NodeSignature-Based Matching**

```javascript
// Schema:
const schema = {
  output: "enhanced_event(e, p)",
  inputs: ["event_context(e)", "photo(p)"],
  computor: async ([ctx, photo], old, bindings) => ({...ctx, photo})
};

// Parsing:
parseExpr("enhanced_event(e, p)")  → { signature: ("enhanced_event", 2), varsByPos: ["e", "p"], ... }
parseExpr("event_context(e)")       → { signature: ("event_context", 1), varsByPos: ["e"], ... }
parseExpr("photo(p)")               → { signature: ("photo", 1), varsByPos: ["p"], ... }

// Pattern matching for dependency edges:
// - enhanced_event depends on event_context because they match by signature? No.
//   They have different signatures: ("enhanced_event", 2) vs ("event_context", 1)
// - If another schema has output "event_context(x)", it matches the input
//   "event_context(e)" because they have the same signature: ("event_context", 1)

// Variable mapping:
// When evaluating enhanced_event@[{id: "evt_123"}, {id: "photo_456"}]:
// - Variable "e" at position 0 of output → bindings[0] = {id: "evt_123"}
// - Variable "p" at position 1 of output → bindings[1] = {id: "photo_456"}
// - Input "event_context(e)" needs variable "e" → extract position 0 → [{id: "evt_123"}]
// - Input "photo(p)" needs variable "p" → extract position 1 → [{id: "photo_456"}]

// Public API:
pull("enhanced_event", [{id: "evt_123"}, {id: "photo_456"}])
// NodeKey derived from NodeSignature ("enhanced_event", 2) and full bindings array
```

### 1.5 Functor Extraction and Pattern Matching (Normative)

**Note:** This section is informational and describes helper operations. The normative parsing and canonicalization procedures are defined in Section 1.4.

**REQ-FUNCTOR-01:** The function `functor(expr)` extracts and returns the head (identifier) of an expression, excluding variable names and whitespace. This is equivalent to extracting the `functor` component of the `NodeSignature` from `parseExpr(expr).signature`.

**Examples:**
* `functor("all_events")` → `"all_events"`
* `functor("event_context(e)")` → `"event_context"`
* `functor("event_context(x)")` → `"event_context"` (same as above)
* `functor("enhanced_event(e, p)")` → `"enhanced_event"`
* `functor("   enhanced_event   (   x, y)   ")` → `"enhanced_event"` (same as above)

**REQ-FUNCTOR-02:** Pattern Matching and Schema Indexing:
* Schema patterns are indexed by `NodeSignature` (functor + arity) at initialization for efficient lookup.
* Original expression strings are preserved in the `raw` field of `ParsedPattern` for error messages and diagnostics.
* All pattern matching operations use `NodeSignature`, never variable names or surface syntax.

**REQ-FUNCTOR-03:** All storage operations MUST use NodeKey as their keys. A NodeKey is derived from the `NodeSignature` (or equivalently, nodeName given the uniqueness invariant) and the `BindingEnvironment`. The specific encoding is implementation-defined (Section 1.6), but MUST be an injective function of `(NodeSignature, bindings)`.

### 1.6 Deep Equality (Normative)

**REQ-EQUAL-01 (Deep Equality Definition):** The function `isEqual(a: SimpleValue, b: SimpleValue): boolean` defines deep equality for `SimpleValue` instances. It is defined recursively as follows:

```javascript
function isEqual(a, b) {
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
  // Important: key order does not matter.
  // Note: key sorting is not required for persistence.
  const keysA = Object.keys(a).sort();
  const keysB = Object.keys(b).sort();

  if (keysA.length !== keysB.length) return false;

  for (let i = 0; i < keysA.length; i++) {
    if (keysA[i] !== keysB[i]) return false;
    if (!isEqual(a[keysA[i]], b[keysA[i]])) return false;
  }

  return true;
}
```

**REQ-EQUAL-02:** Equality of `SimpleValue` instances is defined by the `isEqual` function. Two values are equal if and only if `isEqual(a, b)` returns `true`.

**REQ-EQUAL-03:** Implementations MAY use any internal representation for storage as long as values retrieved from storage are deeply equal (according to `isEqual`) to the values that were stored.

### 1.7 NodeKey Format (Normative)

**REQ-KEY-01:** A NodeKey is a string that uniquely identifies a `NodeInstance` in storage. Each `NodeInstance` is determined by its `NodeSignature` and `BindingEnvironment`.

**REQ-KEY-02:** All storage operations (storing values, freshness, dependencies) MUST use NodeKey as the key.

**REQ-KEY-03:** The specific format of NodeKey is implementation-defined. Different implementations MAY use different key formats.

**REQ-KEY-04 (Functional Contract):** NodeKey MUST be an injective (one-to-one) function of `(NodeSignature, bindings)`. Given the schema well-formedness invariant (each functor has unique arity), this is equivalent to being a function of `(nodeName, bindings)`.

**REQ-KEY-05 (Canonical Independence):** The NodeKey derivation MUST NOT depend on:
* Whether the schema pattern used `ident` vs `ident()` for arity-0 expressions.
* Whitespace in schema patterns.
* Variable names in schema patterns (e.g., `full_event(e)` vs `full_event(x)` must produce the same NodeKey for the same bindings).

In other words, NodeKey depends only on the `NodeSignature` (functor + arity) and the `BindingEnvironment`, not on any aspect of surface syntax or variable naming.

**REQ-KEY-06 (Uniqueness):** Each `NodeInstance` MUST map to exactly one NodeKey. Two `NodeInstance` values with different `NodeSignature` or non-equal `bindings` (compared using `isEqual`) MUST map to different NodeKeys.

### 1.8 Schema Definition (Normative)

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

**REQ-SCHEMA-03:** A **source node** is any node instance matching a schema where `inputs = []`.

**REQ-SCHEMA-04:** All variable names within an expression MUST be unique. Expressions with duplicate variable names (e.g., `event(a, b, c, b, d)` where `b` appears twice) MUST be rejected with an `InvalidSchemaError`. This requirement applies to both `output` and `inputs` expressions in node definitions.

**REQ-SCHEMA-05:** The `isDeterministic` and `hasSideEffects` fields are REQUIRED in all `NodeDef` definitions. They MAY NOT be stored in the database persistence layer.

### 1.9 Variable Name Mapping and Positional Bindings (Normative)

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

### 1.10 Pattern Matching (Normative)

**REQ-MATCH-01:** A schema output pattern `P` **matches** a nodeName `N` if and only if:
1. The `NodeSignature` of `P` has the same functor as `N`.

Because a public `nodeName` does not encode arity, the schema is the single source of truth for arity. The binding array length is validated separately (REQ-PULL-02, REQ-INV-03), and ambiguous arities for the same functor are prohibited (REQ-MATCH-04).

**REQ-MATCH-02:** Two output patterns **overlap** if and only if they have the same `NodeSignature` (same functor and same arity). Equivalently, two patterns overlap if `parseExpr(P1).signature == parseExpr(P2).signature`.

**REQ-MATCH-03:** The system MUST reject graphs with overlapping output patterns at initialization (throw `SchemaOverlapError`).

**REQ-MATCH-04:** Each functor MUST have a single, unique arity across all schema outputs. The system MUST reject graphs where the same functor appears with different arities (throw `SchemaArityConflictError`). This invariant ensures that `NodeName` uniquely determines `NodeSignature` at runtime.

**Note on NodeSignature-Based Matching:** All pattern matching in schema definitions is based on `NodeSignature` (functor + arity) and does not consider variable names or surface syntax. The patterns `full_event(e)` and `full_event(x)` have the same `NodeSignature` and are therefore considered identical for all schema operations. Variable names are preserved only for variable mapping between inputs and outputs (Section 1.9).

**Note on Public API:** The public API uses only the nodeName (e.g., `"full_event"`), not expression patterns. The arity is determined by the schema, and callers must provide bindings that match the expected arity.

### 1.11 Cycle Detection (Normative)

**REQ-CYCLE-01:** A directed edge exists from Schema S to Schema T if and only if:
1. S has an input pattern I
2. T has an output pattern O
3. Patterns I and O have the same `NodeSignature` (same functor and arity)

**REQ-CYCLE-02:** The system MUST reject graphs with cycles at initialization (throw `SchemaCycleError`). Cycle detection operates on the dependency graph where nodes are `NodeSignature` values and edges are determined by REQ-CYCLE-01.

### 1.12 Materialization (Normative)

**REQ-MAT-01:** A **materialized node** is any `NodeInstance` (identified by `NodeKey`) for which the implementation maintains state (values, freshness, dependencies, etc.).

**REQ-MAT-02:** Materialization occurs through:
* `pull(nodeName, bindings)` — materializes `NodeInstance`, computes and stores value, marks `up-to-date`
* `invalidate(nodeName, bindings)` — materializes `NodeInstance`, marks `potentially-outdated`

**REQ-MAT-03:** Once materialized, a node instance remains materialized across restarts (required by REQ-PERSIST-01 behavioral equivalence).

### 1.13 Notes on Nondeterminism and Side Effects (Normative)

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
1. Its observable behavior matches the baseline semantics (properties P1′, P2, P3, P4)
2. It satisfies all normative optimization requirements (e.g., REQ-PULL-04)

### 2.1 pull(nodeName, bindings) → NodeValue

**Signature:** `pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<ComputedValue>`

**REQ-PULL-01:** `pull` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-PULL-02:** `pull` MUST throw `ArityMismatchError` if `bindings` array length (after normalization per REQ-ARGS-01) does not match the arity defined in the schema for the given nodeName.

**REQ-PULL-05 (Validation-Before-Key Ordering):** Implementations MUST validate schema existence (REQ-PULL-01) and arity (REQ-PULL-02) BEFORE computing the NodeKey or touching any storage. The NodeKey derivation function itself MUST be a pure function that does not read from or write to storage and cannot throw exceptions for invalid inputs (validation errors must be thrown before calling it).

**Big-Step Semantics:**

```javascript
pull(nodeName, B):
  // 1. Validate schema and arity FIRST
  validate_schema_exists(nodeName)         // throws InvalidNodeError if missing
  validate_arity_matches(nodeName, B)      // throws ArityMismatchError if wrong length
  
  // 2. Only after validation, compute NodeKey (pure function, no side effects)
  nodeKey = createNodeKey(nodeName, B)
  
  // 3. Proceed with graph traversal
  inputs_instances = instantiate_inputs(nodeKey)
  inputs_values = [pull(I_nodeName, I_bindings) for I in inputs_instances]
  if isUpToDate(nodeKey) return stored_value(nodeKey)
  old_value = stored_value(nodeKey)
  r ∈ Outcomes(nodeKey, inputs_values, old_value)  // nondeterministic choice
  store(nodeKey, r)
  return r
```

**Note:** This pseudocode describes the abstract input-output semantics using nondeterministic choice from outcome sets. The key requirement is that validation (steps that can throw errors) happens before any storage operations or NodeKey computation.

**REQ-PULL-03:** `pull` MUST ensure each computor is invoked at most once per top-level call for each unique node instance (property P3).

**REQ-PULL-04 (No spurious recomputation):** If a materialized node instance is `up-to-date` at the time it is encountered during a `pull()`, the implementation MUST return its stored value and MUST NOT invoke its computor. This makes `pull()` use call-by-need semantics and prevents repeated effects/resampling for up-to-date nodes.

**Efficiency Optimization (Implementation-Defined):**

Implementations MAY use any strategy to achieve property P3 (e.g., memoization, freshness checks, in-flight tracking). The specific mechanism is not prescribed.

### 2.2 invalidate(nodeName, bindings)

**Signature:** `invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>`

**REQ-INV-01:** `invalidate` MUST return a `Promise<void>`.

**REQ-INV-02:** `invalidate` MUST throw `InvalidNodeError` if no schema output has the given nodeName.

**REQ-INV-03:** `invalidate` MUST throw `ArityMismatchError` if `bindings` array length (after normalization per REQ-ARGS-01) does not match the arity defined in the schema.

**REQ-INV-05 (Validation-Before-Key Ordering):** Like `pull`, `invalidate` MUST validate schema existence and arity BEFORE computing NodeKey or touching storage.

**Effects:**
1. Validate schema exists and arity matches (throws on failure)
2. Compute `NodeKey` from `nodeName@bindings` (pure function)
3. Mark that node instance as `potentially-outdated`
4. Mark all materialized transitive dependents as `potentially-outdated`

**Important:** `invalidate()` does NOT write a value. Values are provided by computors when nodes are pulled.

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

**REQ-FACTORY-02:** MUST compute schema identifier for internal storage namespacing. The schema identifier MUST be computed from the canonical form of all NodeDefs (per REQ-CANON-02), ensuring that schemas differing only in consistent variable renaming produce the same identifier.

**REQ-FACTORY-03:** MUST reject schemas where the same functor appears with different arities (throw `SchemaArityConflictError`). This enforces the invariant that each `NodeName` (functor) uniquely determines a `NodeSignature` at runtime.

### 3.2 IncrementalGraph Interface

```typescript
interface IncrementalGraph {
  pull(nodeName: NodeName, bindings?: BindingEnvironment): Promise<ComputedValue>;
  invalidate(nodeName: NodeName, bindings?: BindingEnvironment): Promise<void>;
  
  // Debug interface (REQUIRED)
  debugGetFreshness(nodeName: NodeName, bindings?: BindingEnvironment): Promise<"up-to-date" | "potentially-outdated" | "missing">;
  debugListMaterializedNodes(): Promise<Array<string>>;
  debugGetSchemaHash(): string;
}
```

**REQ-IFACE-01:** Implementations MUST provide type guard `isIncrementalGraph(value): boolean`.

**REQ-IFACE-02:** For atom-expressions (arity 0), `bindings` parameter defaults to `[]` and may be omitted.

**REQ-IFACE-03:** For compound-expressions (arity > 0), `bindings` MUST be provided with length matching the expression arity.

**REQ-IFACE-04:** Implementations MUST provide the debug interface methods:
* `debugGetFreshness(nodeName, bindings?)` — Returns the freshness state of a specific node instance. Returns `"missing"` for unmaterialized nodes.
* `debugListMaterializedNodes()` — Returns an array of `NodeKey` strings for all materialized node instances.
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

**REQ-COMP-01′ (Conditional Determinism):** If `NodeDef.isDeterministic` is `true`, the computor MUST be treated as deterministic with respect to `(nodeKey, inputs, oldValue)`. Formally, `Outcomes(nodeKey, inputs, oldValue)` MUST always be a singleton set.

**REQ-COMP-02′ (Conditional Purity):** If `NodeDef.hasSideEffects` is `false`, the computor MUST be treated as one that does not have observable side effects.

**REQ-COMP-03:** Computors MAY return `Unchanged` sentinel to indicate no value change.

**REQ-COMP-04:** Implementations MUST expose `makeUnchanged()` factory and `isUnchanged(value)` type guard.

**REQ-COMP-05:** The `bindings` parameter is a positional array matching the schema output pattern's arguments by position. For example, if the output pattern is `full_event(e)`, then `bindings[0]` contains the value for the first argument position, `e`.

### 3.5 Error Taxonomy

All errors MUST provide stable `.name` property and required fields:

| Error Name | Required Fields | Thrown When |
|------------|----------------|-------------|
| `InvalidExpressionError` | `expression: string` | Invalid expression syntax (schema parsing) |
| `InvalidNodeError` | `nodeName: string` | No schema matches the given nodeName (public API) |
| `SchemaOverlapError` | `patterns: Array<string>` | Overlapping output patterns at init (schema validation) |
| `InvalidSchemaError` | `schemaPattern: string` | Schema definition problems at init (schema validation) |
| `SchemaCycleError` | `cycle: Array<string>` | Cyclic schema dependencies at init (schema validation) |
| `MissingValueError` | `nodeKey: string` | Up-to-date node has no stored value (internal) |
| `ArityMismatchError` | `nodeName: string, expectedArity: number, actualArity: number` | Bindings array length does not match node arity (public API) |
| `SchemaArityConflictError` | `nodeName: string, arities: Array<number>` | Same head with different arities in schema (schema validation) |
| `InvalidUnchangedError` | `nodeKey: string` | Computor returned `Unchanged` when oldValue is `undefined` (internal) |

**REQ-ERR-01:** All error types MUST provide type guard functions (e.g., `isInvalidExpressionError(value): boolean`).

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

The graph MUST maintain these invariants at all times (including after restarts):

**I1 (Outdated Propagation):** If node instance `N@B` is `potentially-outdated`, all transitive dependents of `N@B` that have been previously materialized (pulled or invalidated) are also `potentially-outdated`.

**I2 (Up-to-Date Upstream):** If node instance `N@B` is `up-to-date`, all transitive dependencies of `N@B` are also `up-to-date`.

**I3 (Value Admissibility):** If node instance `N@B` is `up-to-date`, then letting `inputs_values` be the stored values of its instantiated input node instances, the stored value `v` of `N@B` MUST satisfy:
* there exists some `oldValue` such that `v ∈ Outcomes(nodeKey, inputs_values, oldValue)`.

This invariant uses an existential quantifier over `oldValue` to avoid requiring storage of the previous value. All nodes, including source nodes, satisfy I3 the same way: their stored value must be consistent with their computor's `Outcomes(...)` set.

### 4.3 Correctness Properties

**P1′ (Soundness under nondeterminism):** For any `pull(nodeName, B)` that returns value `v`, `v` is a value permitted by the nondeterministic big-step semantics. That is, there exists a derivation where all computor invocations choose elements from their `Outcomes(...)` sets and the final returned value is `v`.

**P1-det (Deterministic specialization, corollary):** If all computors reachable from node instance `N@B` have `isDeterministic=true` and `hasSideEffects=false`, then P1′ strengthens to: `pull(N, B)` produces the same result as recomputing all values from scratch with the same input values. This recovers the traditional semantic equivalence property for the deterministic and pure subset of computors.

**P2 (Progress):** Every `pull(N, B)` call terminates (assuming computors terminate).

**P3 (Single Invocation):** Each computor invoked at most once per top-level `pull()` for each unique node instance.

**P4 (Freshness Preservation):** After `pull(N, B)`, the node instance `N@B` and all transitive dependencies are `up-to-date`.

---

## 5. Concurrency (Normative)

**REQ-CONCUR-01 (Sequential Consistency):** All `pull()` and `invalidate()` operations MUST behave as if they were executed in some sequential order, even when invoked concurrently.

Formally: For any concurrent execution with operations `{Op₁, Op₂, ..., Opₙ}`, there MUST exist a sequential ordering `Opₚ₍₁₎, Opₚ₍₂₎, ..., Opₚ₍ₙ₎` (where `p` is a permutation) such that the observable results are identical to executing the operations in that sequential order.

**REQ-CONCUR-02:** The observable state of the graph (values, freshness, materialization) MUST be consistent with some sequential execution at all times. No operation may observe partial state from another concurrent operation.

**Note:** Implementations MAY use any concurrency control mechanism to achieve these requirements. The specific strategy (locks, transactions, queuing, etc.) is implementation-defined.
