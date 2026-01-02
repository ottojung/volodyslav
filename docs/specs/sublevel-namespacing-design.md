# Sublevel-Based Namespacing Design

## Executive Summary

This document proposes a redesign of the dependency graph storage layer to use LevelDB sublevels for isolation and namespacing, replacing the current ad-hoc string prefix approach. The new design provides:

1. **Strong typing**: Each sublevel has a well-defined key-value type contract
2. **Logical isolation**: Different data concerns separated into distinct sublevels
3. **Type safety**: No manual string concatenation or parsing
4. **Maintainability**: Clear separation of concerns and reduced coupling

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
- Type casting necessary (see FIXME in graph_storage.js line 200)
- No static guarantees about what type of value exists at a given key

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
Root Database (Level<string, any>)
├── values: Level<string, DatabaseValue>          // Node output values
├── freshness: Level<string, Freshness>           // Node freshness state
└── schemas: Level<string, never>                 // Per-schema storage (no top-level values)
    └── <schemaHash>: Sublevel
        ├── inputs: Level<string, InputsRecord>   // Node -> inputs mapping
        └── revdeps: Level<string, null>          // (input,node) reverse index
```

### Type Definitions

```javascript
/**
 * A sublevel for storing node output values.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: the computed value (string, number, object, array, null, boolean)
 * @typedef {import('level').Level<string, DatabaseValue>} ValuesLevel
 */

/**
 * A sublevel for storing node freshness state.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: freshness state object
 * @typedef {import('level').Level<string, Freshness>} FreshnessLevel
 */

/**
 * A record storing the input dependencies of a node.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 */

/**
 * A sublevel for storing node input dependencies.
 * Key: canonical node name (e.g., "user('alice')")
 * Value: inputs record with array of dependency names
 * @typedef {import('level').Level<string, InputsRecord>} InputsLevel
 */

/**
 * A sublevel for reverse dependency index.
 * Key: "<input-node>:<dependent-node>" (e.g., "user('alice'):posts('alice')")
 * Value: null (we only care about key existence)
 * @typedef {import('level').Level<string, null>} RevdepsLevel
 */

/**
 * Storage container for a single dependency graph schema.
 * @typedef {object} SchemaStorage
 * @property {InputsLevel} inputs - Node inputs index
 * @property {RevdepsLevel} revdeps - Reverse dependencies index
 */

/**
 * A sublevel for storing schema-specific data.
 * Each schema is stored in a nested sublevel accessed by schemaHash.
 * The sublevel itself does not store values at top-level keys.
 * @typedef {import('level').AbstractLevel<string, never>} SchemasLevel
 */

/**
 * Root database structure with typed sublevels.
 * This represents the enhanced Database interface with sublevel properties.
 * @typedef {object} DatabaseWithSublevels
 * @property {ValuesLevel} values - Node output values
 * @property {FreshnessLevel} freshness - Node freshness state
 * @property {SchemasLevel} schemas - Schema-specific storage
 */
```

### Key Advantages

#### 1. Strong Typing

Each sublevel has a precise type contract:

```javascript
// ✅ Type-safe: valuesLevel.get() returns DatabaseValue | undefined
const value = await database.values.get(canonicalNode);

// ✅ Type-safe: freshnessLevel.get() returns Freshness | undefined
const freshness = await database.freshness.get(canonicalNode);

// ❌ Old way: runtime type checking required
const storedValue = await database.get(key);
if (isDatabaseValue(storedValue)) {
    // ...
} else if (isFreshness(storedValue)) {
    // ...
}
```

#### 2. Logical Isolation

Different concerns are separated into distinct sublevels:

```javascript
// Values are in their own space
await database.values.put(node, computedValue);

// Freshness is in its own space (no collision possible)
await database.freshness.put(node, { state: 'up-to-date' });

// Schema indices are isolated by schemaHash
const schemaStorage = await getSchemaStorage(database.schemas, schemaHash);
await schemaStorage.inputs.put(node, { inputs: ['input1', 'input2'] });
```

#### 3. No Manual String Construction

Sublevels handle namespacing automatically:

```javascript
// ❌ Old way: manual prefix construction
const inputsKey = `dg:${schemaHash}:inputs:${node}`;
await database.put(inputsKey, { inputs: [...] });

// ✅ New way: sublevel handles namespacing
const schemaStorage = await getSchemaStorage(database.schemas, schemaHash);
await schemaStorage.inputs.put(node, { inputs: [...] });
```

#### 4. Clear Enumeration

Each sublevel can be enumerated independently:

```javascript
// List all materialized nodes (just values, no indices)
const materializedNodes = await database.values.keys().all();

// List all nodes with freshness state
const nodesWithFreshness = await database.freshness.keys().all();

// List all schemas
const schemaHashes = await database.schemas.keys().all();

// List all dependents of an input (within a schema)
const prefix = `${inputNode}:`;
const dependents = [];
for await (const key of schemaStorage.revdeps.keys({ gte: prefix, lte: prefix + '\xff' })) {
    dependents.push(key);
}
```

#### 5. Batch Operations Within Sublevels

Batch operations can be scoped to specific sublevels or span multiple sublevels:

```javascript
// Batch operation on values sublevel only
await database.values.batch([
    { type: 'put', key: 'user("alice")', value: {...} },
    { type: 'put', key: 'user("bob")', value: {...} },
]);

// Batch operation spanning multiple sublevels (atomically)
await database.batch([
    { type: 'put', sublevel: database.values, key: 'user("alice")', value: {...} },
    { type: 'put', sublevel: database.freshness, key: 'user("alice")', value: {...} },
]);
```

Note: The root database reference is `database` (which could be obtained via `database.values.db` or stored separately).

## Implementation Plan

### Phase 1: Create Sublevel Abstraction (Low Risk)

**Goal**: Introduce sublevel-based database structure without changing existing code.

**Changes**:
1. Create new module: `backend/src/generators/database/sublevels.js`
   - Define typed sublevel structure
   - Export factory function `makeSublevels(db)` that creates and returns the sublevel structure
   - Provide helper to get/create schema storage

2. Extend `DatabaseClass` in `backend/src/generators/database/class.js`
   - Add `this.values`, `this.freshness`, `this.schemas` fields (the typed sublevels)
   - Keep existing `get()`, `put()`, `batch()` methods for backward compatibility (delegate to sublevels)
   - Add new convenience methods if needed

3. Update `makeDatabase()` in `backend/src/generators/database/index.js`
   - Initialize sublevels structure using the factory
   - Attach sublevels to DatabaseClass instance
   - No breaking changes to existing interface

**Risk**: Low - additive changes only, existing code unaffected

**Files affected**: 3 new/modified

### Phase 2: Migrate GraphStorage (Medium Risk)

**Goal**: Rewrite `graph_storage.js` to use sublevels, remove string prefix logic.

**Changes**:
1. Update `makeGraphStorage()` signature to accept the root database and schema storage:
   ```javascript
   function makeGraphStorage(
       database,        // Root database (with .values, .freshness, .schemas)
       schemaStorage    // SchemaStorage for this graph
   ) { ... }
   ```

2. Replace key construction functions with sublevel access:
   ```javascript
   // ❌ Delete: inputsKey(), revdepKey()
   
   // ✅ Replace with direct sublevel access
   async function getInputs(node) {
       const record = await schemaStorage.inputs.get(node);
       return record ? record.inputs : null;
   }
   
   async function getNodeValue(node) {
       return await database.values.get(node);
   }
   
   async function getNodeFreshness(node) {
       return await database.freshness.get(node);
   }
   ```

3. Update `listMaterializedNodes()` to use values sublevel:
   ```javascript
   async function listMaterializedNodes() {
       const keys = [];
       for await (const key of database.values.keys()) {
           keys.push(key);
       }
       return keys;
   }
   ```

4. Remove type-casting workarounds (FIXME at line 200)

**Risk**: Medium - changes internal implementation, but API unchanged

**Files affected**: 1 modified (`graph_storage.js`)

### Phase 3: Update DependencyGraph Class (Medium Risk)

**Goal**: Pass schema storage to GraphStorage, remove schemaHash from keys.

**Changes**:
1. Update `class.js` to obtain schema storage from database:
   ```javascript
   constructor(schema, database, capabilities) {
       // ... validation
       
       this.schemaHash = /* compute hash */;
       
       // Get or create schema storage sublevel
       this.schemaStorage = database.schemas.sublevel(this.schemaHash);
       
       // Create nested sublevels for inputs and revdeps
       this.schemaStorage.inputs = this.schemaStorage.sublevel('inputs', {
           valueEncoding: 'json'
       });
       this.schemaStorage.revdeps = this.schemaStorage.sublevel('revdeps');
       
       // Pass database and schema storage to GraphStorage
       this.graphStorage = makeGraphStorage(
           database,
           this.schemaStorage
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

### Phase 5: Remove Legacy Code (Low Risk)

**Goal**: Remove old prefix-based code once migration complete.

**Changes**:
1. Delete `freshnessKey()` from `database/types.js`
2. Remove `DatabaseStoredValue` union type (no longer needed)
3. Remove `isDatabaseValue`, `isFreshness` type guards (replaced by sublevel typing)
4. Remove schemaHash-based key filtering logic

**Risk**: Low - dead code removal

**Files affected**: 3 modified

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
- `backend/src/generators/database/sublevels.js` (new)
- `backend/src/generators/database/class.js` (modified)
- `backend/src/generators/database/index.js` (modified)
- `backend/src/generators/dependency_graph/graph_storage.js` (modified)
- `backend/src/generators/dependency_graph/class.js` (modified)

**Type definitions** (~2 files):
- `backend/src/generators/database/types.js` (modified)
- Type imports across various files

**Tests** (~10-15 files):
- `backend/tests/database.test.js` (modified)
- `backend/tests/dependency_graph_*.test.js` (modified)
- `backend/tests/stubs.js` (modified)
- Various integration tests

**Total estimate**: 17-22 files modified/created

### Effort Estimate

- **Phase 1**: 2-3 hours (sublevel abstraction)
- **Phase 2**: 3-4 hours (GraphStorage migration)
- **Phase 3**: 2-3 hours (DependencyGraph class updates)
- **Phase 4**: 4-6 hours (test updates)
- **Phase 5**: 1-2 hours (cleanup)

**Total**: 12-18 hours of focused development

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

The sublevel-based design provides significant improvements in type safety, maintainability, and clarity over the current prefix-based approach. The migration is feasible with acceptable scope (12-18 hours, 17-22 files). A clean-break migration strategy is recommended for architectural clarity.

The design enables future extensions like schema metadata storage, index rebuilding, and per-schema statistics. It follows the project's conventions around encapsulation, strong typing, and clear separation of concerns.

## References

- LevelDB Sublevels: https://github.com/Level/level#sublevel
- Level Documentation: https://github.com/Level/level
- Current Implementation:
  - `backend/src/generators/database/class.js`
  - `backend/src/generators/dependency_graph/graph_storage.js`
  - `backend/src/generators/database/types.js`
