# GitHub Copilot Instructions

## Project Overview
This is a JavaScript project with JSDoc typing for a personal event logging system. It consists of a Node.js backend and a React frontend.

## Core Programming Conventions

### Capabilities Pattern
**CRITICAL**: All side effects must be invoked through the "capabilities" pattern, NOT raw system APIs.

- File operations: Use `capabilities.creator`, `capabilities.deleter`, `capabilities.checker`
- System commands: Use `capabilities.git` (for git operations) or `capabilities.command`
- Environment access: Use `capabilities.environment`
- Logging: Use `capabilities.logger`

Example from the codebase:
```javascript
/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 */

// ✅ Correct: Use capabilities
await capabilities.checker.fileExists(indexFile);

// ❌ Wrong: Direct system API
const fs = require('fs');
fs.existsSync(indexFile);
```

### JSDoc Typing
This project uses JSDoc for type annotations instead of TypeScript:

- Always provide `@typedef` for complex types
- Use `@param` and `@returns` for function documentation
- Import types with `/** @typedef {import('./path').Type} Type */`
- Use type guards with `@returns {object is Type}` pattern

Example:
```javascript
/**
 * @typedef {import('../environment').Environment} Environment
 */

/**
 * Get local repository path.
 * @param {Capabilities} capabilities
 * @returns {string}
 */
function pathToLocalRepository(capabilities) {
    // implementation
}
```

### Encapsulation Convention
Classes are never exported directly from modules to prevent external constructor calls and `instanceof` usage:

- **Export factory functions**: Use `makeFoo` instead of exporting the class
- **Export type guards**: Use `isFoo` instead of relying on `instanceof`
- **Nominal typing**: Use `__brand: undefined` fields for type safety where beneficial

#### Encapsulation Levels
This project achieves encapsulation in two ways:

1. **Module-Level Encapsulation**:
   - Only chosen functions are exported from the module.
   - Everything else is kept private within the module.

2. **Subfolder-Level Encapsulation**:
   - Each subfolder has an `index.js` file that exports chosen functions.
   - Between the files of the subfolder, imports/exports can be less restrictive.
   - From the outside, only the `index.js` file can be imported, ensuring sensitive functionality remains encapsulated.

### Error Handling
This project follows strict error handling conventions that prioritize inspectability, locality, and type safety:

#### Inspectability: Specific Error Classes
Create custom error classes for every kind of failure instead of using generic `Error` classes:

```javascript
// ✅ Correct: Specific error classes
class MissingFieldError extends TryDeserializeError {
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "MissingFieldError";
    }
}

class InvalidTypeError extends TryDeserializeError {
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, 
              field, value, expectedType);
        this.name = "InvalidTypeError";
        this.actualType = actualType;
    }
}

// ❌ Wrong: Generic error
throw new Error("Something went wrong");
```

#### Errors as Values
Use `throw` only in truly exceptional situations. Prefer returning error objects directly:

```javascript
// ✅ Correct: Return errors as values
function tryDeserialize(obj) {
    if (!obj || typeof obj !== "object") {
        return new InvalidStructureError("Object must be a non-null object", obj);
    }
    
    if (!("id" in obj)) {
        return new MissingFieldError("id");
    }
    
    // ... validation continues
    return validEvent; // Success case
}

// Usage
const result = tryDeserialize(data);
if (result instanceof TryDeserializeError) {
    // Handle error
    return;
}
// Use result as valid Event
```

#### Error Locality
Define and throw errors as close to their source as possible:

```javascript
// ✅ Correct: Error defined in same module where it's used
class WorkingRepositoryError extends Error {
    constructor(message, repositoryPath) {
        super(message);
        this.repositoryPath = repositoryPath;
    }
}

function synchronize(capabilities) {
    try {
        // ... git operations
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to synchronize repository: ${err}`,
            repository
        );
    }
}
```

#### Make Impossible States Unrepresentable
Use nominal types with `__brand` fields to prevent invalid states:

```javascript
// ✅ Correct: Nominal type prevents direct instantiation
class ExistingFileClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand
    
    constructor(path) {
        this.path = path;
        if (this.__brand !== undefined) {
            throw new Error("ExistingFile is a nominal type");
        }
    }
}

// Factory function ensures file actually exists
async function makeEmpty(path) {
    await fs.writeFile(path, "");
    return new ExistingFileClass(path);
}
```

#### Validate, Don't Verify
When creating typed instances, ensure parsing validates all guarantees. Once you have an instance, don't re-check:

```javascript
// ✅ Correct: Validate once during construction
class Entry {
    constructor(data) {
        // Validate ALL constraints here
        if (!data.id) throw new Error("ID required");
        if (typeof data.description !== 'string') throw new Error("Description must be string");
        
        this.id = data.id;
        this.description = data.description;
    }
}

// Later in code - no need to re-validate
function processEntry(entry) {
    // Can safely use entry.id and entry.description
    // No need to check if they exist or have correct types
}
```

Always provide type guards for error classes:
```javascript
function isWorkingRepositoryError(object) {
    return object instanceof WorkingRepositoryError;
}
```

### Critical Note: Avoid Type-Casting
Since this project relies heavily on type checking for safety and correctness, **type-casting must not be used** under any circumstances.

#### Examples:
```javascript
// ❌ Wrong: Type-casting
const obj = /** @type {SomeType} */ (unknownObject);

// ✅ Correct: Ensured correct type via type guard
if (isSomeType(unknownObject)) {
    const obj = unknownObject;
}
```

## Obvious type guards

The ONLY acceptable form of type guards is one that checks if an object is of a specific type using `instanceof`. This ensures type safety.

```javascript
// ✅ Correct: Type guard using instanceof
function isExistingFile(object) {
    return object instanceof ExistingFileClass;
}

// ❌ Wrong: Using typeof or other checks
function isPathLike(object) {
    return typeof object === 'object' && object !== null && 'path' in object;
}
```

## Size

- **File size limit**: 300 lines of code per file.

## Testing

### Running Tests
- **Specific tests**: `jest path/to/test/file.js` or `jest --testNamePattern="test name"`
- **Full test suite**: `npm test`
- **Static analysis**: `npm run static-analysis` (includes linting and type checking)
- **Build verification**: `npm run build`

### Test Conventions
- Test files are located in `backend/tests/` and `frontend/tests/`
- Mock external dependencies using the patterns established in `backend/tests/stubs.js`

## Backwards compatibility

- When an AI agent finds issues with legacy code or has a clearly better suggestion for any programming interface, it SHOULD prioritize correctness and improvement and SHOULD disregard backwards compatibility.
- Exception: If a change affects data or formats that live outside this repository (for example database schemas, on-disk file formats, or other persisted storage), backwards compatibility SHOULD be preserved. Changes that would break external storage or require coordinated migrations need explicit consideration and coordination.

## Additional Guidelines

- Follow existing naming conventions (snake_case for files, camelCase for functions)
- Maintain the dependency injection pattern through capabilities
- Add comprehensive JSDoc documentation for new functions
- Write tests for new functionality
- Use the established error handling patterns
