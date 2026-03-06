/**
 * Gitstore integration for the incremental-graph database.
 *
 * The database directory (LevelDB files) lives INSIDE a dedicated local git
 * repository so that `git add --all && git commit` literally checkpoints the
 * raw database state:
 *
 *   <workingDirectory>/
 *     generators-database/          ← git working tree (local-only repo)
 *       .git/
 *       leveldb/                    ← LevelDB database files (only top-level entry)
 *
 * Callers create snapshots by calling `checkpointDatabase(capabilities, message)`.
 * If nothing has changed since the last commit, the call is a no-op.
 *
 * CHECKPOINT_WORKING_PATH and DATABASE_SUBPATH are exported so that
 * `database/index.js` can construct the correct absolute database path
 * without duplicating the path constants.
 *
 * ## Checkpoint policy
 *
 * Checkpoints are taken only at migration boundaries — once before and once
 * after every `runMigration` call (see `migration_runner.js`).  Normal
 * incremental-graph writes (i.e. `invalidate` + `pull` cycles) do NOT
 * produce checkpoints.  This is intentional: LevelDB writes many small
 * internal files at high frequency during normal operation, and snapshotting
 * every write would create an unbounded stream of near-identical commits with
 * little historical value.  Migration boundaries, by contrast, represent
 * discrete, application-level schema transitions that are worth preserving as
 * durable snapshots.
 */

const { checkpoint } = require('../../../gitstore');

/** @typedef {import('../../../gitstore/checkpoint').Capabilities} CheckpointCapabilities */

/**
 * Path (relative to `workingDirectory()`) of the git repository that wraps
 * the database.  This directory is both the git working tree and the parent
 * of the database directory — making the database the *only* top-level entry
 * tracked by the repository.
 * @type {string}
 */
const CHECKPOINT_WORKING_PATH = "generators-database";

/**
 * Subdirectory name inside `CHECKPOINT_WORKING_PATH` where LevelDB stores
 * its files.  The resulting absolute path is:
 *   `<workingDirectory>/<CHECKPOINT_WORKING_PATH>/<DATABASE_SUBPATH>`
 * @type {string}
 */
const DATABASE_SUBPATH = "leveldb";

/**
 * Record the current state of the database as a git commit.
 *
 * Stages all files in the git working tree (`generators-database/`) with
 * `git add --all` and commits them.  If no files have changed since the last
 * commit, the call is a no-op (no empty commit is created).
 *
 * The git repository is created automatically on the first call.
 *
 * @param {CheckpointCapabilities} capabilities
 * @param {string} message - The git commit message.
 * @returns {Promise<void>}
 */
async function checkpointDatabase(capabilities, message) {
    await checkpoint(capabilities, CHECKPOINT_WORKING_PATH, "empty", message);
}

module.exports = {
    checkpointDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
};
