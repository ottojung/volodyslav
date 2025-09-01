---
title: UniqueSymbol
description: Type-safe unique identifiers for preventing naming conflicts
---

# UniqueSymbol

The `UniqueSymbol` class provides type-safe unique string identifiers that help prevent naming conflicts in concurrent operations. It's designed to replace plain strings in contexts where uniqueness and type safety are important.

## Purpose and Benefits

### 1. Prevents Naming Conflicts

In complex applications with multiple concurrent operations, using plain strings for identifiers can lead to unintended collisions:

```javascript
// ❌ Risky: Plain strings can collide accidentally
await sleeper.withMutex("user-data", async () => { /* ... */ });
await sleeper.withMutex("user-data", async () => { /* ... */ }); // Unintended blocking
```

UniqueSymbol helps avoid this by generating guaranteed unique identifiers:

```javascript
// ✅ Safe: Each symbol is unique
const userMutex = uniqueSymbol.makeRandom(capabilities);
const accountMutex = uniqueSymbol.makeRandom(capabilities);

await sleeper.withMutex(userMutex, async () => { /* ... */ });
await sleeper.withMutex(accountMutex, async () => { /* ... */ }); // No blocking
```

### 2. Type Safety

UniqueSymbol is a nominal type that prevents accidental mixing with regular strings:

```javascript
// ✅ Type-safe: Can't accidentally pass wrong identifier
function processWithMutex(mutex: UniqueSymbol) {
    return sleeper.withMutex(mutex, async () => { /* ... */ });
}

// This would be caught by type checking if we used TypeScript
// processWithMutex("some-string"); // Type error
processWithMutex(uniqueSymbol.fromString("proper-symbol")); // ✅ Correct
```

### 3. Hierarchical Organization

The concatenation feature allows creating organized identifier hierarchies:

```javascript
const baseSymbol = uniqueSymbol.fromString("user-operations");
const loginMutex = baseSymbol.concat("-login");
const logoutMutex = baseSymbol.concat("-logout");
const passwordMutex = baseSymbol.concat("-password");

// Creates identifiers: "user-operations-login", "user-operations-logout", etc.
```

### 4. Self-Documenting Code

UniqueSymbol makes code intent clearer compared to magic strings:

```javascript
// ❌ Unclear: What does this string represent?
await sleeper.withMutex("xyz123", async () => { /* ... */ });

// ✅ Clear: Obviously a unique identifier
const processingMutex = uniqueSymbol.makeRandom(capabilities);
await sleeper.withMutex(processingMutex, async () => { /* ... */ });
```

## Usage Examples

### Creating UniqueSymbols

```javascript
const uniqueSymbol = require("./unique_symbol");

// Random generation (recommended for most cases)
const randomSymbol = uniqueSymbol.makeRandom(capabilities);
const longerSymbol = uniqueSymbol.makeRandom(capabilities, 32);

// From explicit string (useful for known identifiers)
const namedSymbol = uniqueSymbol.fromString("database-connection");
```

### Concatenation

```javascript
const base = uniqueSymbol.fromString("api");
const v1Endpoint = base.concat("-v1");
const v2Endpoint = base.concat("-v2");
const userEndpoint = v1Endpoint.concat("-users");

console.log(userEndpoint.toString()); // "api-v1-users"
```

### Integration with Sleeper (Mutex)

```javascript
const sleeper = require("./sleeper").make();

// Using UniqueSymbol for mutex identification
const fileMutex = uniqueSymbol.fromString("file-operations");

await sleeper.withMutex(fileMutex, async () => {
    // Critical section - only one operation at a time
    await writeToFile(data);
});

// Backward compatibility: still accepts strings
await sleeper.withMutex("legacy-mutex", async () => {
    // Works with plain strings too
});
```

### Integration with Threading

```javascript
const threading = require("./threading").make();

// Using UniqueSymbol for thread identification
const workerName = uniqueSymbol.fromString("background-processor");

const thread = threading.periodic(workerName, 5000, async () => {
    console.log("Processing background tasks...");
});

thread.start();
```

## ESLint Integration

The project includes an ESLint rule that enforces UniqueSymbol creation only at module top-level, preventing runtime creation that could lead to unintended behavior:

```javascript
// ✅ Allowed: Top-level creation
const moduleSymbol = uniqueSymbol.makeRandom(capabilities);

function someFunction() {
    // ❌ ESLint error: UniqueSymbol creation not allowed inside functions
    const symbol = uniqueSymbol.makeRandom(capabilities);
}
```

To enable this rule, add it to your ESLint configuration:

```json
{
  "plugins": ["volodyslav"],
  "rules": {
    "volodyslav/unique-symbol-top-level-only": "error"
  }
}
```

## Best Practices

### 1. Create at Module Level

Create UniqueSymbols at module level to ensure they remain constant across function calls:

```javascript
// ✅ Good: Module-level creation
const USER_OPERATIONS_MUTEX = uniqueSymbol.fromString("user-operations");

export function updateUser(data) {
    return sleeper.withMutex(USER_OPERATIONS_MUTEX, async () => {
        // Implementation
    });
}
```

### 2. Use Descriptive Names

When using `fromString()`, choose descriptive names that indicate the symbol's purpose:

```javascript
// ✅ Good: Descriptive names
const databaseMutex = uniqueSymbol.fromString("database-connection");
const cacheCleanupThread = uniqueSymbol.fromString("cache-cleanup-worker");

// ❌ Avoid: Generic or unclear names
const mutex1 = uniqueSymbol.fromString("mutex1");
const worker = uniqueSymbol.fromString("worker");
```

### 3. Use Random Generation for Internal Operations

For internal operations where the specific string value doesn't matter, prefer random generation:

```javascript
// ✅ Good: Random for internal use
const internalProcessingMutex = uniqueSymbol.makeRandom(capabilities);

// This is for cases where you just need uniqueness, not a specific name
```

### 4. Leverage Concatenation for Hierarchies

Use concatenation to create logical groupings:

```javascript
const apiBase = uniqueSymbol.fromString("api");
const userApi = apiBase.concat("-users");
const adminApi = apiBase.concat("-admin");

const userMutex = userApi.concat("-mutex");
const userThread = userApi.concat("-worker");
```

## Technical Details

### Nominal Typing

UniqueSymbol uses nominal typing with a `__brand` field to prevent direct instantiation and ensure type safety:

```javascript
// ✅ Correct: Use factory functions
const symbol = uniqueSymbol.fromString("test");

// ❌ Incorrect: Direct instantiation prevented
const symbol = new UniqueSymbolClass("test"); // Throws error
```

### String Conversion

UniqueSymbols automatically convert to strings when used with integrated functions:

```javascript
const symbol = uniqueSymbol.fromString("test");
console.log(symbol.toString()); // "test"

// Automatic conversion in integrations
await sleeper.withMutex(symbol, async () => { /* ... */ });
// Internally converted to: sleeper.withMutex("test", ...)
```

### Memory and Performance

UniqueSymbols have minimal memory overhead and performance impact:

- Each instance stores only a string value and a brand field
- String conversion is O(1)
- Concatenation creates new instances without modifying originals
- Random generation uses the same algorithm as the existing random string module

## Migration Guide

### From Plain Strings

Replace plain string identifiers with UniqueSymbols:

```javascript
// Before
const MUTEX_NAME = "user-operations";
await sleeper.withMutex(MUTEX_NAME, async () => { /* ... */ });

// After
const USER_OPERATIONS_MUTEX = uniqueSymbol.fromString("user-operations");
await sleeper.withMutex(USER_OPERATIONS_MUTEX, async () => { /* ... */ });
```

### Gradual Adoption

The system supports gradual adoption since all integrations accept both strings and UniqueSymbols:

```javascript
// Mix of old and new approaches during migration
await sleeper.withMutex("legacy-string", async () => { /* ... */ });
await sleeper.withMutex(uniqueSymbol.fromString("new-symbol"), async () => { /* ... */ });
```

## Error Handling

UniqueSymbol creation can throw specific errors for invalid inputs:

```javascript
try {
    const symbol = uniqueSymbol.fromString(""); // Empty string
} catch (error) {
    // Error: "UniqueSymbol value must be a non-empty string"
}

try {
    const symbol = uniqueSymbol.fromString("test");
    symbol.concat(123); // Non-string concatenation
} catch (error) {
    // TypeError: "Suffix must be a string"
}
```

The ESLint rule will catch inappropriate creation contexts at build time rather than runtime.