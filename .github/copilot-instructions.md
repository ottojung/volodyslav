# GitHub Copilot Instructions

**ALWAYS follow these instructions first and fallback to additional search and context gathering only if the information in the instructions is incomplete or found to be in error.**

## Project Overview
This is a JavaScript project with JSDoc typing for a personal event logging system. It consists of a Node.js backend and a React frontend in a monorepo structure.

## Working Effectively With This Codebase

### Initial Setup (Required for Fresh Repository)

**Mandatory workflow when working on a fresh clone:**

```bash
npm install   # Install dependencies in root and all workspaces (takes ~60 seconds)
npm test      # Run the full test suite to verify setup (takes ~60 seconds) 
npm run static-analysis # Type checking, linting, etc. (takes ~18 seconds)
npm run build # Verify the project builds successfully (takes ~9 seconds)
```

**NEVER CANCEL these commands** - they may take longer than expected:
- `npm install`: Set timeout to 120+ seconds (typically 60s)
- `npm test`: Set timeout to 120+ seconds (typically 60s, may have 1 flaky test)
- `npm run build`: Set timeout to 60+ seconds (typically 9s)
- `npm run static-analysis`: Set timeout to 60+ seconds (typically 18s)

### Development Workflow

**Start Development Environment:**
```bash
npm run dev
```
- Frontend Dev Server → http://localhost:5173
- Backend API Server → http://localhost:3000
- **NEVER CANCEL**: Initial startup takes 30-45 seconds

**Development Repository Options:**
- Default: Uses populated test repository with sample events and configuration
- Empty repository: Set `VOLODYSLAV_USE_EMPTY_REPO=1 npm run dev` for clean slate testing

### Building and Testing

**Build the Project:**
```bash
npm run build  # TypeScript compilation + frontend build (9s)
```

**Run Tests:**
```bash
npm test        # Full test suite: TypeScript + ESLint + Jest (60s)
npm run test-only  # Jest tests only (faster)
npx jest backend/tests/specific.test.js  # Specific test file
npx jest --testNamePattern="test name"   # Specific test pattern
```

**Static Analysis:**
```bash
npm run static-analysis  # TypeScript checking + ESLint (18s)
npm run lint            # ESLint only
npm run lint:fix        # ESLint with auto-fix
```

**Custom Linting Rules:**
```bash
npm run rules:test      # Test custom ESLint rules (<1s)
npm run rules:new my-rule  # Generate new custom rule with boilerplate
```

**CRITICAL**: Always run these validation steps before committing:
```bash
npm run build         # Ensure builds successfully
npm run static-analysis  # Ensure no type/lint errors
npm test             # Ensure tests pass
```

### Manual Validation Scenarios

**ALWAYS test these scenarios after making changes:**

1. **API Functionality Test:**
   ```bash
   # Start dev server first: npm run dev
   curl -X POST http://localhost:3000/api/entries \
     -H "Content-Type: application/json" \
     -d '{"rawInput": "work meeting with team"}'
   ```
   Expected: 201 response with created entry data

2. **Frontend Basic Workflow:**
   - Navigate to http://localhost:5173
   - Test event input functionality 
   - Verify entries display correctly
   - Test configuration loading

3. **CLI Testing:**
   ```bash
   node backend/src/index.js --help  # Verify CLI works
   node backend/src/index.js start   # Start production server
   ```

### Build Timing and Expectations

**Command Timing Reference:**
- `npm install`: 60 seconds (1-2 minutes on slow connections)
- `npm run build`: 9 seconds
- `npm test`: 60 seconds (1 flaky test may extend this)
- `npm run static-analysis`: 18 seconds  
- `npm run rules:test`: <1 second
- `npm run dev` startup: 30-45 seconds

**NEVER CANCEL these operations** - set timeouts to at least double the expected time.

### Repository Structure and Key Locations

**Monorepo Structure:**
```
/
├── backend/          # Express.js API server
│   ├── src/         # Backend source code  
│   └── tests/       # Backend Jest tests
├── frontend/        # React application with Vite
│   ├── src/         # Frontend source code
│   └── tests/       # Frontend Jest tests  
├── scripts/         # Development and build scripts
├── tools/           # Custom ESLint plugin system
└── docs/           # Documentation
```

**Important Files:**
- `package.json`: Root workspace configuration
- `scripts/run-development-server`: Main dev environment script
- `scripts/run-tests`: Test script used by CI
- `.github/workflows/main.yml`: CI pipeline configuration
- `tools/eslint-plugin-volodyslav/`: Custom linting rules

### Common Commands Reference

**Frequently Used Commands:**
```bash
# Development
npm run dev                    # Start both frontend & backend
npm run dev -w frontend        # Frontend only
npm run dev -w backend         # Backend only  

# Production
npm run start                  # Build and start production server
make install                   # Install to system (uses scripts/install)

# Testing & Quality
npm test                       # Full test suite
npm run test-only             # Skip TypeScript/ESLint, run Jest only
npm run static-analysis       # TypeScript + ESLint
npm run rules:test            # Test custom ESLint rules

# Building
npm run build                 # Build frontend for production
npm run build -w frontend     # Frontend build only
tsc                          # TypeScript compilation check
```

### Troubleshooting Common Issues

**Port Conflicts:**
```bash
# Kill processes using development ports
lsof -ti:3000 | xargs kill -9  # Backend port
lsof -ti:5173 | xargs kill -9  # Frontend port
pkill -f "node.*volodyslav"    # Kill any volodyslav processes
```

**Build Issues:**
- If TypeScript errors: Run `tsc --noEmit` to see detailed type errors
- If ESLint fails: Run `npm run lint:fix` to auto-fix issues  
- If tests fail: Check for port conflicts, ensure clean environment

**Development Environment Issues:**
- Repository not found: Check `dist/test/` directory exists and is populated
- OpenAI errors: Set `VOLODYSLAV_OPENAI_API_KEY` if using transcription features
- Permission errors: Ensure write access to `dist/` directory

### Development Repository System

This project includes two test repositories for development:

**Populated Repository (Default):**
- Location: `backend/tests/mock-event-log-repository-populated`
- Contains sample events and configuration shortcuts
- Use for realistic development experience

**Empty Repository:**
- Location: `backend/tests/mock-event-log-repository`  
- Clean slate for testing initial user experience
- Enable with: `VOLODYSLAV_USE_EMPTY_REPO=1 npm run dev`

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

## Testing and Validation

### Running Tests
- **Full test suite**: `npm test` (60s) - NEVER CANCEL, includes TypeScript + ESLint + Jest
- **Jest only**: `npm run test-only` (faster, skips static analysis)
- **Specific test file**: `npx jest backend/tests/specific.test.js`
- **Specific test pattern**: `npx jest --testNamePattern="test name"`
- **Frontend tests**: `npm run test -w frontend`
- **Backend tests**: `npm run test -w backend`
- **Build verification**: `npm run build`

### Test Conventions
- Test files are located in `backend/tests/` and `frontend/tests/`
- Use descriptive test names that explain the scenario being tested
- Mock external dependencies using the patterns established in `backend/tests/stubs.js`
- Follow existing test structure with `describe` blocks for organization

### Known Test Issues
- **Flaky test**: `backend/tests/polling_scheduler_persistence_errors.test.js` may timeout occasionally
- **Solution**: Re-run if it fails, the test infrastructure is solid otherwise

### Custom Linting System

This repository uses a sophisticated custom ESLint plugin system:

**Testing Custom Rules:**
```bash
npm run rules:test  # Run all custom rule tests (<1s)
```

**Adding New Rules:**
```bash
npm run rules:new my-rule-name  # Generate boilerplate
# Edit: tools/eslint-plugin-volodyslav/rules/my-rule-name.js
# Test: npm run rules:test
```

**Custom Rules Location:**
- Rules: `tools/eslint-plugin-volodyslav/rules/`
- Tests: `tools/eslint-plugin-volodyslav/tests/`
- Auto-discovery: New rules are automatically enabled

### Complete Validation Workflow

**Before Making Changes:**
1. `npm install` - Ensure dependencies are current
2. `npm test` - Verify baseline functionality  
3. `npm run build` - Confirm project builds

**After Making Changes:**
1. **Unit Testing**: Run relevant specific tests first
   ```bash
   npx jest path/to/related/test.js
   ```

2. **Code Quality**: Run static analysis
   ```bash
   npm run static-analysis  # TypeScript + ESLint (18s)
   ```

3. **Full Validation**: Run complete test suite
   ```bash
   npm test  # Full suite (60s) - NEVER CANCEL
   ```

4. **Manual Validation**: Test actual functionality
   ```bash
   npm run dev  # Start development environment
   # Test scenarios listed in "Manual Validation Scenarios" section
   ```

5. **Build Verification**: Ensure production build works
   ```bash
   npm run build  # Production build (9s)
   ```

**CI Pipeline Validation:**
The GitHub Actions workflow (`.github/workflows/main.yml`) runs:
1. `npm ci` - Clean dependency install
2. `npm run build` - Frontend build  
3. `npm run static-analysis` - TypeScript + ESLint
4. `npm run test-only` - Jest tests
5. Docker build verification

Always ensure your changes pass all these steps locally.

## Backwards compatibility

- When an AI agent finds issues with legacy code or has a clearly better suggestion for any programming interface, it SHOULD prioritize correctness and improvement and SHOULD disregard backwards compatibility.
- Exception: If a change affects data or formats that live outside this repository (for example database schemas, on-disk file formats, or other persisted storage), backwards compatibility SHOULD be preserved. Changes that would break external storage or require coordinated migrations need explicit consideration and coordination.

## Additional Guidelines

- Follow existing naming conventions (snake_case for files, camelCase for functions)
- Maintain the dependency injection pattern through capabilities
- Add comprehensive JSDoc documentation for new functions
- Write tests for new functionality
- Use the established error handling patterns

## Quick Reference: Common Outputs

### Repository Root Directory Listing
```
.devcontainer/          # Development container config
.github/               # GitHub Actions and this file
backend/               # Express.js API server
frontend/              # React application  
scripts/               # Build and development scripts
tools/                 # Custom ESLint plugin
docs/                  # Documentation
package.json           # Root workspace configuration
Makefile              # System install/uninstall
README.md             # Project overview
```

### Key Package.json Scripts
```json
{
  "dev": "sh scripts/run-development-server",
  "build": "tsc && npm run build -w frontend", 
  "start": "npm run build && npm run start -w backend",
  "static-analysis": "tsc --noEmit && eslint .",
  "test": "tsc --noEmit && eslint . && jest",
  "test-only": "jest",
  "rules:test": "npm --prefix tools/eslint-plugin-volodyslav run test",
  "rules:new": "node scripts/new-rule.mjs"
}
```

### Environment Variables for Development
```bash
VOLODYSLAV_OPENAI_API_KEY        # For audio transcription (optional)
VOLODYSLAV_USE_EMPTY_REPO=1      # Use empty test repository
VOLODYSLAV_EVENT_LOG_REPOSITORY  # Custom repository path
VOLODYSLAV_SERVER_PORT=3000      # Backend port (default)
VOLODYSLAV_LOG_LEVEL=debug       # Logging level
```

### Key Dependencies
**Backend:** Express.js, Pino (logging), Commander (CLI), Luxon (dates), OpenAI SDK, Multer (uploads)
**Frontend:** React, Vite, Chakra UI, React Router
**Development:** TypeScript (checkJs mode), Jest, ESLint, Babel, Concurrently

## Complete Workflow for Independent Agents

When working on a request from start to finish:

1. **Setup**: `npm install` (install all dependencies, 60s)
2. **Understand**: Read relevant code and tests to understand the context
3. **Implement**: Make changes following the capabilities pattern and JSDoc conventions
4. **Test**: Run `npx jest path/to/specific/test.js` for focused testing
5. **Validate**: Run full test suite with `npm test` (60s - NEVER CANCEL)
6. **Build**: Run `npm run build` to ensure the project builds successfully (9s)
7. **Manual Test**: Start `npm run dev` and validate actual functionality
8. **Verify**: Run `npm run static-analysis` for final code quality check (18s)
