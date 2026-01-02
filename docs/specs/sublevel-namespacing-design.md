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
    .createHash("sha256")
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

```
Root Database (Level<string, object>)
├── values: Level<string, DatabaseValue>          // Node output values
├── freshness: Level<string, Freshness>           // Node freshness state
└── schemas: Level<string, never>                 // Per-schema storage (no top-level values)
    └── <schemaHash>: Sublevel
        ├── inputs: Level<string, InputsRecord>   // Node -> inputs mapping
        └── revdeps: Level<string, null>          // (input,node) reverse index
```

### Type Definitions

#### Common Database Interface

All databases (values, freshness, inputs, revdeps) implement a common, simple, well-typed interface:

```javascript
/**
 * Generic typed database interface.
 * @template TKey - The key type (typically string)
 * @template TValue - The value type
 * @typedef {object} TypedDatabase
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
 * @typedef {TypedDatabase<string, DatabaseValue>} ValuesDatabase
 */

/**
 * Database for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state object
 * @typedef {TypedDatabase<string, Freshness>} FreshnessDatabase
 */

/**
 * Database for storing node input dependencies.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: inputs record with array of dependency names
 * @typedef {TypedDatabase<string, InputsRecord>} InputsDatabase
 */

/**
 * Database for reverse dependency index.
 * Key: "<input-node>:<dependent-node>" (e.g., "user('alice'):posts('alice')")
 * Value: null (we only care about key existence)
 * @typedef {TypedDatabase<string, null>} RevdepsDatabase
 */

/**
 * A record storing the input dependencies of a node.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 */

/**
 * Storage container for a single dependency graph schema.
 * @typedef {object} SchemaStorage
 * @property {InputsDatabase} inputs - Node inputs index
 * @property {RevdepsDatabase} revdeps - Reverse dependencies index
 */

/**
 * GraphStorage exposes typed databases as fields.
 * This provides type-safe access without needing type casts.
 * @typedef {object} GraphStorage
 * @property {ValuesDatabase} values - Database for node values
 * @property {FreshnessDatabase} freshness - Database for node freshness
 * @property {SchemaStorage} schema - Schema-specific databases (inputs, revdeps)
 * @property {(node: string, inputs: string[]) => Promise<void>} ensureNodeIndexed - Index a node's dependencies
 * @property {(input: string) => Promise<string[]>} listDependents - List all dependents of an input
 * @property {(node: string) => Promise<string[] | null>} getInputs - Get inputs for a node
 */

/**
 * @template K
 * @typedef {object} InterlevelDelOp
 * @property {'del'} type
 * @property {TypedDatabase<K, any>} db
 * @property {K} key
 */

/**
 * @template K
 * @template V
 * @typedef {object} InterlevelPutOp
 * @property {'put'} type
 * @property {TypedDatabase<K, V>} db
 * @property {K} key
 * @property {V} value
 */

/**
 *
 * @template K
 * @template V
 * @typedef {InterlevelPutOp<K, V>|InterlevelDelOp<K>} InterlevelBatch<K, V>
 */

/**
 * Root database structure with typed databases.
 * All sub-databases implement the TypedDatabase interface.
 * @typedef {object} RootDatabase
 * @property {ValuesDatabase} values - Node output values
 * @property {FreshnessDatabase} freshness - Node freshness state
 * @property {(schemaHash: string) => SchemaStorage} getSchemaStorage - Get schema-specific storage
 * @property {<K, V>(operations: Array<InterlevelBatch<K, V>>) => Promise<void>} batch - Atomic batch operations across databases
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

All databases implement `TypedDatabase<TKey, TValue>`, providing:
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
interface TypedDatabase<TKey, TValue> {
    get(key: TKey): Promise<TValue | undefined>;
    put(key: TKey, value: TValue): Promise<void>;
    del(key: TKey): Promise<void>;
    keys(): AsyncIterable<TKey>;
    clear(): Promise<void>;
}
```

### Key Advantages

#### 1. Strong Typing with Zero Type Casts

Each database has a precise type contract through the `TypedDatabase` interface:

```javascript
// ✅ Type-safe: No casts needed, types inferred from database field
const value = await graphStorage.values.get(canonicalNode);
// Type: DatabaseValue | undefined

const freshness = await graphStorage.freshness.get(canonicalNode);
// Type: Freshness | undefined

const inputsRecord = await graphStorage.schema.inputs.get(canonicalNode);
// Type: InputsRecord | undefined

// ✅ Type-safe: All databases share the same interface
function clearDatabase<K, V>(db: TypedDatabase<K, V>) {
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

Different concerns are separated into distinct databases:

```javascript
// Values database
await graphStorage.values.put(node, computedValue);

// Freshness database (no collision possible with values)
await graphStorage.freshness.put(node, 'up-to-date');

// Schema indices are in separate databases
await graphStorage.schema.inputs.put(node, { inputs: ['input1', 'input2'] });
await graphStorage.schema.revdeps.put(`${input}:${node}`, null);
```

#### 3. No Manual String Construction or Ad-hoc Prefixes

**CRITICAL**: The implementation uses **only sublevels**, with **zero ad-hoc string prefixes**:

```javascript
// ❌ Old way: manual prefix construction
const inputsKey = `dg:${schemaHash}:inputs:${node}`;
const freshnessKey = `freshness:${node}`; // Ad-hoc prefix
await database.put(inputsKey, { inputs: [...] });
await database.put(freshnessKey, 'up-to-date');

// ✅ New way: Only sublevels, no string prefixes
await graphStorage.schema.inputs.put(node, { inputs: [...] });
await graphStorage.freshness.put(node, 'up-to-date');
// LevelDB sublevels handle namespacing internally - no string concatenation
```

#### 4. Clear Enumeration

Each database can be enumerated independently:

```javascript
// List all materialized nodes (just values, no indices)
const materializedNodes = [];
for await (const key of graphStorage.values.keys()) {
    materializedNodes.push(key);
}

// List all nodes with freshness state
const nodesWithFreshness = [];
for await (const key of graphStorage.freshness.keys()) {
    nodesWithFreshness.push(key);
}

// List all dependents of an input (within a schema)
const dependents = [];
for await (const key of graphStorage.schema.revdeps.keys()) {
    if (key.startsWith(`${inputNode}:`)) {
        dependents.push(key.substring(inputNode.length + 1));
    }
}
```

#### 5. Atomic Operations

Operations within a single database are naturally atomic. Cross-database atomicity is implementation-specific:

```javascript
// Individual database operations are atomic
await graphStorage.values.put(node, value);
await graphStorage.freshness.put(node, 'up-to-date');

// For truly atomic multi-database updates, use root database batch if needed
// (implementation detail - not part of GraphStorage interface)
```

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
   - Define `TypedDatabase<TKey, TValue>` interface
   - Implement wrapper class that adapts LevelDB sublevel to `TypedDatabase` interface
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

3. Keep `DatabaseClass` unchanged for backward compatibility
   - Will be deprecated in Phase 5

**Risk**: Low - additive changes only, existing code unaffected

**Files affected**: 2 new

### Phase 2: Rewrite GraphStorage with Typed Databases (Medium Risk)

**Goal**: Rewrite `graph_storage.js` to expose typed databases as fields, eliminate all type casts and string prefixes.

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
           // Expose databases as fields
           values: rootDatabase.values,
           freshness: rootDatabase.freshness,
           schema: schemaStorage,
           
           // Helper methods
           async ensureNodeIndexed(node, inputs) { ... },
           async listDependents(input) { ... },
           async getInputs(node) { ... },
       };
   }
   ```

2. **Delete all key construction functions**:
   ```javascript
   // ❌ DELETE: freshnessKey(), inputsKey(), revdepKey(), revdepPrefix()
   // These are replaced by typed database fields
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
   // No need to filter out "freshness:" or "dg:" prefixes - they don't exist!
   ```

5. Update all call sites to use database fields directly:
   ```javascript
   // ❌ OLD: Through wrapper methods
   await storage.setNodeValueOp(node, value);
   
   // ✅ NEW: Direct database access
   await graphStorage.values.put(node, value);
   await graphStorage.freshness.put(node, 'up-to-date');
   ```

**Risk**: Medium - changes internal implementation, but API unchanged

**Files affected**: 1 modified (`graph_storage.js`)

### Phase 3: Update DependencyGraph Class (Medium Risk)

**Goal**: Pass schema storage to GraphStorage, remove schemaHash from keys.

**Changes**:
1. Update `class.js` to pass database and schemaHash to GraphStorage:
   ```javascript
   constructor(schema, database, capabilities) {
       // ... validation
       
       this.schemaHash = /* compute hash */;
       
       // Pass database and schemaHash to GraphStorage
       // GraphStorage will access sublevels as needed
       this.graphStorage = makeGraphStorage(
           database,
           this.schemaHash
       );
   }
   ```

2. Update `getDatabaseStatistics()` to query sublevels separately

**Risk**: Medium - constructor changes, initialization logic changes

**Files affected**: 1 modified (`class.js`)

### Phase 4: Update Tests (Low Risk)

**Goal**: Update tests to work with new sublevel structure.

**Changes**:
1. Update test utilities in `backend/tests/stubs.js`:
   - Ensure mock database supports sublevels
   - Update assertions about key structure

2. Update integration tests:
   - Tests that inspect database keys directly need updates
   - Tests that only use public API should work unchanged

3. Add new tests for sublevel isolation:
   - Verify values/freshness/indices are in separate spaces
   - Test schema isolation (multiple graphs in same database)

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

**Option A: Clean Break (Recommended)**

- Require users to re-initialize their database
- Provide migration script that reads old format, writes new format
- Clear separation between old and new versions

**Pros**:
- Cleaner codebase
- No dual-mode complexity
- Faster implementation

**Cons**:
- Users must migrate or lose data
- One-time migration pain

**Option B: Dual-Mode Support**

- Detect old vs new database format on startup
- Support both formats during transition period
- Gradually migrate data on read/write

**Pros**:
- No breaking changes
- Gradual migration

**Cons**:
- Complex implementation
- Longer maintenance burden
- Performance overhead

**Recommendation**: Option A (Clean Break) with migration script.

Rationale: This is an early-stage project. Clean architecture is more valuable than backward compatibility. Users can export/import data if needed.

## Estimated Scope

### Files Modified

**Core implementation** (~5 files):
- `backend/src/generators/database/typed_database.js` (new - TypedDatabase interface)
- `backend/src/generators/database/root_database.js` (new - RootDatabase with typed fields)
- `backend/src/generators/database/types.js` (modified - add TypedDatabase types)
- `backend/src/generators/dependency_graph/graph_storage.js` (modified - expose databases as fields)
- `backend/src/generators/dependency_graph/class.js` (modified - use new GraphStorage interface)

**Type definitions** (~2 files):
- `backend/src/generators/database/types.js` (modified)
- Type imports across various files

**Tests** (~10-15 files):
- `backend/tests/database.test.js` (modified)
- `backend/tests/dependency_graph_*.test.js` (modified)
- `backend/tests/stubs.js` (modified)
- Various integration tests

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

Once sublevels are in place, we can store schema metadata:

```javascript
/**
 * Schema metadata.
 * @typedef {object} SchemaMetadata
 * @property {string} hash - Schema hash (16-char hex)
 * @property {string} schemaJson - Original schema JSON
 * @property {number} createdAt - Unix timestamp
 * @property {number} lastUsedAt - Unix timestamp
 * @property {string} [description] - Optional human-readable description
 */

// Add to DatabaseWithSublevels interface
/**
 * @typedef {object} DatabaseWithSublevels
 * ...
 * @property {Level<string, SchemaMetadata>} schemaMetadata
 */
```

Benefits:
- Debug schema issues (inspect original schema)
- Schema lifecycle management (find unused schemas)
- Migration support (know what schemas exist)

### Index Rebuilding

With clear separation of values vs indices:

```javascript
/**
 * Rebuild all indices for a schema from stored values.
 * @param {DatabaseWithSublevels} database
 * @param {string} schemaHash
 * @returns {Promise<void>}
 */
async function rebuildSchemaIndices(database, schemaHash) {
    const schemaStorage = database.schemas.sublevel(schemaHash);
    const inputsLevel = schemaStorage.sublevel('inputs');
    const revdepsLevel = schemaStorage.sublevel('revdeps');
    
    // Clear existing indices
    await inputsLevel.clear();
    await revdepsLevel.clear();
    
    // Rebuild from values
    // (requires knowledge of schema to compute dependencies)
    // ...
}
```

### Per-Schema Statistics

With schema isolation:

```javascript
/**
 * Get statistics for a specific schema.
 * @param {DatabaseWithSublevels} database
 * @param {string} schemaHash
 * @returns {Promise<SchemaStatistics>}
 */
async function getSchemaStatistics(database, schemaHash) {
    const schemaStorage = database.schemas.sublevel(schemaHash);
    const inputsLevel = schemaStorage.sublevel('inputs');
    const revdepsLevel = schemaStorage.sublevel('revdeps');
    
    let nodeCount = 0;
    for await (const _ of inputsLevel.keys()) {
        nodeCount++;
    }
    
    let edgeCount = 0;
    for await (const _ of revdepsLevel.keys()) {
        edgeCount++;
    }
    
    return { schemaHash, nodeCount, edgeCount };
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

**Current answer**: Not supported currently (one graph per schema hash). Future: add instance ID to schema storage structure.

### Q4: What about database backup/export?

**Current answer**: LevelDB provides `db.createReadStream()` which works across all sublevels. No special handling needed initially.

## Conclusion

The sublevel-based design with typed database interfaces provides significant improvements over the current prefix-based approach:

1. **Zero type casts**: All types enforced through typed database fields—no type casting anywhere in the implementation
2. **No ad-hoc prefixes**: Only sublevels, no string concatenation like `"freshness:"` or `"dg:"`
3. **Simple common interface**: All databases implement `TypedDatabase<TKey, TValue>`
4. **GraphStorage exposes databases as fields**: Direct access to typed databases without wrapper methods
5. **Spec independence**: Implementations are free to choose storage strategies—spec focuses on behavior, not implementation

The migration is feasible with acceptable scope (13-19 hours, 18-23 files including spec updates). A clean-break migration strategy is recommended for architectural clarity.

The design enables future extensions like schema metadata storage, index rebuilding, and per-schema statistics. It follows the project's conventions around encapsulation, strong typing, clear separation of concerns, and the critical "no type casting" principle.

**Specification Impact**: This design requires updates to `dependency-graph.md` to remove hardcoded `"freshness:"` prefix conventions, ensuring the spec remains a behavioral contract rather than an implementation prescription.

## References

- LevelDB Sublevels: https://github.com/Level/level#sublevel
- Level Documentation: https://github.com/Level/level
- Current Implementation:
  - `backend/src/generators/database/class.js`
  - `backend/src/generators/dependency_graph/graph_storage.js`
  - `backend/src/generators/database/types.js`
