//
// This module provides definitions and methods
// for working with the local copy of the git repository
// that Volodyslav uses to store events in.
//

const path = require("path");
const gitmethod = require("./wrappers");
const { cloneAndConfigureRepository } = require("./clone_setup");
const { git } = require("../executables");
const { withRetry } = require("../retryer");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/mover').FileMover} FileMover */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('../generators/interface').Interface} Interface */

/**
 * @typedef {object} RemoteLocation
 * @property {string} url - The URL or path to the remote repository
 */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {FileMover} mover - A file mover instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {Datetime} datetime - Datetime utilities.
 * @property {Interface} interface - An interface instance with an update() method.
 */

/**
 * Custom error for WorkingRepository operations.
 */
class WorkingRepositoryError extends Error {
    /**
     * @param {string} message
     * @param {string} repositoryPath
     */
    constructor(message, repositoryPath) {
        super(message);
        this.name = "WorkingRepositoryError";
        this.repositoryPath = repositoryPath;
    }
}

/**
 * Type guard for WorkingRepositoryError.
 * @param {unknown} object - The object to check.
 * @returns {object is WorkingRepositoryError}
 */
function isWorkingRepositoryError(object) {
    return object instanceof WorkingRepositoryError;
}

/**
 * Get local repository path.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} workingPath - The path to the working directory.
 * @returns {string} - The absolute path to the local git repository.
 */
function pathToLocalRepository(capabilities, workingPath) {
    const wd = capabilities.environment.workingDirectory();
    return path.join(wd, workingPath);
}

/**
 * Get the path to the local repository's .git directory.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} workingPath - The path to the working directory.
 * @returns {string} - The absolute path to the .git directory.
 */
function pathToLocalRepositoryGitDir(capabilities, workingPath) {
    return path.join(pathToLocalRepository(capabilities, workingPath), ".git");
}

/**
 * Check whether the git repository at workDir has an "origin" remote configured.
 * @param {Capabilities} capabilities
 * @param {string} workDir - The repository working directory.
 * @returns {Promise<boolean>}
 */
async function hasOriginRemote(capabilities, workDir) {
    return capabilities.git.call(
        "-C", workDir, "-c", "safe.directory=*",
        "remote", "get-url", "origin"
    ).then(() => true).catch(() => false);
}

/**
 * @param {Capabilities} capabilities
 * @param {string} gitDir
 * @returns {Promise<boolean>}
 */
async function isRebaseInProgress(capabilities, gitDir) {
    return (
        (await capabilities.checker.directoryExists(path.join(gitDir, "rebase-merge"))) !== null
        || (await capabilities.checker.directoryExists(path.join(gitDir, "rebase-apply"))) !== null
    );
}

/**
 * @param {Capabilities} capabilities
 * @param {string} gitDir
 * @param {"merge" | "rebase" | "cherry-pick" | "revert"} operation
 * @returns {Promise<boolean>}
 */
async function isAbortableOperationInProgress(capabilities, gitDir, operation) {
    if (operation === "merge") {
        return (await capabilities.checker.fileExists(path.join(gitDir, "MERGE_HEAD"))) !== null;
    }
    if (operation === "rebase") {
        return await isRebaseInProgress(capabilities, gitDir);
    }
    if (operation === "cherry-pick") {
        return (await capabilities.checker.fileExists(path.join(gitDir, "CHERRY_PICK_HEAD"))) !== null;
    }
    if (operation === "revert") {
        return (await capabilities.checker.fileExists(path.join(gitDir, "REVERT_HEAD"))) !== null;
    }
    throw new WorkingRepositoryError(
        `Unknown abortable operation: ${operation}`,
        gitDir
    );
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workDir
 * @param {string} gitDir
 * @param {"merge" | "rebase" | "cherry-pick" | "revert"} operation
 * @returns {Promise<void>}
 */
async function abortOperationIfInProgress(capabilities, workDir, gitDir, operation) {
    const inProgress = await isAbortableOperationInProgress(capabilities, gitDir, operation);
    if (!inProgress) {
        return;
    }
    /** @type {unknown | null} */
    let abortError = null;
    try {
        await capabilities.git.call(
            "-C", workDir, "-c", "safe.directory=*",
            operation, "--abort"
        );
    } catch (error) {
        abortError = error;
    }
    const stillInProgress = await isAbortableOperationInProgress(capabilities, gitDir, operation);
    if (stillInProgress) {
        const reason = abortError === null
            ? "operation state unexpectedly persists after successful --abort"
            : String(abortError);
        throw new WorkingRepositoryError(
            `Failed to abort ${operation}: ${reason}`,
            workDir
        );
    }
}

/**
 * Reset and clean a git repository to a known-good state before use.
 *
 * Aborts any in-progress git operations (merge, rebase, cherry-pick, revert),
 * resets the working tree to the last committed state, and removes all
 * untracked files and directories.  When the branch is unborn (i.e. `git init`
 * completed but the first commit was never made due to an earlier crash) a new
 * initial empty commit is created so that subsequent `git clone` calls succeed.
 *
 * This function must be called before any computation that relies on the local
 * repository being in a deterministic state, because the repository cannot be
 * assumed to be clean when we start using it (a previous process may have
 * crashed mid-operation).
 *
 * @param {Capabilities} capabilities
 * @param {string} workingPath
 * @returns {Promise<void>}
 */
async function resetAndCleanRepository(capabilities, workingPath) {
    const workDir = pathToLocalRepository(capabilities, workingPath);
    const gitDir = path.join(workDir, ".git");

    // Abort any in-progress git operations. Fail fast if an operation remains
    // in progress after abort, because subsequent reset/clean cannot guarantee
    // a deterministic repository state in that case.
    await abortOperationIfInProgress(capabilities, workDir, gitDir, "merge");
    await abortOperationIfInProgress(capabilities, workDir, gitDir, "rebase");
    await abortOperationIfInProgress(capabilities, workDir, gitDir, "cherry-pick");
    await abortOperationIfInProgress(capabilities, workDir, gitDir, "revert");

    // Check whether the branch already has at least one commit.  An unborn
    // branch (HEAD points to a ref that does not yet exist) is left by an
    // interrupted `initializeEmptyRepository` call.
    const hasCommits = await capabilities.git
        .call("-C", workDir, "-c", "safe.directory=*", "rev-parse", "--verify", "HEAD")
        .then(() => true)
        .catch(() => false);

    if (hasCommits) {
        // continue to shared reset/clean below
    } else {
        // Ensure the initial commit is truly empty even if a stale index exists:
        // an interrupted previous run may have left entries staged in the index
        // despite the branch still being unborn.
        await capabilities.git.call(
            "-C", workDir,
            "-c", "safe.directory=*",
            "read-tree",
            "--empty"
        );
        // No commits yet – finish the interrupted initialisation by creating
        // the missing initial empty commit so that clones work.
        await capabilities.git.call(
            "-C", workDir,
            "-c", "safe.directory=*",
            "-c", "user.name=volodyslav",
            "-c", "user.email=volodyslav",
            "commit",
            "--allow-empty",
            "--message",
            "Initial empty commit",
        );
    }

    // Discard any staged or modified tracked files.
    await capabilities.git.call(
        "-C", workDir, "-c", "safe.directory=*",
        "reset", "--hard", "HEAD"
    );
    // Remove untracked files and directories left by previous operations.
    await capabilities.git.call(
        "-C", workDir, "-c", "safe.directory=*",
        "clean", "-fd"
    );
}

/**
 * Synchronize the local repository with remote: pull if exists, else clone.
 * Then push the changes as well.
 * @param {Capabilities} capabilities
 * @param {string} workingPath - The path to the working directory.
 * @param {RemoteLocation} origin - Remote location or local location to sync with.
 * @param {{ resetToHostname?: string, mergeHostBranches?: boolean }} [options] - Optional sync options.
 * @returns {Promise<void>}
 * @throws {WorkingRepositoryError} If synchronization of the working repository fails.
 * @throws {MergeHostBranchesError} If merging host branches during synchronization fails.
 */
async function synchronize(capabilities, workingPath, origin, options) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities, workingPath);
    const workDir = pathToLocalRepository(capabilities, workingPath);
    const headFile = path.join(gitDir, "HEAD");
    const remotePath = origin.url;
    const resetToHostname = options && options.resetToHostname;
    const mergeHostBranches = options && options.mergeHostBranches;

    // Determine once, before any retry, whether the local repo exists without
    // a remote configured.  Repos initialised via initializeEmptyRepository
    // have no remote; we must add origin and accept the remote state via
    // fetchAndReconcile to reconcile the otherwise unrelated local history.
    // Computing this flag here (rather than lazily inside the retry loop)
    // keeps the retry logic simple and free of nullable state.
    const localExists = (await capabilities.checker.fileExists(headFile)) !== null;
    const needsRemoteSetup = localExists && !(await hasOriginRemote(capabilities, workDir));

    // If the local repository already exists it may have been left in a dirty
    // state by a previous interrupted run.  Reset it once before the retry
    // loop so that pull/merge/read-tree operations start from a clean baseline.
    if (localExists) {
        await resetAndCleanRepository(capabilities, workingPath);
    }

    /**
     * @param {{ attempt: number, retry: () => void }} args
     */
    async function synchronizeRetry({ attempt, retry }) {
        const exists = await capabilities.checker.fileExists(headFile);

        // When connecting a local-only repo to a remote for the first time,
        // ensure origin is configured before any git network operation.
        // The alreadyAdded guard makes this idempotent across retries.
        if (needsRemoteSetup && exists) {
            const alreadyAdded = await hasOriginRemote(capabilities, workDir);
            if (!alreadyAdded) {
                await capabilities.git.call(
                    "-C", workDir, "-c", "safe.directory=*",
                    "remote", "add", "origin", remotePath
                );
            }
        }

        try {
            if (resetToHostname !== undefined || (exists && needsRemoteSetup)) {
                if (exists) {
                    // fetchAndReconcile reconciles the local repo with the remote,
                    // including the case where they have unrelated histories.
                    await gitmethod.fetchAndReconcile(
                        capabilities,
                        workDir,
                        resetToHostname
                    );
                    if (resetToHostname !== undefined) {
                        await gitmethod.push(capabilities, workDir);
                    }
                } else {
                    await cloneAndConfigureRepository(
                        capabilities,
                        { remotePath, workDir, headFile, resetToHostname }
                    );
                    if (resetToHostname !== undefined) {
                        await gitmethod.fetchAndReconcile(
                            capabilities,
                            workDir,
                            resetToHostname
                        );
                        await gitmethod.push(capabilities, workDir);
                    }
                }
            } else {
                if (exists) {
                    await gitmethod.pull(capabilities, workDir);
                    await gitmethod.push(capabilities, workDir);
                } else {
                    await cloneAndConfigureRepository(
                        capabilities,
                        { remotePath, workDir, headFile }
                    );
                }
            }

            if (mergeHostBranches) {
                await gitmethod.mergeRemoteHostBranches(capabilities, workDir);
            }
        } catch (error) {
            capabilities.logger.logInfo({ repository: remotePath, error }, "Failed to synchronize repository");
            if (gitmethod.isMergeHostBranchesError(error)) {
                capabilities.logger.logError(
                    {
                        repository: remotePath,
                        attempt,
                        error,
                        errorName: error instanceof Error ? error.name : "UnknownError",
                        errorMessage: error instanceof Error ? error.message : String(error),
                    },
                    "Failed to merge host branches during synchronize"
                );
                throw error;
            }
            if (attempt < 100) {
                await new Promise(resolve => setTimeout(resolve, 0));
                return retry();
            }

            capabilities.logger.logError(
                {
                    repository: remotePath,
                    attempt,
                    error,
                    errorName: error instanceof Error ? error.name : "UnknownError",
                    errorMessage: error instanceof Error ? error.message : String(error),
                },
                "Failed to synchronize repository after retries exhausted"
            );
            throw error;
        }
    }

    try {
        capabilities.logger.logInfo({ repository: remotePath }, "Synchronizing repository");
        await withRetry(capabilities, "synchronize", synchronizeRetry);
    } catch (err) {
        if (gitmethod.isMergeHostBranchesError(err)) {
            throw err;
        }
        throw new WorkingRepositoryError(
            `Failed to synchronize repository: ${err}`,
            origin.url
        );
    }
}

/**
 * Initialize an empty Git repository.
 * @param {Capabilities} capabilities - The capabilities object.
 * @param {string} workingPath - The path to the working directory.
 */
async function initializeEmptyRepository(capabilities, workingPath) {
    const workDir = pathToLocalRepository(capabilities, workingPath);
    capabilities.logger.logInfo({ repository: workDir }, "Initializing empty repository");

    /**
     * Retry initialization of the empty repository.
     * @param {{ attempt: number, retry: () => void }} args
     */
    async function initializeEmptyRepositoryRetry({ attempt, retry }) {
        try {
            await gitmethod.init(capabilities, workDir);
        } catch {
            capabilities.logger.logInfo({ repository: workDir }, "Init command failed");
        }

        try {
            // Configure the repository to allow pushing to the current branch
            await gitmethod.makePushable(capabilities, workDir);

            // Create an empty initial commit so the repository has an initial branch
            // This is required for the transaction system to work (clone operations need a branch)
            await git.call(
                "-C", workDir,
                "-c", "safe.directory=*",
                "-c", "user.name=volodyslav",
                "-c", "user.email=volodyslav",
                "commit",
                "--allow-empty",
                "--message",
                "Initial empty commit",
            );
        } catch (err) {
            capabilities.logger.logInfo({ repository: workDir }, "Repository initialization did not succeed sucessfully");
            if (attempt < 100) {
                await new Promise(resolve => setTimeout(resolve, 0));
                return retry();
            }

            capabilities.logger.logError(
                {
                    repository: workDir,
                    attempt,
                    error: err,
                    errorName: err instanceof Error ? err.name : "UnknownError",
                    errorMessage: err instanceof Error ? err.message : String(err),
                },
                "Failed to initialize empty repository after retries exhausted"
            );
            throw err;
        }
    }

    try {
        await capabilities.creator.createDirectory(workDir);
        await withRetry(capabilities, "initialize empty repository: " + workDir, initializeEmptyRepositoryRetry);
    } catch (err) {
        throw new WorkingRepositoryError(
            `Failed to initialize empty repository: ${err}`,
            workDir
        );
    }
}

/**
 * Ensure the repository is present locally and return its path.
 * Note: returns the path to the `.git` directory.
 *
 * @param {Capabilities} capabilities
 * @param {string} workingPath - The path to the working directory.
 * @param {RemoteLocation | "empty"} initial_state - Remote location to sync with, or "empty" for local-only
 * @returns {Promise<string>}
 * @throws {WorkingRepositoryError}
 */
async function getRepository(capabilities, workingPath, initial_state) {
    const gitDir = pathToLocalRepositoryGitDir(capabilities, workingPath);
    const headFile = path.join(gitDir, "HEAD");

    if (!(await capabilities.checker.fileExists(headFile))) {
        if (initial_state === "empty") {
            await initializeEmptyRepository(capabilities, workingPath);
        } else {
            await synchronize(capabilities, workingPath, initial_state);
        }
    }

    return gitDir;
}

module.exports = {
    synchronize,
    getRepository,
    resetAndCleanRepository,
    isWorkingRepositoryError,
};
