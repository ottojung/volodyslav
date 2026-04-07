/**
 * Synchronization module for the incremental-graph LevelDB database.
 *
 * Renders the current live database into the tracked filesystem snapshot,
 * pushes our branch to the remote generators repository, then performs a
 * structured, per-host graph merge using the incremental-graph merge engine
 * instead of git-level textual merges.
 *
 * High-level flow:
 *   1. Render the live database and commit the snapshot to git.
 *   2. Synchronize with the remote (fetch + push our branch).
 *   3. Fetch all remote branches so hostname tracking refs are up-to-date.
 *   4. For each remote hostname branch (other than ours):
 *      a. Create a temporary git worktree pointing at that branch.
 *      b. Scan the branch's `rendered/r/` snapshot into the
 *         `hostnames/<hostname>` LevelDB namespace.
 *      c. Run the graph merge algorithm (mergeHostIntoReplica), which
 *         switches the active replica pointer on success.
 *      d. Clean up the worktree and the hostname staging namespace.
 *   5. Aggregate per-host failures; throw SyncMergeAggregateError if any.
 *
 * Callers are responsible for acquiring a lock around this call so that
 * LevelDB is not written to while synchronization is in progress.
 */

const gitstore = require('../../../gitstore');
const path = require('path');
const { transaction, configureRemoteForAllBranches, defaultBranch } = gitstore;
const workingRepository = gitstore.workingRepository;
const { parseRemoteHostnameBranch } = require('../../../hostname');
const {
    checkpointDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
} = require('./gitstore');
const { scanFromFilesystem, scanHostnameFromFilesystem } = require('./render');
const { getRootDatabase } = require('./get_root_database');
const {
    mergeHostIntoReplica,
    SyncMergeAggregateError,
    isSyncMergeAggregateError,
} = require('./sync_merge');
/**
 * Thrown when the snapshot's `_meta/current_replica` file is missing a valid
 * replica name ("x" or "y"). This indicates a corrupted or incompatible snapshot.
 */
class InvalidSnapshotReplicaError extends Error {
    /**
     * @param {unknown} value - The invalid value that was read.
     * @param {string} filePath - Path to the file that contained the bad value.
     */
    constructor(value, filePath) {
        super(
            `Snapshot _meta/current_replica has invalid value: "${String(value)}". Expected "x" or "y". File: ${filePath}`
        );
        this.name = 'InvalidSnapshotReplicaError';
        this.value = value;
        this.filePath = filePath;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidSnapshotReplicaError}
 */
function isInvalidSnapshotReplicaError(object) {
    return object instanceof InvalidSnapshotReplicaError;
}
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
 * List all remote tracking branches visible in `workDirectory`.
 * Returns branches in sorted order.
 *
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<string[]>}
 */
async function listRemoteBranches(capabilities, workDirectory) {
    const result = await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "for-each-ref",
        "--format=%(refname:short)",
        "refs/remotes/origin"
    );
    return result.stdout
        .split("\n")
        .map(branch => branch.trim())
        .filter(branch => branch !== "")
        .sort();
}

/**
 * Checkpoint the database and synchronize it with the remote generators repository.
 *
 * Steps:
 *   1. `git add --all && git commit` — capture the latest in-memory state on disk.
 *   2. `git pull && git push` (or reset-to-hostname variant) — sync with the remote.
 *   3. `git fetch origin` for all branches — fetch remote hostname branches.
 *   4. For each remote `origin/<hostname>-main` branch (excluding ours):
 *      a. Create a temporary git worktree.
 *      b. Scan `rendered/r/` into `hostnames/<hostname>` staging namespace.
 *      c. Run the graph merge algorithm.
 *      d. Clean up staging and worktree.
 *
 * The caller must ensure the database is locked (not written to) for the
 * duration of this call.
 *
 * @param {Capabilities} capabilities
 * @param {{ resetToHostname?: string }} [options]
 * @return {Promise<void>}
 * @throws {import('../../../gitstore/working_repository').WorkingRepositoryError} If git sync fails
 * @throws {SyncMergeAggregateError} If one or more per-host graph merges fail
 */
async function synchronizeNoLock(capabilities, options) {
    const remotePath = capabilities.environment.generatorsRepository();
    const remoteLocation = { url: remotePath };
    const rootDatabase = await getRootDatabase(capabilities);

    try {
        // Step 1 + 2: Render current live database → filesystem → commit → push.
        // Note: mergeHostBranches is always false; we do graph merge below.
        await checkpointDatabase(
            capabilities,
            "sync checkpoint",
            rootDatabase,
            remoteLocation
        );

        await workingRepository.synchronize(
            capabilities,
            CHECKPOINT_WORKING_PATH,
            remoteLocation,
            { ...options, mergeHostBranches: false }
        );

        // For a reset-to-hostname initialization: scan back the remote's state
        // into LevelDB so the freshly cloned/reset snapshot becomes the live DB.
        // This replaces the entire active-replica data with the remote's content.
        if (options?.resetToHostname !== undefined) {
            await transaction(
                capabilities,
                CHECKPOINT_WORKING_PATH,
                remoteLocation,
                async (store) => {
                    const workTree = await store.getWorkTree();

                    // Read the active-replica name from the snapshot's _meta/current_replica
                    // so that `r/` data lands in the correct sublevel.
                    const snapshotMetaDir = path.join(workTree, DATABASE_SUBPATH, '_meta');
                    const currentReplicaFile = path.join(snapshotMetaDir, 'current_replica');
                    if (!(await capabilities.checker.fileExists(currentReplicaFile))) {
                        throw new InvalidSnapshotReplicaError(undefined, currentReplicaFile);
                    }
                    const raw = await capabilities.reader.readFileAsText(currentReplicaFile);
                    let parsed;
                    try {
                        parsed = JSON.parse(raw);
                    } catch {
                        throw new InvalidSnapshotReplicaError(raw, currentReplicaFile);
                    }
                    if (parsed !== 'x' && parsed !== 'y') {
                        throw new InvalidSnapshotReplicaError(parsed, currentReplicaFile);
                    }
                    const snapshotReplica = parsed;

                    await scanFromFilesystem(
                        capabilities,
                        rootDatabase,
                        path.join(workTree, DATABASE_SUBPATH, 'r'),
                        snapshotReplica
                    );
                    await scanFromFilesystem(
                        capabilities,
                        rootDatabase,
                        snapshotMetaDir,
                        '_meta'
                    );
                }
            );
            return;
        }

        // Step 3: Fetch all remote branches so hostname tracking refs are up to date.
        const workDir = path.join(
            capabilities.environment.workingDirectory(),
            CHECKPOINT_WORKING_PATH
        );

        await configureRemoteForAllBranches(capabilities, workDir);
        await capabilities.git.call(
            "-C", workDir, "-c", "safe.directory=*",
            "fetch", "origin"
        );

        // Step 4: Graph-merge each remote hostname branch into the live LevelDB.
        const remoteBranches = await listRemoteBranches(capabilities, workDir);
        const ourBranch = defaultBranch(capabilities);

        /** @type {Array<{ hostname: string, message: string }>} */
        const failures = [];

        for (const remoteBranch of remoteBranches) {
            const hostname = parseRemoteHostnameBranch(remoteBranch);
            // Skip non-hostname branches (e.g. HEAD) and our own branch.
            // Our own branch is skipped because this host is the sole writer of
            // `origin/<ourBranch>`: no other machine pushes commits to that ref,
            // so the remote can never be ahead of the local DB that we just
            // checkpointed.  `workingRepository.synchronize()` already pushed our
            // latest state to the remote, so there is nothing to merge back from
            // `origin/<ourBranch>` that is not already in the live LevelDB.
            if (hostname === null || remoteBranch === `origin/${ourBranch}`) {
                continue;
            }

            // Create a temporary worktree for this hostname's branch so we can
            // read its rendered snapshot files without disturbing our checkout.
            // tmpDir creation is inside the try/catch so that ENOSPC or
            // permission errors are recorded as per-host failures rather than
            // aborting all remaining host merges.
            let tmpDir;
            let worktreeAdded = false;
            try {
                tmpDir = await capabilities.creator.createTemporaryDirectory();
                await capabilities.git.call(
                    "-C", workDir, "-c", "safe.directory=*",
                    "worktree", "add", "--detach", tmpDir, remoteBranch
                );
                worktreeAdded = true;

                const remoteRDir = path.join(tmpDir, DATABASE_SUBPATH, 'r');

                // Scan the remote's rendered/r/ into hostnames/<hostname> staging.
                await scanHostnameFromFilesystem(
                    capabilities,
                    rootDatabase,
                    remoteRDir,
                    hostname
                );

                // Run the graph merge algorithm.
                // On success this switches the active replica pointer.
                await mergeHostIntoReplica(capabilities.logger, rootDatabase, hostname);

                capabilities.logger.logInfo(
                    { hostname },
                    'Successfully merged host branch'
                );
            } catch (err) {
                failures.push({
                    hostname,
                    message: err instanceof Error ? err.message : String(err),
                });
                capabilities.logger.logInfo(
                    { hostname, error: err },
                    'Failed to merge host branch; continuing with remaining hosts'
                );
            } finally {
                // Always clean up: remove worktree and staging namespace.
                // `worktreeAdded` is only true when tmpDir was successfully created,
                // so tmpDir is always a string here (but we check to satisfy the type checker).
                if (worktreeAdded && tmpDir !== undefined) {
                    try {
                        await capabilities.git.call(
                            "-C", workDir, "-c", "safe.directory=*",
                            "worktree", "remove", "--force", tmpDir
                        );
                        // git worktree remove already deletes the directory;
                        // no separate deleteDirectory call needed.
                    } catch (cleanupErr) {
                        capabilities.logger.logInfo(
                            { hostname, error: cleanupErr },
                            'Failed to remove worktree during cleanup'
                        );
                        // Best-effort: try to delete the directory if worktree
                        // removal failed.
                        try {
                            await capabilities.deleter.deleteDirectory(tmpDir);
                        } catch {
                            // Ignore secondary cleanup failures.
                        }
                    }
                } else if (tmpDir !== undefined) {
                    // Worktree was never set up; delete the tmp dir we created.
                    try {
                        await capabilities.deleter.deleteDirectory(tmpDir);
                    } catch {
                        // Ignore cleanup failures.
                    }
                }
                try {
                    await rootDatabase.clearHostnameStorage(hostname);
                } catch (cleanupErr) {
                    failures.push({
                        hostname,
                        message: cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr),
                    });
                    capabilities.logger.logInfo(
                        { hostname, error: cleanupErr },
                        'Failed to clear hostname storage during cleanup'
                    );
                }
            }
        }

        if (failures.length > 0) {
            throw new SyncMergeAggregateError(failures);
        }
    } finally {
        await rootDatabase.close();
    }

    capabilities.logger.logInfo(
        { remotePath, options },
        "Synchronized generators database with remote"
    );
}

module.exports = {
    synchronizeNoLock,
    InvalidSnapshotReplicaError,
    isInvalidSnapshotReplicaError,
    isSyncMergeAggregateError,
};

