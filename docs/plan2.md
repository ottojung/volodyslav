# Migration Fixture Regression Test / Tooling Plan (Populated Incremental-Database Remote)

## Scope and Non-Goals

This document is a **plan only** for adding a fixture-level migration regression workflow around rendered incremental-database fixtures.

Planned implementation will:

- add a hermetic Jest test that validates migration from:
  - `backend/tests/mock-incremental-database-remote-populated-lastversion/` (input fixture)
  - to `backend/tests/mock-incremental-database-remote-populated/` (expected fixture)
- add a separate maintainer-only fixture update command.

This plan explicitly does **not** propose:

- mutating tracked fixtures in normal Jest runs,
- normalization/semantic comparison of fixture files,
- production version-semantic changes,
- broad policy checks (clean tree checks, etc.).

---

## Repository Study Summary (relevant facts)

1. Migration is gated by stored `global/version` vs current app/db version; if equal, migration is skipped; if different, migration runs into inactive replica and switches pointer. (`runMigration`)
2. Root DB version comes from `getVersion(capabilities)` (VERSION file, then `git describe`, then package fallback), so fixtures can churn if left unpinned.
3. Rendered fixture trees are plain file trees under `backend/tests/mock-incremental-database-remote*`, and existing helper `stub_incremental_database_remote.js` already supports seeding test remotes from fixture directories.
4. Existing tests already use temporary dirs, capability stubs, and git-backed remote seeding patterns that can be reused for hermetic migration tests.

---

## Planned File Changes (future implementation)

### 1) Add new fixture source tree

- **Add**: `backend/tests/mock-incremental-database-remote-populated-lastversion/**`
  - Initial population is expected to be derived from current populated fixture.
  - Then edit the **rendered active-replica global version file** to a distinct previous token (expected path likely `rendered/r/global/version`, but verify canonical path first) with value `0.0.0-dev-previous`.

### 2) Add new hermetic migration fixture test

- **Add**: `backend/tests/migration_fixture_populated_remote.test.js`

### 3) Add test/tool helpers (small, local)

Preferred minimal options:

- either **add**: `backend/tests/migration_fixture_helpers.js`
- or keep helpers private in the new test file if reuse is low.

Helpers will cover:

- recursive copy of fixture trees to temp directories,
- exact directory comparison (path/content) ignoring `.git/`,
- capability-level VERSION shim for fixture test/update paths,
- (if needed) active-replica render mapping helper matching canonical fixture layout.

### 4) Add maintainer update entrypoint (script file)

- **Add**: `scripts/update-migration-fixture-populated-remote.js` (Node script using project capabilities/testing patterns)

### 5) Wire npm script in root package

- **Change**: `package.json` root scripts
- Add:
  - `"backend:migration-fixture:update": "node scripts/update-migration-fixture-populated-remote.js"`

No production source files are planned to be modified.

---

## Stable Synthetic Version Strategy (concrete)

Goal: avoid `git describe` churn in fixture `global/version`, while preserving real migration behavior.

Planned tokens:

- **Current synthetic version** for fixture test/update paths: `0.0.0-dev`.
- **Previous fixture stored version**: `0.0.0-dev-previous`.

### Preferred injection mechanism: capability-level VERSION shim

Use a helper that patches capabilities (not production code) so `getVersion()` sees a synthetic `VERSION` file first:

```js
function forceVersion(capabilities, version) {
  const originalInstantiate = capabilities.checker.instantiate.bind(capabilities.checker);
  const originalReadFileAsText = capabilities.reader.readFileAsText.bind(capabilities.reader);

  capabilities.checker.instantiate = async (filePath) => {
    if (filePath.endsWith('/VERSION')) {
      return { path: filePath };
    }
    return originalInstantiate(filePath);
  };

  capabilities.reader.readFileAsText = async (filePath) => {
    if (filePath.endsWith('/VERSION')) {
      return `${version}\n`;
    }
    return originalReadFileAsText(filePath);
  };
}
```

Why this is preferred:

- avoids Jest import-order brittleness,
- works in both Jest test and standalone Node update script,
- keeps production version semantics unchanged.

---

## Canonical Rendered Layout Requirement (must be resolved first)

Before implementing comparison/export logic, perform one explicit investigation task:

- identify the **canonical rendered fixture layout** used by `backend/tests/mock-incremental-database-remote-populated/`, including whether it is active-replica normalized as `r/` and how `_meta` is represented.

Implementation rule:

- migrated output must be rendered/exported into **exactly that same layout** before comparison.
- if output API yields raw `x/` or `y/`, map/transform to the canonical fixture representation exactly as existing fixture tooling does (no content normalization).

This avoids false failures caused by representation mismatch instead of migration mismatch.

---

## Hermetic Jest Test Design

## Test name

Proposed suite/case:

- `describe("populated rendered fixture migration")`
- `test("migrating lastversion fixture reproduces current populated fixture exactly")`

## Step-by-step flow

1. **Create test capabilities** with existing stubs (`getMockedRootCapabilities`, `stubEnvironment`, `stubDatetime`, `stubLogger`).
2. **Apply capability-level version shim** with `forceVersion(capabilities, "0.0.0-dev")`.
3. **Materialize remote from previous fixture**:
   - copy `backend/tests/mock-incremental-database-remote-populated-lastversion/` into a temp worktree/remote setup (reuse `stubIncrementalDatabaseRemoteBranches` fixtureName extension or local copy helper in test).
4. **Run interface lifecycle initialization path (preferred and default)** so migration runs through the same bootstrap/init path as production startup.
   - fallback to direct `runMigration` only if lifecycle setup proves impractical; if so, implementation must document why.
5. **Render/export migrated state into temp output directory in canonical fixture layout** (confirmed in the required investigation step above, including active-replica-to-`r/` mapping if applicable).
6. **Compare output directory vs checked-in expected fixture** `backend/tests/mock-incremental-database-remote-populated/`:
   - strict path set equality + byte-for-byte content equality,
   - ignore only `.git/` subtrees.
7. **Fail with actionable diff message** when mismatch occurs (missing files, extra files, changed file content path list).

## Hermeticity guarantees

- No writes into tracked fixture directories during test.
- Only temp directories are created/mutated.
- Any git repos created are temp and deleted in `finally`/cleanup.

---

## Fixture Update Command Design (separate maintainer workflow)

Script name:

- `backend:migration-fixture:update`
- implemented by `scripts/update-migration-fixture-populated-remote.js`

## Step-by-step flow

1. Create capabilities and apply `forceVersion(capabilities, "0.0.0-dev")`.
2. Promote current expected fixture to previous fixture when updating:
   - copy `backend/tests/mock-incremental-database-remote-populated/` to `backend/tests/mock-incremental-database-remote-populated-lastversion/`.
   - edit the rendered active-replica global version file in lastversion fixture (expected likely `rendered/r/global/version`, verify first) to `0.0.0-dev-previous`.
3. Materialize remote from `...-lastversion`.
4. Run lifecycle initialization/migration path with current synthetic version (`0.0.0-dev`).
5. Render/export migrated result to temp output directory in canonical fixture layout.
6. Replace contents of `backend/tests/mock-incremental-database-remote-populated/` with that rendered output.
7. End with normal git diff showing fixture updates for review.

Notes:

- This script may mutate tracked fixtures; test may not.
- No clean-working-tree enforcement is added.

---

## Exact Comparison Design (ignore only `.git/`)

Helper behavior:

1. Walk both directories recursively.
2. Skip directories named exactly `.git` and everything beneath them.
3. Build sorted relative file path lists.
4. Detect:
   - files present only in actual (extra),
   - files present only in expected (missing),
   - files present in both with unequal raw bytes/text (changed).
5. Fail once with compact multi-section message:
   - `Missing files:` list
   - `Extra files:` list
   - `Changed files:` list

No normalization steps at all:

- no JSON parse/stringify,
- no newline normalization,
- no semantic equivalence logic.

---

## How Migration Is Triggered in Test/Tooling

Migration triggers naturally through existing migration gate when:

- previous stored `global/version` (from lastversion fixture) != runtime current version.

Concretely:

- fixture input contains `0.0.0-dev-previous`,
- runtime fixture/test current version is forced to `0.0.0-dev` via capability shim.

This ensures real migration runner behavior (decision planning, write into inactive replica, switch pointer) is exercised instead of calling migration internals in isolation.

---

## Expected Failure Modes and Messages

1. **Directory structure drift**
   - Missing/extra files reported by relative path.

2. **Content drift**
   - Changed files listed explicitly by path.

3. **Fixture materialization/setup error**
   - include source fixture path and operation stage (copy, git init, push, scan, render).

4. **Version shim not applied**
   - if observed output version differs from `0.0.0-dev`, fail with explicit note that synthetic version pin did not take effect.

5. **Migration probably did not run (diagnostic only, not preflight policy)**
   - if exact comparison fails and observed output version remains `0.0.0-dev-previous`, include a diagnostic note that migration likely did not execute.

---

## Risks / Ambiguities Found

1. **Canonical layout confirmation**
   - must be explicitly verified before implementing export/comparison (especially active-replica mapping).

2. **Lifecycle setup complexity**
   - lifecycle path is required by default for realism; if it is too heavy, fallback path must be justified in implementation notes.

3. **Fixture branch/layout assumptions**
   - existing fixture stubs assume `rendered/` tree shape and hostname branch naming; new lastversion fixture must match those conventions exactly.

---

## Implementation Order (when executing this plan)

1. Confirm canonical rendered fixture layout used by `mock-incremental-database-remote-populated/` (including active-replica mapping).
2. Add `...-lastversion` fixture directory baseline and set rendered active-replica global version file to `0.0.0-dev-previous` (path verified in step 1).
3. Add capability-level version shim helper.
4. Add strict directory comparison helper (ignoring only `.git/`).
5. Add new hermetic migration fixture Jest test with temp-dir flow, lifecycle initialization path, and `forceVersion(..., "0.0.0-dev")`.
6. Verify test fails on intentional mismatch and passes on correct state.
7. Add maintainer update script file implementing promotion + migration + overwrite flow with same version shim and canonical layout export.
8. Add root `package.json` script `backend:migration-fixture:update`.
9. Run targeted tests and relevant backend migration/render/sync tests.

---

## Proposed Commands (future usage)

- Normal regression test (example):
  - `npx jest backend/tests/migration_fixture_populated_remote.test.js`
- Maintainer fixture refresh:
  - `npm run backend:migration-fixture:update`
