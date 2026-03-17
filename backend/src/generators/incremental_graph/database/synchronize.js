/**
 * Synchronization module for the incremental-graph LevelDB database.
 *
 * Renders the current live database into the tracked filesystem snapshot,
 * synchronizes that repository with the remote generators repository, and then
 * scans the updated snapshot back into the live database.
 *
 * Callers are responsible for acquiring a lock around this call so that
 * LevelDB is not written to while synchronization is in progress.
 */

const path = require('path');
const gitstore = require('../../../gitstore');
const { transaction } = gitstore;
const workingRepository = gitstore.workingRepository;
const isMergeHostBranchesError = gitstore.mergeHostBranches.isMergeHostBranchesError;
const {
    checkpointDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
} = require('./gitstore');
const { scanFromFilesystem } = require('./render');

/** @typedef {import('../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../filesystem/mover').FileMover} FileMover */
/** @typedef {import('../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../../../filesystem/dirscanner').DirScanner} DirScanner */
/** @typedef {import('../../../logger').Logger} Logger */
/** @typedef {import('../../../environment').Environment} Environment */
/** @typedef {import('../../../datetime').Datetime} Datetime */
/** @typedef {import('../../../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('../../../subprocess/command').Command} Command */
/** @typedef {import('../../../level_database').LevelDatabase} LevelDatabase */
/** @typedef {import('../../../generators/interface').Interface} Interface */

/**
 * @typedef {object} Capabilities
 * @property {Command} git
 * @property {FileCreator} creator
 * @property {FileDeleter} deleter
 * @property {FileChecker} checker
 * @property {FileMover} mover
 * @property {FileWriter} writer
 * @property {FileReader} reader
 * @property {DirScanner} scanner
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {SleepCapability} sleeper
 * @property {Datetime} datetime
 * @property {Interface} interface
 * @property {LevelDatabase} levelDatabase
 */

/**
 * Checkpoint the database and synchronize it with the remote generators repository.
 *
 * Steps:
 * 1. `git add --all && git commit` — capture the latest in-memory state on disk.
 * 2. `git pull && git push` (or reset-to-theirs variant) — sync with the remote.
 * 3. `git fetch origin` and merge every matching `origin/<hostname>-main`
 *    branch into the local hostname branch, collecting merge failures by host.
 *
 * The caller must ensure the database is locked (not written to) for the
 * duration of this call.
 *
 * @param {Capabilities} capabilities 
 * @param {{ resetToTheirs?: boolean, resetToHostname?: string }} [options] 
 * @return {Promise<void>}
 * @throws {import('../../../gitstore/working_repository').WorkingRepositoryError} If sync fails
 */
async function synchronizeNoLock(capabilities, options) {
    const remotePath = capabilities.environment.generatorsRepository();
    const remoteLocation = { url: remotePath };
    const { getRootDatabase } = require('./index');
    const rootDatabase = await getRootDatabase(capabilities);
    /** @type {Error | null} */
    let mergeHostBranchesError = null;

    try {
        // Step 1: render the current live database into the tracked repository.
        await checkpointDatabase(
            capabilities,
            "sync checkpoint",
            rootDatabase,
            remoteLocation
        );

        // Step 2: synchronize the rendered repository with the remote.
        try {
            await workingRepository.synchronize(
                capabilities,
                CHECKPOINT_WORKING_PATH,
                remoteLocation,
                { ...options, mergeHostBranches: true }
            );
        } catch (error) {
            if (!isMergeHostBranchesError(error)) {
                throw error;
            }
            mergeHostBranchesError = error;
        }

        // Step 3: reconstruct the live database from the synchronized snapshot.
        await transaction(
            capabilities,
            CHECKPOINT_WORKING_PATH,
            remoteLocation,
            async (store) => {
                const workTree = await store.getWorkTree();
                await scanFromFilesystem(
                    capabilities,
                    rootDatabase,
                    path.join(workTree, DATABASE_SUBPATH)
                );
            }
        );
        if (mergeHostBranchesError !== null) {
            throw mergeHostBranchesError;
        }
    } finally {
        await rootDatabase.close();
    }

    capabilities.logger.logInfo(
        { remotePath, options },
        "Synchronized generators database with remote"
    );
}

module.exports = { synchronizeNoLock };
