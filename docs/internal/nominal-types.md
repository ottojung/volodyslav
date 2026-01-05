# Nominal Types: Schema World vs Instance World

## Overview

The dependency graph system uses **nominal types** to enforce a strict separation between two conceptual worlds:

1. **Schema World** (compile-time): Pattern definitions and variable mapping
2. **Instance World** (runtime): Concrete node instances with specific binding values

This separation prevents accidental mixing of schema patterns and concrete node identifiers, eliminating a class of bugs related to "string soup" where the same `string` type meant different things in different contexts.

## The Two Types

### `SchemaPattern`

Wraps schema expression strings like `"full_event(e)"` or `"all_events"`.

**Usage**: Schema definition and variable mapping at compile time.

**Examples**:
```javascript
const pattern = asSchemaPattern("event(e)");
// pattern = { _tag: 'SchemaPattern', text: 'event(e)' }
```

### `NodeKeyString`

Wraps stringified concrete node keys like `'{"head":"event","args":[{"id":5}]}'`.

**Usage**: Storage keys, freshness tracking, and dependency edges at runtime.

**Examples**:
```javascript
const nodeKey = { head: "event", args: [{ id: 5 }] };
const keyString = serializeNodeKey(nodeKey);
// keyString = { _tag: 'NodeKeyString', key: '{"head":"event","args":[{"id":5}]}' }
```

## Where Conversions Happen

### Schema World → Instance World

Schema patterns are compiled into `CompiledNode` structures during graph construction. When a pattern node is instantiated with concrete bindings, the system:

1. Maps variable names to positions
2. Extracts bindings for each input
3. Creates concrete `NodeKey` objects
4. Serializes them to `NodeKeyString` for storage

```javascript
// Example: Pattern "event(e)" with bindings [{ id: 5 }]
// → NodeKey: { head: "event", args: [{ id: 5 }] }
// → NodeKeyString: '{"head":"event","args":[{"id":5}]}'
```

### Unwrapping at Boundaries

NodeKeyString is unwrapped to plain strings **only** at:
- Database operations (storage.values.put, storage.freshness.get, etc.)
- Debug/test output (debugListMaterializedNodes returns plain strings)
- Test helpers (toJsonKey returns plain string for assertions)

## Design Principles

### 1. No Mixed Signatures

**Rule**: No function may have a signature containing **both** `SchemaPattern` and `NodeKeyString`.

This enforces separation: schema functions work with patterns, runtime functions work with node keys.

### 2. No String Shape Guessing

**Before** (problematic):
```javascript
function findMatchingPattern(keyOrPattern) {
    if (keyOrPattern.startsWith("{")) {
        // It's a JSON key
        const parsed = JSON.parse(keyOrPattern);
        // ...
    } else {
        // It's a pattern
        const expr = parseExpr(keyOrPattern);
        // ...
    }
}
```

**After** (clean):
```javascript
function getOrCreateConcreteNode(nodeKeyString, compiledNode, bindings) {
    // Only works with runtime types
    // No guessing required
}
```

### 3. Push Conversions to Boundaries

Wrap and unwrap at the edges:
- Serialize `NodeKey` → `NodeKeyString` when creating storage keys
- Unwrap `NodeKeyString` → `string` only at DB calls
- Keep internal logic working with structured types

## Benefits

1. **Type Safety**: JSDoc/TypeScript tooling can catch type errors
2. **Clarity**: Function signatures clearly indicate schema vs runtime operations
3. **Maintainability**: No ambiguous string parameters
4. **Fewer Bugs**: Impossible to accidentally pass a pattern string where a node key is expected

## Examples

### Creating a Concrete Node (Runtime)

```javascript
// Public API accepts node name + bindings
async pull(nodeName, bindings = []) {
    // Lookup compiled schema
    const compiledNode = this.headIndex.get(nodeName);
    
    // Create NodeKey (structured)
    const nodeKey = { head: nodeName, args: bindings };
    
    // Serialize to NodeKeyString (nominal)
    const nodeKeyString = serializeNodeKey(nodeKey);
    
    // Get or create concrete definition
    const nodeDefinition = this.getOrCreateConcreteNode(
        nodeKeyString,     // NodeKeyString (nominal)
        compiledNode,      // CompiledNode (schema metadata)
        bindings           // Array<ConstValue> (runtime data)
    );
    
    // Storage operations unwrap to plain string
    const concreteKeyStr = unwrapNodeKeyString(nodeKeyString);
    const value = await this.storage.values.get(concreteKeyStr);
    // ...
}
```

### Test Helpers

Test helpers unwrap nominal types for backward compatibility:

```javascript
function toJsonKey(nodeName, bindings = {}) {
    const canonical = canonicalize(nodeName);
    const nodeKey = createNodeKeyFromPattern(canonical, bindings);
    const nodeKeyString = serializeNodeKey(nodeKey);  // Returns NodeKeyString
    return unwrapNodeKeyString(nodeKeyString);         // Returns plain string for tests
}
```

## Migration Notes

When working with the dependency graph:

1. **Never** pass raw strings between schema and runtime operations
2. **Always** use `serializeNodeKey` to create storage keys
3. **Only** unwrap NodeKeyString at DB boundaries or debug output
4. **Avoid** adding new functions that accept "string that might be X or Y"

## Future Considerations

The current implementation focuses on separating NodeKeyString from plain strings. A future enhancement could also wrap schema pattern strings in `SchemaPattern` at the NodeDef boundary, but this was not required for the initial implementation since:

1. All tests pass without this change
2. The critical separation (runtime node keys) is already enforced
3. Schema patterns are already encapsulated within CompiledNode structures
