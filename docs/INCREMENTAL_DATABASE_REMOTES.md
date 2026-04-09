# Incremental Database Remote Fixtures

The old checked-in mock event-log repositories are obsolete. Development and test fixtures now model the current storage format directly: a git remote that tracks a rendered incremental-database snapshot.

## Available Fixtures

### 1. Empty Incremental Database Remote
- **Location**: `backend/tests/mock-incremental-database-remote`
- **Contents**: Only the rendered `_meta` files required to open an empty local database snapshot
- **Use case**: Fresh-start bootstrap flows and tests that want a clean rendered remote

### 2. Populated Incremental Database Remote
- **Location**: `backend/tests/mock-incremental-database-remote-populated`
- **Contents**: Rendered `config`, `all_events`, and `events_count` graph nodes plus metadata
- **Use case**: Development and bootstrap tests that need realistic graph state immediately after sync

## How They Are Materialized

The fixture directories are tracked as plain rendered snapshot trees, not as checked-in git object stores.

During development setup, `scripts/materialize-incremental-database-remote.sh` turns one of those trees into a real git remote by:

1. Initializing a local bare repository.
2. Creating a temporary worktree.
3. Copying the rendered fixture tree into that worktree.
4. Committing it on the current hostname branch (`<hostname>-main`).

The same idea is used in backend tests via `backend/tests/stub_incremental_database_remote.js`.

## Switching Fixtures In Development

### Using the Populated Fixture (Default)
```bash
./scripts/run-development-server
```

### Using the Empty Fixture
```bash
VOLODYSLAV_USE_EMPTY_INCREMENTAL_DATABASE_REMOTE=1 ./scripts/run-development-server
```

## Fixture Contents

### Populated Fixture Includes
- **Sample events**: 3 entries covering mood, exercise, and work
- **Configuration**: Help text plus 6 shortcuts (`breakfast`, `lunch`, `dinner`, `coffee`, `tea`, `gym`)
- **Derived graph state**: `all_events`, `config`, and `events_count` are already materialized in the rendered snapshot

## Development Workflow

1. **Default development**: use the populated incremental-database remote for realistic state after the first sync.
2. **Bootstrap testing**: use the empty fixture to exercise fresh-start behavior.
3. **Fixture tuning**: edit `backend/tests/mock-incremental-database-remote-populated` when you want development startup to restore different rendered graph state.