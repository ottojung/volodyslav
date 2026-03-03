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
 * The commit is forced with `--allow-empty` so it is always safe to call even
 * when the database files have not changed.
 *
 * CHECKPOINT_WORKING_PATH and DATABASE_SUBPATH are exported so that
 * `database/index.js` can construct the correct absolute database path
 * without duplicating the path constants.
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
 * `git add --all` and commits them.  `--allow-empty` guarantees a commit
 * is always created even when no files changed.
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
