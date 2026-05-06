/**
 * Gitstore integration for the incremental-graph database.
 *
 * The live LevelDB now lives outside the Git repository.  The repository tracks
 * a rendered filesystem snapshot of the database instead:
 *
 *   <workingDirectory>/
 *     generators-leveldb/           ← live LevelDB working directory
 *     generators-database/          ← git working tree
 *       .git/
 *       rendered/                   ← rendered filesystem snapshot tracked by git
 *
 * Callers create snapshots by rendering the live database into the tracked
 * snapshot directory inside a checkpointSession. If nothing has changed
 * since the last commit, the call is a no-op.
 *
 * ## Checkpoint policy
 *
 * Migration snapshots are taken only at migration boundaries. `runMigrationInTransaction`
 * wraps each migration in a single checkpointSession and records two commits:
 * one before the migration logic runs and one after it completes successfully.
 * Normal incremental-graph writes (i.e. `invalidate` + `pull` cycles) do NOT
 * produce checkpoints directly. Migration boundaries, by contrast, represent
 * discrete, application-level schema transitions that are worth preserving as
 * durable rendered snapshots.
 */

const path = require('path');
const gitstore = require('../../../gitstore');
const { checkpointSession } = gitstore;
const { resetAndCleanRepository } = gitstore.workingRepository;
const { renderToFilesystem } = require('./render');

/** @typedef {import('../../../gitstore/transaction_retry').RemoteLocation} RemoteLocation */
/** @typedef {import('./root_database').RootDatabase} RootDatabase */
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
 * @typedef {object} CheckpointCapabilities
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
 * Path (relative to `workingDirectory()`) of the git repository that stores the
 * rendered database snapshot.
 * @type {string}
 */
const CHECKPOINT_WORKING_PATH = "generators-database";

/**
 * Subdirectory name inside `CHECKPOINT_WORKING_PATH` where the rendered
 * filesystem snapshot is written and tracked by git.
 * @type {string}
 */
const DATABASE_SUBPATH = "rendered";

/**
 * Path (relative to `workingDirectory()`) of the live LevelDB directory.
 * @type {string}
 */
const LIVE_DATABASE_WORKING_PATH = "generators-leveldb";

/**
 * @param {{ environment: Environment }} capabilities
 * @returns {string}
 */
function pathToRenderedDatabase(capabilities) {
    return path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH,
        DATABASE_SUBPATH
    );
}

/**
 * @param {{ environment: Environment }} capabilities
 * @returns {string}
 */
function pathToLiveDatabase(capabilities) {
    return path.join(
        capabilities.environment.workingDirectory(),
        LIVE_DATABASE_WORKING_PATH
    );
}

/**
 * Reset and clean the checkpoint git repository to a known-good state before
 * any computation.
 *
 * The checkpoint repository cannot be assumed to be in any particular state
 * when computations begin — a previous process may have crashed mid-operation,
 * leaving behind MERGE_HEAD, staged files, untracked artifacts, or even an
 * unborn branch (git init completed but first commit never made).
 *
 * This function is called at the start of every `checkpointDatabase` and
 * `runMigrationInTransaction` session to ensure rendering starts from a clean,
 * deterministic baseline.
 *
 * @param {CheckpointCapabilities} capabilities
 * @returns {Promise<void>}
 */
async function ensureCheckpointRepoIsClean(capabilities) {
    const gitDir = path.join(
        capabilities.environment.workingDirectory(),
        CHECKPOINT_WORKING_PATH,
        ".git"
    );
    const headFile = path.join(gitDir, "HEAD");
    if ((await capabilities.checker.fileExists(headFile)) !== null) {
        await resetAndCleanRepository(capabilities, CHECKPOINT_WORKING_PATH);
    }
}

/**
 * Record the current rendered state of the database as a git commit.
 *
 * The rendered snapshot is written into `generators-database/rendered/` inside
 * a gitstore transaction. The active replica is rendered under `r/` so that
 * the snapshot always reflects the current live data regardless of which
 * replica is active. If no files have changed since the last commit, the
 * call is a no-op (no empty commit is created). The git repository is created
 * automatically on the first call.
 *
 * @param {CheckpointCapabilities} capabilities
 * @param {string} message - The git commit message.
 * @param {RootDatabase} [rootDatabase] - Open live database to render. When
 * omitted, the database is opened for the duration of this call.
 * @param {RemoteLocation | "empty"} [initialState="empty"]
 * @returns {Promise<void>}
 */
async function checkpointDatabase(
    capabilities,
    message,
    rootDatabase,
    initialState = "empty"
) {
    /** @type {RootDatabase | undefined} */
    let ownedDatabase = undefined;
    /** @type {RootDatabase} */
    let database;

    if (rootDatabase === undefined) {
        // Lazy require to avoid a circular dependency at module load time:
        // gitstore.js is required by database/index.js, so a top-level require
        // of './index' here would create a cycle.
        const { getRootDatabase } = require('./index');
        ownedDatabase = await getRootDatabase(capabilities);
        database = ownedDatabase;
    } else {
        database = rootDatabase;
    }

    try {
        capabilities.logger.logDebug({ message }, "Starting database checkpoint");
        await checkpointSession(
            capabilities,
            CHECKPOINT_WORKING_PATH,
            initialState,
            async ({ workDir, commit }) => {
                capabilities.logger.logDebug({ message }, "Ensuring checkpoint repository is clean");
                await ensureCheckpointRepoIsClean(capabilities);
                capabilities.logger.logDebug({ message }, "Rendering database snapshot for checkpoint");
                const activeReplica = database.currentReplicaName();
                await renderToFilesystem(
                    capabilities,
                    database,
                    path.join(workDir, DATABASE_SUBPATH, 'r'),
                    activeReplica
                );
                await renderToFilesystem(
                    capabilities,
                    database,
                    path.join(workDir, DATABASE_SUBPATH, '_meta'),
                    '_meta'
                );
                capabilities.logger.logDebug({ message }, "Rendered database snapshot for checkpoint, committing");
                await commit(message);
                capabilities.logger.logDebug({ message }, "Checkpoint committed");
            }
        );
        capabilities.logger.logDebug({ message }, "Finished database checkpoint");
    } finally {
        if (ownedDatabase !== undefined) {
            await ownedDatabase.close();
        }
    }
}

/**
 * Checkpoint the database before and after running a migration callback.
 *
 * Records two commits in a single `checkpointSession` — one before the
 * migration callback runs and one after it completes successfully.  Both
 * commits write directly to the persistent working copy (no temp clone or
 * push step), so there is no clone/push overhead.
 *
 * Because the pre-migration commit is made before the callback runs, it
 * remains visible in the checkpoint repository even if the callback fails.
 * This is intentional: the pre-migration snapshot provides a useful
 * diagnostic record of the database state before the failed migration.
 *
 * The pre-migration snapshot renders the active replica (before the switch).
 * The post-migration snapshot renders the newly active replica (after the switch).
 * Both are rendered to `r/` so the snapshot path is stable across migrations.
 *
 * @template T
 * @param {CheckpointCapabilities} capabilities
 * @param {RootDatabase} rootDatabase
 * @param {string} preMessage
 * @param {string} postMessage
 * @param {() => Promise<T>} callback
 * @returns {Promise<T>}
 */
async function runMigrationInTransaction(
    capabilities,
    rootDatabase,
    preMessage,
    postMessage,
    callback
) {
    capabilities.logger.logDebug({ preMessage, postMessage }, "Starting migration checkpoint");
    const ret = await checkpointSession(
        capabilities,
        CHECKPOINT_WORKING_PATH,
        "empty",
        async ({ workDir, commit }) => {
            capabilities.logger.logDebug({ preMessage, postMessage }, "Ensuring checkpoint repository is clean");
            await ensureCheckpointRepoIsClean(capabilities);
            capabilities.logger.logDebug({ preMessage, postMessage }, "Rendering pre-migration database snapshot");
            await renderToFilesystem(
                capabilities,
                rootDatabase,
                path.join(workDir, DATABASE_SUBPATH, 'r'),
                rootDatabase.currentReplicaName()
            );
            await renderToFilesystem(
                capabilities,
                rootDatabase,
                path.join(workDir, DATABASE_SUBPATH, '_meta'),
                '_meta'
            );
            capabilities.logger.logDebug({ preMessage, postMessage }, "Committing pre-migration snapshot");
            await commit(preMessage);
            capabilities.logger.logDebug({ preMessage, postMessage }, "Pre-migration snapshot committed, running migration callback");
            const result = await callback();
            capabilities.logger.logDebug({ preMessage, postMessage }, "Migration callback complete, rendering post-migration database snapshot");
            await renderToFilesystem(
                capabilities,
                rootDatabase,
                path.join(workDir, DATABASE_SUBPATH, 'r'),
                rootDatabase.currentReplicaName()
            );
            await renderToFilesystem(
                capabilities,
                rootDatabase,
                path.join(workDir, DATABASE_SUBPATH, '_meta'),
                '_meta'
            );
            capabilities.logger.logDebug({ preMessage, postMessage }, "Committing post-migration snapshot");
            await commit(postMessage);
            capabilities.logger.logDebug({ preMessage, postMessage }, "Post-migration snapshot committed");
            return result;
        }
    );
    capabilities.logger.logDebug({ preMessage, postMessage }, "Finished migration checkpoint");
    return ret;
}

module.exports = {
    checkpointDatabase,
    runMigrationInTransaction,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    pathToRenderedDatabase,
    pathToLiveDatabase,
};
