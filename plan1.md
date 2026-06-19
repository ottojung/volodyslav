I’d refactor this by **splitting responsibilities**, not by gaming the line-count rule.

The current file mixes:

1. **Public migration API**: `get`, `has`, `keep`, `override`, `invalidate`, `delete`, `create`, `finalize`, etc.
2. **Identifier / schema compatibility**: `resolveNodeKeyFromIndex`, `checkSchemaCompatibility`, `_assertKeepInputPositionsCompatible`.
3. **Dependency traversal**: `readValidDependents`, `_propagateInvalidate`, `_buildStructuralDependents`, `_propagateDeletesAndCheckFanIn`.
4. **Factory / type guard**: `makeMigrationStorage`, `isMigrationStorage`.

That is why the file is now just over the max-lines rule. The class starts around the middle of the file after standalone helpers, and the latter half is mostly propagation/finalization logic.

## Strategy

Do **not** add another ESLint override. The PR already seems to have tried that, but the right fix is to make `migration_storage.js` a thin public entry point and move private helper logic into sibling modules.

I would keep the external import path stable:

```js
const { makeMigrationStorage } = require("./migration_storage");
```

So instead of turning `migration_storage.js` into a directory, keep the file and create sibling files:

```text
backend/src/generators/incremental_graph/
  migration_storage.js
  migration_storage_class.js
  migration_storage_schema.js
  migration_storage_dependencies.js
```

This avoids touching every caller.

## Design

### `migration_storage.js`

Make this the small public facade:

```js
const { MigrationStorageClass } = require("./migration_storage_class");

function makeMigrationStorage(
    prevStorage,
    newHeadIndex,
    materializedNodes,
    fingerprint,
    lastNodeIndex,
    oldGraphScheme,
    newGraphScheme,
    oldLookup
) {
    if (oldGraphScheme === undefined || newGraphScheme === undefined || oldLookup === undefined) {
        throw new Error(
            "makeMigrationStorage: oldGraphScheme, newGraphScheme, and oldLookup are required. " +
            "Test callers must build real graph schemes and identifier lookups."
        );
    }
    return new MigrationStorageClass(
        prevStorage,
        newHeadIndex,
        materializedNodes,
        fingerprint,
        lastNodeIndex,
        oldGraphScheme,
        newGraphScheme,
        oldLookup
    );
}

function isMigrationStorage(object) {
    return object instanceof MigrationStorageClass;
}

module.exports = {
    makeMigrationStorage,
    isMigrationStorage,
};
```

That corresponds to the current factory/type-guard tail of the file.

### `migration_storage_schema.js`

Move the schema/identifier compatibility helpers here:

```js
resolveNodeKeyFromIndex
checkSchemaCompatibility
assertKeepInputPositionsCompatible
makeIdentifiersKeysIndex
```

Currently `resolveNodeKeyFromIndex` resolves either a created node or an existing `identifiers_keys_map` entry, and `checkSchemaCompatibility` verifies head existence and arity in the new schema.

I would also move `_getIdentifiersKeysIndex` here as a function, but keep caching on the class:

```js
async function loadIdentifiersKeysIndex(prevStorage) { ... }
```

Then the class keeps:

```js
async _getIdentifiersKeysIndex() {
    if (this._identifiersKeysIndex !== undefined) return this._identifiersKeysIndex;
    this._identifiersKeysIndex = await loadIdentifiersKeysIndex(this.prevStorage);
    return this._identifiersKeysIndex;
}
```

This keeps the class stateful but makes parsing/indexing testable.

### `migration_storage_dependencies.js`

Move the dependency propagation logic here:

```js
readValidDependents
propagateInvalidate
buildStructuralDependents
propagateDeletesAndCheckFanIn
```

This is a natural boundary because this module owns the distinction between `valid` and structural dependencies. The file currently has `readValidDependents` near the top, then later has `_propagateInvalidate`, `_buildStructuralDependents`, and `_propagateDeletesAndCheckFanIn`; those belong together.

The functions can receive an explicit context object instead of being class methods:

```js
await propagateInvalidate({
    nodeKey,
    visited,
    prevStorage: this.prevStorage,
    materializedNodes: this.materializedNodes,
    decisions: this.decisions,
    newHeadIndex: this.newHeadIndex,
    getIdentifiersKeysIndex: () => this._getIdentifiersKeysIndex(),
});
```

and:

```js
await propagateDeletesAndCheckFanIn({
    materializedNodes: this.materializedNodes,
    decisions: this.decisions,
    oldGraphScheme: this.oldGraphScheme,
    oldLookup: this.oldLookup,
});
```

This avoids cyclic imports and makes the mutation points explicit.

### `migration_storage_class.js`

Keep the class and its public API here.

The class should import:

```js
const {
    checkSchemaCompatibility,
    assertKeepInputPositionsCompatible,
    resolveNodeKeyFromIndex,
    loadIdentifiersKeysIndex,
} = require("./migration_storage_schema");

const {
    readValidDependents,
    propagateInvalidate,
    propagateDeletesAndCheckFanIn,
} = require("./migration_storage_dependencies");
```

Then simplify the class methods:

```js
async keep(nodeKey) {
    this._assertMaterialized(nodeKey);
    await this._checkSchemaCompatibility(nodeKey);
    await this._assertKeepInputPositionsCompatible(nodeKey);
    this._setDecision(nodeKey, "keep", { kind: "keep" });
}
```

I would also add small private helpers inside the class:

```js
_assertMaterialized(nodeKey)
_setDecision(nodeKey, newKind, decision)
_checkSchemaCompatibility(nodeKey)
```

because `keep`, `override`, `invalidate`, `delete` currently repeat the same “is materialized / existing decision conflict” pattern. The public methods are spread through the class right now, with repeated materialized checks and conflict handling.

## Plan

### Step 1: Extract schema helpers

Create `migration_storage_schema.js` with:

```js
loadIdentifiersKeysIndex
resolveNodeKeyFromIndex
checkSchemaCompatibility
assertKeepInputPositionsCompatible
```

Then replace the in-file functions and `_assertKeepInputPositionsCompatible` implementation with imports.

This alone likely brings `migration_storage.js` below 300 lines, but do not stop there unless you want the smallest patch.

### Step 2: Extract dependency propagation

Create `migration_storage_dependencies.js`.

Move:

```js
readValidDependents
_buildStructuralDependents
_propagateDeletesAndCheckFanIn
```

Then change class methods:

```js
async _propagateInvalidate(nodeKey, visited) {
    await propagateInvalidate({ ... });
}

async _propagateDeletesAndCheckFanIn() {
    await propagateDeletesAndCheckFanIn({ ... });
}
```

or remove those private methods entirely and call imported functions from `override`, `invalidate`, and `finalize`.

### Step 3: Move class to `migration_storage_class.js`

Move `MigrationStorageClass` there. Keep `migration_storage.js` as the stable facade exporting `makeMigrationStorage` and `isMigrationStorage`.

This gives you a comfortable line-count margin instead of being one future helper away from failing again.

### Step 4: Optional cleanup

After the mechanical split passes tests, reduce repetition in the class:

```js
_assertMaterialized(nodeKey)
_getExistingDecision(nodeKey)
_setNewDecision(nodeKey, decision)
```

I would do this after the extraction, not during it. First make the split behavior-preserving; then clean the API internals.

### Step 5: Tests/checks

Run:

```sh
npm run static-analysis
npx jest backend/tests/migration_storage.test.js --runInBand
npx jest backend/tests/migration_runner.test.js --runInBand
```

Then, because this file is now tightly involved with the PR’s graph-scheme migration behavior, also run the validity/sync tests if available:

```sh
npx jest backend/tests/incremental_graph_validity.test.js --runInBand
npx jest backend/tests/sync_merge.test.js --runInBand
```

## My preferred final shape

```text
migration_storage.js
  public facade only

migration_storage_class.js
  MigrationStorageClass
  public migration callback API
  small private state helpers

migration_storage_schema.js
  identifiers_keys_map indexing
  node-key resolution
  schema/head/arity/input-position compatibility

migration_storage_dependencies.js
  valid-dependent traversal
  invalidate propagation
  structural dependency map
  delete propagation and fan-in checking
```

This split matches the actual conceptual seams in the file and should make future changes to graph-scheme migration much less cramped.
