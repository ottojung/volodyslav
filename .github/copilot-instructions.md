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

Example:
```javascript
// ❌ Wrong: Exporting class directly
class WorkingRepository {
    constructor(path) { this.path = path; }
}
module.exports = { WorkingRepository };

// ✅ Correct: Export factory and type guard
class WorkingRepository {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand
    
    constructor(path) { this.path = path; }
}

/**
 * @param {string} path
 * @returns {WorkingRepository}
 */
function makeWorkingRepository(path) {
    return new WorkingRepository(path);
}

/**
 * @param {unknown} object
 * @returns {object is WorkingRepository}
 */
function isWorkingRepository(object) {
    return object instanceof WorkingRepository;
}

module.exports = { makeWorkingRepository, isWorkingRepository };
```

### Error Handling
- Create custom error classes that extend `Error`
- Provide type guards for custom errors
- Include relevant context in error messages

Example:
```javascript
class WorkingRepositoryError extends Error {
    constructor(message, repositoryPath) {
        super(message);
        this.repositoryPath = repositoryPath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is WorkingRepositoryError}
 */
function isWorkingRepositoryError(object) {
    return object instanceof WorkingRepositoryError;
}
```

## Testing

### Running Tests
- **Specific tests**: `jest path/to/test/file.js` or `jest --testNamePattern="test name"`
- **Full test suite**: `npm test`
- **Static analysis**: `npm run static-analysis` (includes linting and type checking)
- **Build verification**: `npm run build`

### Test Conventions
- Test files are located in `backend/tests/` and `frontend/tests/`
- Mock external dependencies using the patterns established in `backend/tests/stubs.js`

## Additional Guidelines

- Follow existing naming conventions (snake_case for files, camelCase for functions)
- Maintain the dependency injection pattern through capabilities
- Add comprehensive JSDoc documentation for new functions
- Write tests for new functionality
- Use the established error handling patterns
