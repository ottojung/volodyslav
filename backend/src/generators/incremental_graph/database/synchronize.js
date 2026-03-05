/**
 * Synchronization module for the incremental-graph LevelDB database.
 *
 * Checkpoints the current database state (git add --all && git commit) and
 * then synchronizes it with the remote generators repository
 * (git pull && git push, or force variants).
 *
 * Callers are responsible for acquiring a lock around this call so that
 * LevelDB is not written to while git is touching its files.
 */

const gitstore = require('../../../gitstore');
const { withMutex } = require('../lock');
const workingRepository = gitstore.workingRepository;
const { checkpointDatabase, CHECKPOINT_WORKING_PATH } = require('./gitstore');

/** @typedef {import('../../../gitstore/checkpoint').Capabilities} Capabilities */
/** @typedef {import('../../../gitstore/working_repository').SyncForce} SyncForce */

/**
 * Checkpoint the database and synchronize it with the remote generators repository.
 *
 * Steps:
 * 1. `git add --all && git commit` — capture the latest in-memory state on disk.
 * 2. `git pull && git push` (or force variant) — sync with the remote.
 *
 * The caller must ensure the database is locked (not written to) for the
 * duration of this call.
 *
 * @param {Capabilities} capabilities
 * @param {{ force?: SyncForce }} [options]
 * @returns {Promise<void>}
 * @throws {import('../../../gitstore/working_repository').WorkingRepositoryError} If sync fails
 */
async function synchronize(capabilities, options) {
    await withMutex(capabilities.sleeper, async () => synchronizeUnsafe(capabilities, options));
}

/**
 * The unlocked version of synchronize().  Should only be called by synchronize() after acquiring the lock.
 *
 * @param {Capabilities} capabilities 
 * @param {{ force?: SyncForce }} [options] 
 * @return {Promise<void>}
 * @throws {import('../../../gitstore/working_repository').WorkingRepositoryError} If sync fails
 */
async function synchronizeUnsafe(capabilities, options) {
    // Step 1: checkpoint — capture current LevelDB state as a git commit.
    await checkpointDatabase(capabilities, "sync checkpoint");

    // Step 2: sync with remote.
    const remotePath = capabilities.environment.generatorsRepository();
    const remoteLocation = { url: remotePath };
    await workingRepository.synchronize(
        capabilities,
        CHECKPOINT_WORKING_PATH,
        remoteLocation,
        options
    );
}

module.exports = { synchronize };
