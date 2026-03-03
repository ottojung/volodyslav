//
// This module implements "checkpoints": lightweight commits directly onto
// the local working copy, without a temporary work tree or push step.
//
// A checkpoint is simply:
//
//   git add --all
//   git commit --allow-empty -m "$MESSAGE"
//
// run against the persistent local working copy.  It is cheaper than a full
// transaction because there is no clone / push cycle, but it provides no
// conflict-resolution against a remote – it is purely local.
//
// Use checkpoints when you control the working copy exclusively (e.g.
// "empty" initial_state repositories such as runtime-state-repository),
// or when you want to snapshot intermediate state that will be pushed later
// by a normal synchronize call.
//

const path = require("path");
const { commit } = require("./wrappers");
const workingRepository = require("./working_repository");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../logger').Logger} Logger */
/** @typedef {import('../sleeper').SleepCapability} SleepCapability */
/** @typedef {import('../datetime').Datetime} Datetime */
/** @typedef {import('./working_repository').RemoteLocation} RemoteLocation */

/**
 * @typedef {object} Capabilities
 * @property {Command} git
 * @property {FileCreator} creator
 * @property {FileDeleter} deleter
 * @property {FileChecker} checker
 * @property {FileWriter} writer
 * @property {Environment} environment
 * @property {Logger} logger
 * @property {SleepCapability} sleeper
 * @property {Datetime} datetime
 */

/**
 * Record the current state of the local working copy as a Git commit.
 *
 * Stages every change (`git add --all`) and commits with the given message.
 * Always creates a commit, even when the working tree is clean, thanks to
 * `--allow-empty`.
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
    await capabilities.sleeper.withMutex(workingPath, async () => {
        const gitDir = await workingRepository.getRepository(
            capabilities,
            workingPath,
            initial_state
        );

        // getRepository returns <workDir>/<workingPath>/.git
        // so the work directory is its parent.
        const workDir = path.dirname(gitDir);

        await commit(capabilities, gitDir, workDir, message, { allowEmpty: true });
    });
}

module.exports = {
    checkpoint,
};
