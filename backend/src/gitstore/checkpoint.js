//
// This module implements "checkpoints": lightweight commits directly onto
// the local working copy, without a temporary work tree or push step.
//
// A checkpoint is simply:
//
//   git add --all
//   git commit -m "$MESSAGE"
//
// run against the persistent local working copy.  It is cheaper than a full
// transaction because there is no clone / push cycle, but it provides no
// conflict-resolution against a remote – it is purely local.
//
// If the working tree is clean (no changes since the last commit), the
// checkpoint is a no-op: no new commit is created.
//
// Use checkpoints when you control the working copy exclusively (e.g.
// "empty" initial_state repositories such as runtime-state-repository),
// or when you want to snapshot intermediate state that will be pushed later
// by a normal synchronize call.
//

const path = require("path");
const { commit } = require("./wrappers");
const workingRepository = require("./working_repository");
const { gitStoreMutexKey } = require("./mutex");
const { ensureCurrentBranch } = require("./branch_setup");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/mover').FileMover} FileMover */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('./working_repository').RemoteLocation} RemoteLocation */
/** @typedef {import('../generators/interface').Interface} Interface */

/**
 * @typedef {object} Capabilities
 * @property {Command} git
 * @property {FileCreator} creator
 * @property {FileDeleter} deleter
 * @property {FileChecker} checker
 * @property {FileMover} mover
 * @property {FileWriter} writer
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {SleepCapability} sleeper
 * @property {Datetime} datetime
 * @property {Interface} interface - An interface instance with an update() method.
 */

/**
 * Record the current state of the local working copy as a Git commit.
 *
 * Stages every change (`git add --all`) and commits with the given message.
 * If the working tree is already clean, no commit is created (no-op).
 *
 * The call acquires the per-`workingPath` in-process mutex so it is safe to
 * interleave with concurrent `transaction()` calls on the same path.
 *
 * @param {Capabilities} capabilities
 * @param {string} workingPath - Logical name of the local repository
 *   (relative to `environment.workingDirectory()`).
 * @param {RemoteLocation | "empty"} initial_state - How to create the
 *   repository the first time it is accessed.  Pass `"empty"` for a
 *   local-only repository, or a `{ url }` object to clone from a remote.
 * @param {string} message - The commit message.
 * @returns {Promise<void>}
 * @throws {import('./working_repository').WorkingRepositoryError} When the
 *   repository cannot be initialised.
 */
async function checkpoint(capabilities, workingPath, initial_state, message) {
    await capabilities.sleeper.withMutex(gitStoreMutexKey(workingPath), async () => {
        const gitDir = await workingRepository.getRepository(
            capabilities,
            workingPath,
            initial_state
        );

        // getRepository returns <workDir>/<workingPath>/.git
        // so the work directory is its parent.
        const workDir = path.dirname(gitDir);

        await commit(capabilities, gitDir, workDir, message);
    });
}

/**
 * Acquire the checkpoint mutex and provide direct access to the working copy.
 *
 * Like `checkpoint`, but hands the caller a `workDir` path and a bound
 * `commit(message)` helper so that it can perform custom pre-commit work
 * (e.g. rendering files into the work tree) or issue multiple commits within
 * a single mutex scope.
 *
 * Before invoking the callback, `checkpointSession` ensures the working copy
 * is on the hostname branch (derived from `capabilities.environment`).  This
 * guard is skipped when the repository has no commits yet (unborn branch), so
 * callbacks that create the initial commit are still supported.
 *
 * Use this instead of `transaction` when you are the only writer (local-only
 * or remote-backed repository where you control all updates).  There is no
 * clone/push overhead and no retry logic.  When the repository is remote-backed
 * (`RemoteLocation` initial state), the caller is responsible for ensuring no
 * concurrent remote writers will conflict — `checkpointSession` commits only to
 * the local working copy and never pushes.
 *
 * @template T
 * @param {Capabilities} capabilities
 * @param {string} workingPath - Logical name of the local repository
 *   (relative to `environment.workingDirectory()`).
 * @param {RemoteLocation | "empty"} initial_state - How to create the
 *   repository the first time it is accessed.  Pass `"empty"` for a
 *   local-only repository, or a `{ url }` object for a remote-backed
 *   repository (commits go only to the local working copy; no push).
 * @param {(session: { workDir: string, commit: (message: string) => Promise<void> }) => Promise<T>} callback
 *   Called while holding the mutex. Receives the work-tree directory and a
 *   `commit(message)` helper pre-bound to the correct `gitDir`/`workDir`.
 * @returns {Promise<T>}
 * @throws {import('./working_repository').WorkingRepositoryError} When the
 *   repository cannot be initialised.
 */
async function checkpointSession(capabilities, workingPath, initial_state, callback) {
    return await capabilities.sleeper.withMutex(gitStoreMutexKey(workingPath), async () => {
        const gitDir = await workingRepository.getRepository(
            capabilities,
            workingPath,
            initial_state
        );

        // getRepository returns <workDir>/<workingPath>/.git
        // so the work directory is its parent.
        const workDir = path.dirname(gitDir);

        // Ensure we commit on the correct hostname branch.  git checkout cannot
        // operate on an unborn branch (no commits yet), so we skip the guard in
        // that case; the callback is expected to create the initial commit
        // (e.g. via ensureCheckpointRepoIsClean) before calling commit().
        const hasCommits = await capabilities.git
            .call("-C", workDir, "-c", "safe.directory=*", "rev-parse", "--verify", "HEAD")
            .then(() => true)
            .catch(() => false);
        if (hasCommits) {
            await ensureCurrentBranch(capabilities, workDir);
        }

        return await callback({
            workDir,
            commit: (message) => commit(capabilities, gitDir, workDir, message),
        });
    });
}

module.exports = {
    checkpoint,
    checkpointSession,
};
