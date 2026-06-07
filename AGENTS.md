# Project Overview
This is a JavaScript project with JSDoc typing for a highly reliable event logging system. It consists of a Node.js backend and a React frontend in a monorepo structure.

# Initial Setup (Required for Fresh Repository)

When working on a fresh clone, this command is useful:

```bash
npm install   # install dependencies in root and all workspaces
```

# Core Programming Conventions

## Capabilities Pattern
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

## JSDoc Typing
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
- **Nominal typing**: Use `__brand: undefined` fields for type safety where beneficial (see [Nominal types and proof-carrying comments](#nominal-types-and-proof-carrying-comments))

#### Encapsulation Levels
This project achieves encapsulation in two ways:

1. **Module-Level Encapsulation**:
   - Only chosen functions are exported from the module.
   - Everything else is kept private within the module.

2. **Subfolder-Level Encapsulation**:
   - Each subfolder has an `index.js` file that exports chosen functions.
   - Between the files of the subfolder, imports/exports can be less restrictive.
   - From the outside, only the `index.js` file can be imported, ensuring sensitive functionality remains encapsulated.

## Error Handling
This project follows strict error handling conventions that prioritize inspectability, locality, and type safety:

### Inspectability: Specific Error Classes
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

### Errors as Values
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

### Error Locality
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

### Nominal types and proof-carrying comments

The rule is:

> If a nominal type can capture a useful property, it should.

A nominal type is valuable when it prevents plain structural data from being confused with data that carries a proof, invariant, origin, validation, or capability.

Every nominal type must have a nearby comment explaining:

1. the properties it carries, and
2. the explicit proof that those properties hold.

The proof must not be described vaguely. Do not merely say "by checking all constructors" or "by case analysis." Instead, write out the cases.

Use this required comment shape:

```js
/**
 * The properties that this class carries are:
 * - ...
 *
 * The proof of those properties is guaranteed by:
 * - This class/type can only be introduced through these functions:
 *   - `makeA(...)`: satisfies the property because ...
 *   - `fromB(...)`: satisfies the property because ...
 *   - `parseC(...)`: satisfies the property because ...
 */
```

For typedef-only nominal aliases, use the same shape near the typedef. If the type itself cannot enforce the property structurally, the proof must explicitly describe the allowed introduction sites or caller paths.

Example for an `ExistingFile` nominal type:

```js
/**
 * The properties that this class carries are:
 * - `path` points to a file that exists in the filesystem at the time the
 *   `ExistingFile` value is created.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through these functions:
 *   - `makeEmpty(path)`: satisfies the property because it creates the file
 *     at `path` before returning `ExistingFile`.
 *   - `fromExisting(path, proof)`: satisfies the property because it requires
 *     a `FileExistenceProof` for the same path before returning `ExistingFile`.
 *   - `makeCopy(existingFile, destinationPath)`: satisfies the property because
 *     it copies an already-existing file to `destinationPath` before returning
 *     `ExistingFile` for the destination.
 */
```

Example for a typedef-only nominal type such as `NodeIdentifier`:

```js
/**
 * The properties that this type carries are:
 * - The string is an actual node identifier that exists in the database, or an
 *   identifier allocated for insertion into the database.
 *
 * The proof of those properties is guaranteed by:
 * - `lookupNodeIdentifier(...)`: returns `NodeIdentifier` only after reading an
 *   existing identifier from the database.
 * - `allocateNodeIdentifier(...)`: returns `NodeIdentifier` only after creating
 *   a fresh identifier intended to be inserted into the database.
 * - `ensureNodeIdentifier(...)`: returns `NodeIdentifier` only by either
 *   reusing an existing database identifier or allocating a new one for the
 *   current database transaction.
 *
 * Plain strings must not be treated as `NodeIdentifier` values unless they
 * pass through one of these introduction paths.
 */
```

Example for a parsed syntax type:

```js
/**
 * The properties that this class carries are:
 * - The expression is syntactically valid.
 * - The expression has already been normalized into canonical form.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through these functions:
 *   - `parseExpression(source)`: satisfies syntactic validity because it returns
 *     an error instead of an expression when parsing fails.
 *   - `parseExpression(source)`: satisfies canonical form because it calls
 *     `normalizeParsedExpression(...)` before constructing the value.
 */
```

Example for a validated client payload:

```js
/**
 * The properties that this class carries are:
 * - The value came from a client request body.
 * - All required fields are present.
 * - All fields have the expected runtime types.
 * - Unknown fields have been rejected or explicitly ignored according to the
 *   boundary contract.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through these functions:
 *   - `tryDeserializeClientPayload(value)`: satisfies the property because it
 *     checks the object shape, validates every required field, validates every
 *     field type, and returns a specific deserialization error instead of a
 *     payload when validation fails.
 */
```

The proof comment must be kept accurate when introduction functions change. If a new constructor, factory, parser, deserializer, database reader, migration path, or caller path starts producing the nominal type, the comment must be updated in the same change.

When the proof depends on callers rather than constructors, say so explicitly. For example:

```js
/**
 * The properties that this type carries are:
 * - ...
 *
 * The proof of those properties is guaranteed by:
 * - This typedef cannot enforce the property by construction.
 * - Therefore every function that returns this type is part of the proof.
 * - The current return sites are:
 *   - `...`: satisfies the property because ...
 *   - `...`: satisfies the property because ...
 */
```

Introduce nominal types for:

* validated filesystem paths
* persisted identifiers
* parsed syntax
* validated user/client data
* database keys
* timestamps with project-specific guarantees
* capabilities/proofs/permissions
* state variants where impossible states should be ruled out
* values whose origin matters even if their runtime representation is a string/object/number

Do not introduce a nominal type for:

* a local throwaway record with no invariant
* a shape that carries no useful property
* plain data that is immediately validated into a stronger value elsewhere

The point is not nominal typing for its own sake. The point is to capture useful facts in the type structure so later code can rely on them without re-checking them.

### Make impossible states unrepresentable

When designing APIs, types, constructors, and data flow, prefer representations that make invalid states impossible to express.

This is broader than nominal typing. Nominal types are one useful tool, but many impossible states can be eliminated with ordinary object shapes, unions, required parameters, separate functions, explicit state variants, module boundaries, and careful API design.

The rule is:

> Do not represent invalid, dangerous or meaningless states if the API can be designed so those states cannot be constructed.

Before adding a type or function, ask:

1. What bad states or bad calls would this design allow?
2. Can the API be shaped so those states or calls are impossible?
3. Can separate functions, stronger parameter types, required fields, or explicit state variants remove ambiguity?
4. Can the boundary validate once and then expose only a safer representation to the rest of the codebase?

Bad:

```js
function scheduleTask(name, cron, callback, retryDelay, lastSuccessTime, lastFailureTime, pendingRetryUntil, schedulerIdentifier) {
    // Many combinations of these parameters are meaningless.
}
```

Good:

```js
function makeRunningTask(name, cron, callback, retryDelay, lastAttemptTime, schedulerIdentifier) {
    // Running tasks require the fields that make a running task meaningful.
}

function makeAwaitingRetryTask(name, cron, callback, retryDelay, lastAttemptTime, lastFailureTime, pendingRetryUntil) {
    // Retry tasks require retry-specific fields.
}

function makeAwaitingRunTask(name, cron, callback, retryDelay, lastSuccessTime, lastAttemptTime) {
    // Awaiting-run tasks only carry awaiting-run fields.
}
```

Bad:

```js
function writeEvent(event, overwrite = false, validate = true) {
    // Boolean and optional arguments create unclear call states.
}
```

Good:

```js
function createEvent(event) {
    // Creates a new event.
}

function replaceEvent(event) {
    // Replaces an existing event.
}

function writeValidatedEvent(event) {
    // Accepts only an already-validated event.
}
```

Bad:

```js
/**
 * @typedef {object} SaveResult
 * @property {boolean} success
 * @property {string | undefined} error
 * @property {string | undefined} eventId
 */
```

This allows meaningless values such as `{ success: true, error: "failed" }`.

Good:

```js
/**
 * @typedef {object} SaveSuccess
 * @property {'success'} status
 * @property {EventId} eventId
 */

/**
 * @typedef {object} SaveFailure
 * @property {'failure'} status
 * @property {SaveEventError} error
 */

/**
 * @typedef {SaveSuccess | SaveFailure} SaveResult
 */
```

Bad:

```js
function processInput(input) {
    // Accepts raw strings, parsed expressions, and validated expressions.
}
```

Good:

```js
function parseInput(rawInput) {
    // Converts raw input into a parsed value or a parse error.
}

function validateParsedInput(parsedInput) {
    // Converts parsed input into a validated value or a validation error.
}

function processValidatedInput(validatedInput) {
    // Only accepts the representation that has already crossed the boundary.
}
```

The purpose is not to prove every property in a comment. The purpose is to design the code so fewer bad situations can arise at all.

Boundary data may be weakly represented when it first enters the system. After validation, parsing, deserialization, or migration, convert it into a stronger representation and keep the weak representation out of internal code.

### Validate, Don't Verify
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

## Avoid Type-Casting
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

# Testing and Validation

## How to run tests

- **Specific tests**: `npx jest --testNamePattern="test name"`
- **Full test suite**: `npm test`
- **Build verification**: `npm run build`

## Test Conventions

- Test files are located in `backend/tests/` and `frontend/tests/`
- Use descriptive test names
- Mock external dependencies using the patterns established in `backend/tests/stubs.js`

# Complete Workflow for Independent Agents

Must follow this workflow when making changes to the source code:

1. **Setup**: `npm install` (install all dependencies)
2. **Understand**: Read relevant code and tests to understand the context
3. **Implement**: Make changes following the capabilities pattern and JSDoc conventions
4. **Test**: Run `npx jest path/to/specific/test.js` for focused testing
5. **Validate**: Run full test suite with `npm test`
6. **Build**: Run `npm run build` to ensure the project builds successfully

## Backwards compatibility

- When an AI agent finds issues with legacy code or has a clearly better suggestion for any programming interface, it SHOULD prioritize correctness and improvement and SHOULD disregard backwards compatibility.
- Exception: If a change affects data or formats that live outside this repository (for example database schemas, on-disk file formats, or other persisted storage), backwards compatibility SHOULD be preserved. Changes that would break external storage or require coordinated migrations need explicit consideration and coordination.

## Non-Adversarial Client Policy

The client (frontend) is assumed to be **non-adversarial** — it is the same developer who runs the server. This has important implications:

- **No DoS protection**: Rate limits, upload-size caps, fragment-count caps, concurrency limits, and any other latency or resource-consumption limits are **banned**. They introduce large complexity for zero benefit in this context.
- **No authorization**: Session IDs will not be forged. Authentication and authorization checks on API endpoints are unnecessary.
- **Shape validation is still required**: Even with a trusted client, client and server may drift (e.g., during development or after a schema change). All incoming data **must** be validated against the expected shape (correct types, expected field names, valid enum values) and rejected with a clear error if it does not match. This is about correctness, not security.

Summary: validate shapes, skip everything else.

## Additional Guidelines

- Follow existing naming conventions (snake_case for files, camelCase for functions)
- Maintain the dependency injection pattern through capabilities
- Add comprehensive JSDoc documentation for new functions
- Write tests for new functionality
- Use the established error handling patterns
