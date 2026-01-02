# Sublevel-Based Namespacing Design

## Executive Summary

This document proposes a redesign of the dependency graph storage layer to use LevelDB sublevels for isolation and namespacing, replacing the current ad-hoc string prefix approach. The new design provides:

1. **Strong typing**: Each sublevel has a well-defined key-value type contract
2. **Absolute type safety**: **Zero type casts** in the implementation—all types enforced through interfaces
3. **Logical isolation**: Different data concerns separated into distinct sublevels
4. **Simple database interface**: All databases expose a common, well-typed interface
5. **Maintainability**: Clear separation of concerns and reduced coupling
6. **Implementation freedom**: Spec no longer dictates internal key prefixes like `"freshness:"`

## Current Issues

### 1. Multiple Inconsistent Prefix Schemes

The current implementation uses multiple string-prefix schemes that are manually constructed:

```javascript
// From graph_storage.js
function inputsKey(node) {
    return `dg:${schemaHash}:inputs:${node}`;
}

function revdepKey(input, node) {
    return `dg:${schemaHash}:revdep:${input}:${node}`;
}

// From database/types.js
function freshnessKey(key) {
    return `freshness:${key}`;
}

// From graph_storage.js listMaterializedNodes()
return allKeys.filter(k => 
    !k.startsWith("dg:") && 
    !k.startsWith("freshness:")
);
```

**Problems**:
- Manual string construction is error-prone
- Prefix filtering logic is fragile and scattered
- No compile-time guarantees about key structure
- Difficult to change prefix schemes without breaking changes

### 2. Lack of Type Safety

The current `Database` interface uses a single undifferentiated key-value store:

```javascript
/** @typedef {DatabaseValue | Freshness} DatabaseStoredValue */
/** @typedef {import('level').Level<string, DatabaseStoredValue>} LevelDB */
```

**Problems**:
- All values stored as `DatabaseStoredValue` union type
- Runtime type checking required (isDatabaseValue, isFreshness)
- **Type casting**
- No static guarantees about what type of value exists at a given key
- **Violates project's "no type casting" principle**

**Critical Impact**: The project explicitly forbids type casting for safety reasons. The current implementation resorts to type casts because a single key-value store mixes incompatible types. This is a fundamental architectural flaw that the new design must eliminate entirely.

### 3. Implicit Naming Conventions

Different data types are identified by key patterns rather than explicit structure:

- **Node values**: `<canonical-node-name>` (no prefix)
- **Freshness**: `freshness:<canonical-node-name>`
- **Inputs index**: `dg:<schemaHash>:inputs:<node>`
- **Reverse dependencies**: `dg:<schemaHash>:revdep:<input>:<node>`

**Problems**:
- Key collision risks between different schemas or data types
- Implicit contracts that must be remembered
- Filtering logic must know about all prefixes
- No schema versioning or migration support

### 4. SchemaHash as Namespace Boundary

The current design uses `schemaHash` as a namespace discriminator:

```javascript
// From class.js
this.schemaHash = crypto
    .createHash("md5")
    .update(schemaStr)
    .digest("hex")
    .slice(0, 16);
```

**Problems**:
- Hash collision risk (16 hex chars = 64 bits)
- No way to list all schemas or enumerate instances
- Difficult to debug (opaque hash values)
- No schema metadata storage

### 5. Mixed Storage Responsibilities

The database stores multiple concerns without clear separation:

- **Values**: Actual node output values
- **Freshness**: Freshness state for each node
- **Index data**: Inputs and reverse dependency indices
- **Application data**: Other system data mixed in

**Problems**:
- Cannot independently backup or restore indices vs values
- No ability to recompute indices from values
- All-or-nothing queries (cannot efficiently list just values or just indices)

## Proposed Design

### High-Level Architecture

**Schema Hash is the Namespace Boundary**: Each schema hash gets its own isolated namespace containing all data for that graph instance.

```
Root Database (Level<string, object>)
└── <schemaHash>: SubLevel                                // Schema hash is the namespace boundary
    ├── values: SubLevel<string, DatabaseValue>           // Node output values (per-schema)
    ├── freshness: SubLevel<string, Freshness>            // Node freshness state (per-schema)
    ├── inputs: SubLevel<string, InputsRecord>            // Node -> inputs mapping
    └── revdeps: SubLevel<string, never>                  // Reverse dependencies (nested by input)
        └── <inputNode>: SubLevel<string, null>           // All dependents of this input
            └── <dependentNode>: null                     // Dependent existence marker
```

**Key Design Decisions**:
1. **Schema hash = namespace**: All data (values, freshness, indices) is isolated per schema
2. **No composite keys**: Revdeps use nested sublevels instead of `"<input>:<dependent>"` composite keys
3. **No string prefix logic**: `listDependents(input)` just iterates keys of sublevel `<inputNode>`—no `startsWith()` filtering

### Type Definitions

#### Common Database Interface

All databases (values, freshness, inputs, revdeps) implement a common, simple, well-typed interface:

```javascript
/**
 * Generic typed database interface.
 * @template TKey - The key type (typically string)
 * @template TValue - The value type
 * @typedef {object} GenericDatabase
 * @property {(key: TKey) => Promise<TValue | undefined>} get - Retrieve a value
 * @property {(key: TKey, value: TValue) => Promise<void>} put - Store a value
 * @property {(key: TKey) => Promise<void>} del - Delete a value
 * @property {() => AsyncIterable<TKey>} keys - Iterate over all keys
 * @property {() => Promise<void>} clear - Clear all entries
 */
```

#### Concrete Database Types

```javascript
/**
 * Database for storing node output values.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: the computed value (string, number, object, array, null, boolean)
 * @typedef {GenericDatabase<string, DatabaseValue>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state object
 * @typedef {GenericDatabase<string, Freshness>} FreshnessDatabase
 */

/**
 * Database for storing node input dependencies.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: inputs record with array of dependency names
 * @typedef {GenericDatabase<string, InputsRecord>} InputsDatabase
 */

/**
 * Database for reverse dependency index using nested sublevels.
 * Structure: revdeps/<inputNode>/<dependentNode> -> null
 * Access pattern: Get sublevel for <inputNode>, then iterate its keys to list all dependents
 * This eliminates composite keys and string prefix logic entirely.
 * @typedef {object} RevdepsDatabase
 * @property {(inputNode: string) => GenericDatabase<string, null>} getInputSublevel - Get sublevel for a specific input
 * @property {() => AsyncIterable<string>} keys - Iterate over all input nodes that have dependents
 */

/**
 * A record storing the input dependencies of a node.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 */

/**
 * Storage container for a single dependency graph schema.
 * All data (values, freshness, indices) is isolated per schema hash.
 * @typedef {object} SchemaStorage
 * @property {ValuesDatabase} values - Node output values (per-schema)
 * @property {FreshnessDatabase} freshness - Node freshness state (per-schema)
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies index (nested sublevels)
 */

/**
 * GraphStorage exposes typed databases as fields.
 * All databases are from the same schema namespace - no global values/freshness.
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values - Node values (from schema storage)
 * @property {FreshnessDatabase} freshness - Node freshness (from schema storage)
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies (nested sublevels)
 * @property {() => BatchBuilder} batch - Create a batch builder for atomic operations
 * @property {(node: string, inputs: string[]) => Promise<void>} ensureNodeIndexed - Index a node's dependencies
 * @property {(input: string) => Promise<string[]>} listDependents - List all dependents of an input
 * @property {(node: string) => Promise<string[] | null>} getInputs - Get inputs for a node
 */

/**
 * Interface for batch operations on a specific database.
 * @template TValue
 * @typedef {object} BatchDatabaseOps
 * @property {(key: string, value: TValue) => void} put - Queue a put operation
 * @property {(key: string) => void} del - Queue a delete operation
 */

/**
 * Batch builder for atomic operations across multiple databases.
 * Each database field is properly typed - no unions or type casts needed.
 * @typedef {object} BatchBuilder
 * @property {BatchDatabaseOps<DatabaseValue>} values - Batch operations for values database
 * @property {BatchDatabaseOps<Freshness>} freshness - Batch operations for freshness database
 * @property {BatchDatabaseOps<InputsRecord>} inputs - Batch operations for inputs database
 * @property {() => Promise<void>} write - Execute all queued operations atomically
 */

/**
 * Root database structure.
 * Schema hash is the namespace boundary - all data is stored per-schema.
 * @typedef {object} RootDatabase
 * @property {(schemaHash: string) => SchemaStorage} getSchemaStorage - Get schema-specific storage (creates if needed)
 * @property {() => AsyncIterable<string>} listSchemas - List all schema hashes in the database
 */
```

### Type Safety Guarantees

#### Zero Type Casts Policy

**CRITICAL**: The new implementation MUST contain **zero type casts**. This is enforced through:

1. **Separate typed databases**: Each database has a single, well-defined value type
2. **Exposed as fields**: `GraphStorage` exposes databases as properly typed fields
3. **Type inference**: TypeScript/JSDoc can infer types without casts

```javascript
// ✅ Correct: No type cast needed
const value = await graphStorage.values.get(nodeName);
// Type: DatabaseValue | undefined (no cast required)

const freshness = await graphStorage.freshness.get(nodeName);
// Type: Freshness | undefined (no cast required)

const inputs = await graphStorage.schema.inputs.get(nodeName);
// Type: InputsRecord | undefined (no cast required)

// ❌ FORBIDDEN: Type casting
const value = /** @type {DatabaseValue} */ (await db.get(key)); // NEVER DO THIS
```

#### Common Interface Pattern

All databases implement `GenericDatabase<TKey, TValue>`, providing:
- Uniform API across all storage
- Type-safe operations without casts
- Easy to test with mocks
- Clear contracts

```javascript
/**
 * Generic database interface - all databases implement this.
 * @template TKey
 * @template TValue
 */
interface GenericDatabase<TKey, TValue> {
    get(key: TKey): Promise<TValue | undefined>;
    put(key: TKey, value: TValue): Promise<void>;
    del(key: TKey): Promise<void>;
    keys(): AsyncIterable<TKey>;
    clear(): Promise<void>;
}
```

### Key Advantages

#### 1. Strong Typing with Zero Type Casts

Each database has a precise type contract through the `GenericDatabase` interface:

```javascript
// ✅ Type-safe: No casts needed, types inferred from database field
const value = await graphStorage.values.get(canonicalNode);
// Type: DatabaseValue | undefined

const freshness = await graphStorage.freshness.get(canonicalNode);
// Type: Freshness | undefined

const inputsRecord = await graphStorage.schema.inputs.get(canonicalNode);
// Type: InputsRecord | undefined

// ✅ Type-safe: All databases share the same interface
function clearDatabase<K, V>(db: GenericDatabase<K, V>) {
    await db.clear();
}

clearDatabase(graphStorage.values);    // Works
clearDatabase(graphStorage.freshness); // Works
clearDatabase(graphStorage.schema.inputs); // Works

// ❌ Old way: runtime type checking + type casting
const storedValue = await database.get(key);
if (isDatabaseValue(storedValue)) {
    const value = /** @type {DatabaseValue} */ (storedValue); // Type cast required!
    // ...
} else if (isFreshness(storedValue)) {
    const freshness = /** @type {Freshness} */ (storedValue); // Type cast required!
    // ...
}
```

#### 2. Logical Isolation

All data is isolated per schema hash (the namespace boundary):

```javascript
// Values database (per-schema, not global)
await graphStorage.values.put(node, computedValue);

// Freshness database (per-schema, no collision with other schemas)
await graphStorage.freshness.put(node, 'up-to-date');

// Inputs index
await graphStorage.inputs.put(node, { inputs: ['input1', 'input2'] });

// Revdeps using nested sublevels (no composite keys)
const inputSublevel = graphStorage.revdeps.getInputSublevel(input);
await inputSublevel.put(node, null); // Just mark that node depends on input

// Multiple schemas can coexist with identical node names - no collisions
const schema1 = await rootDb.getSchemaStorage('hash1');
const schema2 = await rootDb.getSchemaStorage('hash2');
await schema1.values.put("user('alice')", {name: 'Alice from schema1'});
await schema2.values.put("user('alice')", {name: 'Alice from schema2'});
// These are completely isolated - different namespaces

// Atomic updates across databases using batch builder
const batch = graphStorage.batch();
batch.values.put(node, computedValue);
batch.freshness.put(node, 'up-to-date');
batch.inputs.put(node, { inputs: ['dep1', 'dep2'] });
await batch.write(); // All execute atomically
```

#### 3. No Manual String Construction or Ad-hoc Prefixes

**CRITICAL**: The implementation uses **only sublevels**, with **zero ad-hoc string prefixes** or composite keys:

```javascript
// ❌ Old way: manual prefix construction and composite keys
const inputsKey = `dg:${schemaHash}:inputs:${node}`;
const freshnessKey = `freshness:${node}`; // Ad-hoc prefix
const revdepKey = `dg:${schemaHash}:revdep:${input}:${node}`; // Composite key
await database.put(inputsKey, { inputs: [...] });
await database.put(freshnessKey, 'up-to-date');
await database.put(revdepKey, null);

// Then later: prefix filtering to find dependents
const prefix = `dg:${schemaHash}:revdep:${input}:`;
const keys = await database.keys(prefix);
const dependents = keys.map(k => k.substring(prefix.length)); // String parsing!

// ✅ New way: Only sublevels, no string prefixes or composite keys
await graphStorage.inputs.put(node, { inputs: [...] });
await graphStorage.freshness.put(node, 'up-to-date');

// Revdeps use nested sublevels - no composite keys
const inputSublevel = graphStorage.revdeps.getInputSublevel(input);
await inputSublevel.put(node, null);

// Finding dependents: just iterate the sublevel, no string parsing
const dependents = [];
for await (const dependent of inputSublevel.keys()) {
    dependents.push(dependent);
}
// LevelDB sublevels handle all namespacing internally
```

#### 4. Clear Enumeration

Each database can be enumerated independently, all within a schema namespace:

```javascript
// List all materialized nodes for THIS schema
const materializedNodes = [];
for await (const key of graphStorage.values.keys()) {
    materializedNodes.push(key);
}

// List all nodes with freshness state for THIS schema
const nodesWithFreshness = [];
for await (const key of graphStorage.freshness.keys()) {
    nodesWithFreshness.push(key);
}

// List all dependents of an input - no string filtering needed!
const inputSublevel = graphStorage.revdeps.getInputSublevel(inputNode);
const dependents = [];
for await (const dependent of inputSublevel.keys()) {
    dependents.push(dependent); // Just the node name, no parsing
}

// List all schemas in the database
const allSchemas = [];
for await (const schemaHash of rootDb.listSchemas()) {
    allSchemas.push(schemaHash);
}
```

#### 5. Atomic Operations with Builder Pattern

The batch builder provides strongly-typed atomic operations across multiple databases:

```javascript
// ✅ Builder pattern: strongly typed, no casts needed
const batch = graphStorage.batch();
batch.values.put(node, computedValue);        // Type: DatabaseValue
batch.freshness.put(node, 'up-to-date');      // Type: Freshness
batch.inputs.put(node, { inputs: [...] });    // Type: InputsRecord
await batch.write(); // All operations execute atomically

// ❌ Old approach: generic batch with type union problems
// await database.batch([
//     { type: 'put', db: values, key: node, value: computedValue },
//     { type: 'put', db: freshness, key: node, value: 'up-to-date' },
// ]); // Type inference fails - V becomes DatabaseValue | Freshness

// Each operation is properly typed:
batch.values.put(node, 'up-to-date');  // ❌ Compile error: string is not DatabaseValue
batch.freshness.put(node, {data: 1});  // ❌ Compile error: object is not Freshness
```

**Why Builder Pattern?**
- Maintains strong typing for heterogeneous operations
- No type casts or unions needed
- Clear, fluent API
- Internally upcasts to `object` for LevelDB (implementation detail)

## Specification Updates Required

### Remove Hardcoded Key Prefix Convention

**CRITICAL**: The current spec hardcodes the `freshnessKey()` convention:

```javascript
// From dependency-graph.md
function freshnessKey(nodeKey: string): string {
  return `freshness:${nodeKey}`;
}
```

**This MUST be removed from the spec**. Key prefixes are **implementation details**, not API contracts.

#### Required Changes to dependency-graph.md

1. **Remove "Freshness Key Convention" section** (around line 1043)
   - Delete the `freshnessKey()` function definition
   - Delete any mention of `"freshness:"` prefix

2. **Update "Database Storage Model" section** (around line 300)
   - Remove: "**Freshness Keys:** Use the same convention with a prefix: `'freshness:' + canonical_node_name`"
   - Remove examples: `'freshness:all_events'`, `"freshness:event_context('id123')"`

3. **Clarify that key naming is implementation-defined**:
   ```markdown
   ### Storage Requirements (Normative)
   
   - Node values MUST be persistable and retrievable by canonical node name
   - Freshness state MUST be persistable and retrievable by canonical node name
   - The specific key naming scheme is implementation-defined
   - Implementations MUST ensure no key collisions between values and freshness
   ```

4. **Update test requirements**:
   ```markdown
   ### Test Requirements
   
   - Tests MUST NOT assert specific key formats or prefixes
   - Tests MUST use only the public `Database` interface
   - Tests MUST verify behavior, not implementation details
   ```

#### Rationale

The spec is a **behavioral contract**, not an implementation guide. By specifying `"freshness:"` as a prefix, the spec:
- Locks implementations into a specific storage strategy
- Prevents use of sublevels or other namespacing approaches
- Exposes implementation details as API contracts
- Violates separation of concerns

With sublevels, there is **no `"freshness:"` prefix at all**—it's handled by LevelDB's sublevel mechanism internally.

## Implementation Plan

### Phase 1: Create Typed Database Abstraction (Low Risk)

**Goal**: Introduce typed database interface and sublevel wrappers.

**Changes**:
1. Create new module: `backend/src/generators/database/typed_database.js`
   - Define `GenericDatabase<TKey, TValue>` interface
   - Implement wrapper class that adapts LevelDB sublevel to `GenericDatabase` interface
   - **CRITICAL**: No type casts in implementation—enforce types through wrapper

2. Create new module: `backend/src/generators/database/root_database.js`
   - Implement `RootDatabase` class with typed database fields:
     ```javascript
     class RootDatabase {
         /** @type {ValuesDatabase} */
         values;
         /** @type {FreshnessDatabase} */
         freshness;
         /** @param {string} schemaHash */
         getSchemaStorage(schemaHash) { ... }
     }
     ```
   - Factory function `makeRootDatabase(levelDbPath)` creates all sublevels

**Risk**: Low - additive changes only, existing code unaffected

**Files affected**: 2 new

### Phase 2: Rewrite GraphStorage with Typed Databases (Medium Risk)

**Goal**: Rewrite `graph_storage.js` to expose typed databases as fields, eliminate all type casts, string prefixes, and composite keys.

**Changes**:
1. Update `makeGraphStorage()` signature:
   ```javascript
   /**
    * @param {RootDatabase} rootDatabase
    * @param {string} schemaHash
    * @returns {GraphStorage}
    */
   function makeGraphStorage(rootDatabase, schemaHash) {
       const schemaStorage = rootDatabase.getSchemaStorage(schemaHash);
       
       return {
           // Expose all databases as fields (all from schema storage)
           values: schemaStorage.values,
           freshness: schemaStorage.freshness,
           inputs: schemaStorage.inputs,
           revdeps: schemaStorage.revdeps,
           
           // Batch builder for atomic operations
           batch() {
               return makeBatchBuilder(rootDatabase, schemaHash);
           },
           
           // Helper methods
           async ensureNodeIndexed(node, inputs) {
               // Use batch for atomic updates
               const batch = this.batch();
               batch.inputs.put(node, { inputs });
               
               // Update revdeps using nested sublevels
               for (const input of inputs) {
                   const inputSublevel = schemaStorage.revdeps.getInputSublevel(input);
                   await inputSublevel.put(node, null);
               }
               
               await batch.write();
           },
           
           async listDependents(input) {
               // No string filtering - just iterate the input's sublevel
               const inputSublevel = schemaStorage.revdeps.getInputSublevel(input);
               const dependents = [];
               for await (const dependent of inputSublevel.keys()) {
                   dependents.push(dependent);
               }
               return dependents;
           },
           
           async getInputs(node) {
               const record = await schemaStorage.inputs.get(node);
               return record ? record.inputs : null;
           },
       };
   }
   ```

2. **Delete all key construction functions**:
   ```javascript
   // ❌ DELETE: freshnessKey(), inputsKey(), revdepKey(), revdepPrefix()
   // These are replaced by typed database fields and nested sublevels
   ```

3. **Remove all type-casting code** (FIXME at line 200):
   ```javascript
   // ❌ OLD: Type cast required
   const value = /** @type {DatabaseValue} */ (await database.get(key));
   
   // ✅ NEW: No cast needed - type inferred from database field
   const value = await graphStorage.values.get(node);
   ```

4. Update `listMaterializedNodes()` - no filtering needed:
   ```javascript
   async function listMaterializedNodes() {
       const keys = [];
       for await (const key of graphStorage.values.keys()) {
           keys.push(key);
       }
       return keys;
   }
   // No need to filter out "freshness:" or "dg:" prefixes - they're in separate schemas!
   ```

5. **Remove all composite key logic**:
   ```javascript
   // ❌ OLD: Composite keys and string parsing
   const revdepKey = `${input}:${node}`;
   await db.put(revdepKey, null);
   const prefix = `${input}:`;
   const keys = await db.keys(prefix);
   const dependents = keys.map(k => k.substring(prefix.length));
   
   // ✅ NEW: Nested sublevels, no string manipulation
   const inputSublevel = graphStorage.revdeps.getInputSublevel(input);
   await inputSublevel.put(node, null);
   const dependents = [];
   for await (const dep of inputSublevel.keys()) {
       dependents.push(dep);
   }
   ```

**Risk**: Medium - changes internal implementation, but API unchanged

**Files affected**: 1 modified (`graph_storage.js`)

### Phase 3: Update DependencyGraph Class (Medium Risk)

**Goal**: Update DependencyGraph to use schema-namespaced storage.

**Changes**:
1. Update `class.js` to pass RootDatabase and schemaHash:
   ```javascript
   constructor(schema, rootDatabase, capabilities) {
       // ... validation
       
       this.schemaHash = /* compute hash */;
       
       // Pass rootDatabase and schemaHash to GraphStorage
       // GraphStorage gets schema-namespaced storage automatically
       this.graphStorage = makeGraphStorage(
           rootDatabase,
           this.schemaHash
       );
   }
   ```

2. Update methods to use batch builder for atomic operations:
   ```javascript
   async set(nodeName, value) {
       // Use batch builder for atomic value + freshness update
       const batch = this.graphStorage.batch();
       batch.values.put(nodeName, value);
       batch.freshness.put(nodeName, 'up-to-date');
       await batch.write();
       
       // Then propagate outdated state to dependents...
   }
   
   async getDatabaseStatistics() {
       let valueCount = 0;
       for await (const _ of this.graphStorage.values.keys()) {
           valueCount++;
       }
       
       let freshnessCount = 0;
       for await (const _ of this.graphStorage.freshness.keys()) {
           freshnessCount++;
       }
       
       // All counts are for THIS schema only
       return { valueCount, freshnessCount, schemaHash: this.schemaHash };
   }
   ```

3. Note: Schema hash provides automatic isolation - multiple graphs can coexist in one DB file
4. Batch builder ensures atomic updates without type casts

**Risk**: Medium - constructor changes, initialization logic changes

**Files affected**: 1 modified (`class.js`)

### Phase 4: Update Tests (Low Risk)

**Goal**: Update tests to work with new sublevel structure and batch builder.

**Changes**:
1. Update test utilities in `backend/tests/stubs.js`:
   - Ensure mock database supports sublevels
   - Mock batch builder with proper typing
   - Update assertions about key structure

2. Update integration tests:
   - Replace direct `put()`/`del()` with batch builder where atomic operations needed
   - Tests that inspect database keys directly need updates
   - Tests that only use public API should work unchanged

3. Add new tests:
   - Verify values/freshness/indices are in separate spaces
   - Test schema isolation (multiple graphs in same database)
   - Test batch builder with heterogeneous operations
   - Verify batch builder maintains type safety (compile-time checks)

**Risk**: Low - tests always need updates after refactoring

**Files affected**: ~10-15 test files

### Phase 5: Remove Legacy Code and Update Spec (Low Risk)

**Goal**: Remove old prefix-based code once migration complete, update specification.

**Changes**:
1. Delete `freshnessKey()` from `database/types.js`
2. Remove `DatabaseStoredValue` union type (no longer needed)
3. Remove `isDatabaseValue`, `isFreshness` type guards (replaced by typed databases)
4. Remove schemaHash-based key filtering logic
5. **Update `docs/specs/dependency-graph.md`**:
   - Remove `freshnessKey()` function definition
   - Remove all mentions of `"freshness:"` prefix
   - Clarify that key naming is implementation-defined
   - Update test requirements to avoid asserting specific key formats

**Risk**: Low - dead code removal and spec clarification

**Files affected**: 4 modified (3 code files + 1 spec file)

## Migration Strategy

### Backward Compatibility

This is an early-stage project. Clean architecture is more valuable than backward compatibility. Users can export/import data if needed. Do not pay any backward compatibility debt.

## Schema Isolation and Multiple Graphs

**Schema hash is the namespace boundary**: All data (values, freshness, indices) is stored under the schema hash. This means:

1. **Multiple schemas can coexist**: Different schemas in the same DB file are completely isolated
2. **Same schema = same namespace**: If you create multiple graph instances with identical schemas, they share the same namespace (and thus the same data)
3. **One physical DB file**: You can have multiple independent graphs in a single LevelDB file

**Example**:
```javascript
const rootDb = await makeRootDatabase('/path/to/db');

// Two completely independent graphs with different schemas
const graphA = makeDependencyGraph(schemaA, rootDb); // hash: 'abc123...'
const graphB = makeDependencyGraph(schemaB, rootDb); // hash: 'def456...'

// These can have identical node names with no collision
await graphA.set("user('alice')", {name: 'Alice from A'});
await graphB.set("user('alice')", {name: 'Alice from B'});
// Completely isolated - different schema hashes

// Two graph instances with the same schema share data
const graph1 = makeDependencyGraph(schemaA, rootDb); // hash: 'abc123...'
const graph2 = makeDependencyGraph(schemaA, rootDb); // hash: 'abc123...' (same!)
// graph1 and graph2 see the same data - same namespace
```

## Estimated Scope

### Files Modified

**Core implementation** (~5 files):
- `backend/src/generators/database/typed_database.js` (new - GenericDatabase interface)
- `backend/src/generators/database/root_database.js` (new - RootDatabase with schema-namespaced structure)
- `backend/src/generators/database/types.js` (modified - add GenericDatabase types)
- `backend/src/generators/dependency_graph/graph_storage.js` (modified - expose databases as fields, nested revdeps)
- `backend/src/generators/dependency_graph/class.js` (modified - use new GraphStorage interface)

**Type definitions** (~2 files):
- `backend/src/generators/database/types.js` (modified)
- Type imports across various files

**Tests** (~10-15 files):
- `backend/tests/database.test.js` (modified)
- `backend/tests/dependency_graph_*.test.js` (modified - update for schema isolation)
- `backend/tests/stubs.js` (modified)
- Various integration tests
- **New**: Tests for multiple schemas in one DB file

**Specification** (~1 file):
- `docs/specs/dependency-graph.md` (modified - remove `freshnessKey()` and prefix conventions)

**Total estimate**: 18-23 files modified/created

### Effort Estimate
- **Phase 1**: 3-4 hours (typed database interface and wrappers)
- **Phase 2**: 3-4 hours (GraphStorage rewrite with typed database fields)
- **Phase 3**: 2-3 hours (DependencyGraph class updates)
- **Phase 4**: 4-6 hours (test updates)
- **Phase 5**: 1-2 hours (cleanup + spec update)

**Total**: 13-19 hours of focused development

## Future Extensions

### Schema Metadata Storage

With schema-namespaced structure, we can add a `meta` sublevel per schema:

```javascript
/**
 * Schema metadata.
 * @typedef {object} SchemaMetadata
 * @property {string} hash - Schema hash
 * @property {string} schemaJson - Original schema JSON
 * @property {number} createdAt - Unix timestamp
 * @property {number} lastUsedAt - Unix timestamp
 * @property {string} [description] - Optional human-readable description
 */

// Add to SchemaStorage
interface SchemaStorage {
    values: ValuesDatabase;
    freshness: FreshnessDatabase;
    inputs: InputsDatabase;
    revdeps: RevdepsDatabase;
    meta: GenericDatabase<string, any>; // For metadata like schema JSON, timestamps, etc.
}
```

Benefits:
- Debug schema issues (inspect original schema)
- Schema lifecycle management (find unused schemas)
- Migration support (know what schemas exist)

### Index Rebuilding

With clear separation of values vs indices (all within schema namespace):

```javascript
/**
 * Rebuild all indices for a schema from stored values.
 * @param {RootDatabase} rootDb
 * @param {string} schemaHash
 * @returns {Promise<void>}
 */
async function rebuildSchemaIndices(rootDb, schemaHash) {
    const schemaStorage = rootDb.getSchemaStorage(schemaHash);
    
    // Clear existing indices
    await schemaStorage.inputs.clear();
    // Clear revdeps requires iterating input sublevels
    for await (const inputNode of schemaStorage.revdeps.keys()) {
        const inputSublevel = schemaStorage.revdeps.getInputSublevel(inputNode);
        await inputSublevel.clear();
    }
    
    // Rebuild from values
    // (requires knowledge of schema to compute dependencies)
    // ...
}
```

### Per-Schema Statistics

With schema isolation, statistics are naturally scoped:

```javascript
/**
 * Get statistics for a specific schema.
 * @param {RootDatabase} rootDb
 * @param {string} schemaHash
 * @returns {Promise<SchemaStatistics>}
 */
async function getSchemaStatistics(rootDb, schemaHash) {
    const schemaStorage = rootDb.getSchemaStorage(schemaHash);
    
    let valueCount = 0;
    for await (const _ of schemaStorage.values.keys()) {
        valueCount++;
    }
    
    let freshnessCount = 0;
    for await (const _ of schemaStorage.freshness.keys()) {
        freshnessCount++;
    }
    
    let nodeCount = 0;
    for await (const _ of schemaStorage.inputs.keys()) {
        nodeCount++;
    }
    
    let inputNodeCount = 0;
    for await (const _ of schemaStorage.revdeps.keys()) {
        inputNodeCount++; // Count of input nodes that have dependents
    }
    
    return { schemaHash, valueCount, freshnessCount, nodeCount, inputNodeCount };
}
```

## Alternatives Considered

### Alternative 1: Continue with String Prefixes

**Approach**: Keep current prefix-based approach, just document it better.

**Rejected because**:
- Does not address type safety issues
- Still requires manual string construction
- No architectural improvement

### Alternative 2: Separate Databases Per Schema

**Approach**: Create a separate LevelDB instance for each schema.

**Rejected because**:
- Too heavyweight (many open file handles)
- No shared batch operations across schemas
- Difficult to manage lifecycle (when to close databases?)
- LevelDB has limits on number of open databases

### Alternative 3: Single Sublevel Per Schema

**Approach**: Only create one sublevel per schema, keep using prefixes within it.

**Rejected because**:
- Doesn't fully solve the type safety problem
- Still requires manual prefix construction
- Less clear separation of concerns

## Open Questions

### Q1: How to handle schema hash collisions?

**Current answer**: Accept the risk for now (64-bit hash space is large enough). Future: use full hash (32 chars) or add collision detection.

### Q2: Should we version the sublevel structure?

**Current answer**: Not initially. If needed later, add a `version` sublevel at root that stores structure version.

### Q3: How to support multiple graphs with same schema?

**Answer**: Multiple graph instances with identical schemas automatically share the same namespace (same schema hash). This is intentional—they operate on the same data. If you need truly independent instances, they must have different schemas (even slightly different).

### Q4: What about database backup/export?

**Current answer**: LevelDB provides `db.createReadStream()` which works across all sublevels. No special handling needed initially.

## Conclusion

The sublevel-based design with typed database interfaces provides significant improvements over the current prefix-based approach:

1. **Zero type casts**: All types enforced through typed database fields—no type casting anywhere
2. **No ad-hoc prefixes or composite keys**: Only nested sublevels, no string concatenation like `"freshness:"`, `"dg:"`, or `"<input>:<dependent>"`
3. **Schema hash is the namespace boundary**: All data (values, freshness, indices) isolated per schema, enabling multiple independent graphs in one DB file
4. **Simple common interface**: All databases implement `GenericDatabase<TKey, TValue>`
5. **Nested sublevels for revdeps**: `revdeps/<input>/<dependent>` eliminates composite keys and `startsWith()` filtering
6. **Builder pattern for batches**: Maintains strong typing for heterogeneous operations without unions or type casts
7. **GraphStorage exposes databases as fields**: Direct access to typed databases without wrapper methods
8. **Spec independence**: Implementations free to choose storage strategies—spec focuses on behavior, not implementation

The migration is feasible with acceptable scope (13-19 hours, 18-23 files including spec updates). A clean-break migration strategy is recommended for architectural clarity.

The design enables future extensions like schema metadata storage, index rebuilding, and per-schema statistics. It follows the project's conventions around encapsulation, strong typing, clear separation of concerns, and the critical "no type casting" principle.

**Key Architecture Decisions**:
- Schema hash = namespace: Solves the global values/freshness collision problem
- Nested sublevels for revdeps: Eliminates the last remaining string prefix logic
- Builder pattern for batches: Solves the heterogeneous operation typing problem without forcing casts
- Multiple schemas in one DB: Natural consequence of proper namespacing

**Type Safety Victory**: The builder pattern (`batch.values.put()`, `batch.freshness.put()`) maintains perfect type safety for heterogeneous operations—each method is properly typed, no unions, no `any`, no casts. Internally upcasts to `object` for LevelDB submission, which is safe and hidden from the API.

**Specification Impact**: This design requires updates to `dependency-graph.md` to remove hardcoded `"freshness:"` prefix conventions, ensuring the spec remains a behavioral contract rather than an implementation prescription.

The design enables future extensions like schema metadata storage, index rebuilding, and per-schema statistics. It follows the project's conventions around encapsulation, strong typing, clear separation of concerns, and the critical "no type casting" principle.

**Key Architecture Decisions**:
- Schema hash = namespace: Solves the global values/freshness collision problem
- Nested sublevels for revdeps: Eliminates the last remaining string prefix logic
- Multiple schemas in one DB: Natural consequence of proper namespacing

**Specification Impact**: This design requires updates to `dependency-graph.md` to remove hardcoded `"freshness:"` prefix conventions, ensuring the spec remains a behavioral contract rather than an implementation prescription.

## References

- LevelDB Sublevels: https://github.com/Level/level#sublevel
- Level Documentation: https://github.com/Level/level
- Current Implementation:
  - `backend/src/generators/database/class.js`
  - `backend/src/generators/dependency_graph/graph_storage.js`
  - `backend/src/generators/database/types.js`
