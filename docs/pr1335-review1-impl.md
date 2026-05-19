# PR #1335 Review 1: Implementation Plan

## 1) Migration key-plan fixes (`migration_runner.js`)

### 1.1 Import allocation primitive
- Import `allocateNodeIdentifier` from database index exports.

### 1.2 Identifier-native key plan behavior
When `identifiers_keys_map` exists:
- Build lookup from persisted entries.
- Build `decisionKeyByOutputKey` seed map from persisted entries.

Change `keyToOutputKey(nodeKey)` to:
1. allocate/reuse identifier via `allocateNodeIdentifier(lookup, nodeKey, deterministic factory)`
2. update `decisionKeyByOutputKey`
3. return identifier as `NodeIdentifier`

### 1.3 Ensure output map persistence includes created nodes
- Make `outputEntries` dynamic (computed from `serializeIdentifierLookup(lookup)` at read time), not immutable snapshot.
- This guarantees newly allocated keys from create-decisions are persisted.

## 2) Pull-path error semantics (`pull.js`)

Update `internalPullByNodeIdentifierWithStatusDuringPull`:
- Detect direct semantic-key input by string prefix `{`.
- If semantic key: bypass resolver.
- If identifier: call `identifierResolver.requireNodeKey(...)` and let mapping errors propagate.
- Enforce that resolved key is serialized semantic key before deserialization.

## 3) Lookup typing cleanup (`database/identifier_lookup.js`)

- Change persisted-entry typedefs:
  - `makeIdentifierLookup(entries)` input: `Array<[NodeIdentifier, NodeKeyString]>`
  - `serializeIdentifierLookup(...)` return type: same.

## 4) Documentation deliverables
Create:
- `docs/pr1335.md`
- `docs/pr1335-review1-.md`
- `docs/pr1335-review1-strat.md`
- `docs/pr1335-review1-impl.md`

## 5) Validation sequence
1. `npm install`
2. targeted tests for migration runner / pull behavior
3. `npm test`
4. `npm run static-analysis`
5. `npm run build`
