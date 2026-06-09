const { isCommandUnavailable } = require("../subprocess");
const { isProcessFailedError } = require("../subprocess/call");
const { git } = require("../executables");
const defaultBranch = require("./default_branch");
const { configureRemoteForAllBranches, ensureCurrentBranch } = require("./branch_setup");
const { mergeRemoteHostBranches, MergeHostBranchesError, isMergeHostBranchesError } = require("./merge_host_branches");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - Environment access including hostname.
 */

class GitUnavailable extends Error {
    constructor() {
        super(
            "Git operations unavailable. Git executable not found in $PATH. Please ensure that Git is installed and available in your $PATH."
        );
    }
}

class PushError extends Error {
    /**
     * @param {string} message - Error message
     * @param {string} workDirectory - The directory where push failed
     * @param {Error|null} cause - Underlying cause of the error
     */
    constructor(message, workDirectory, cause = null) {
        super(message);
        this.name = "PushError";
        this.workDirectory = workDirectory;
        this.cause = cause;
    }
}

/** @param {unknown} object @returns {object is PushError} */
function isPushError(object) {
    return object instanceof PushError;
}

/**
 * Determine whether a ProcessFailedError came from a git diff --exit-code
 * call that returned exit code 1, meaning differences were found.
 * @param {unknown} error
 * @returns {boolean}
 */
function isDiffHasChangesError(error) {
    return (
        isProcessFailedError(error) &&
        error.originalError !== undefined &&
        typeof error.originalError === 'object' &&
        error.originalError !== null &&
        'code' in error.originalError &&
        error.originalError.code === 1
    );
}

/** @returns {Promise<void>} */
async function ensureGitAvailable() {
    try {
        await git.ensureAvailable();
    } catch (error) {
        if (isCommandUnavailable(error)) {
            throw new GitUnavailable();
        }
        throw error;
    }
}

/**
 * Commit staged changes with a message.
 * Does nothing if the working tree is clean (no changes to commit).
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} git_directory - The `.git` directory
 * @param {string} work_directory - The repository directory, where the actual files are
 * @param {string} message - The commit message
 * @returns {Promise<void>}
 */
async function commit(capabilities, git_directory, work_directory, message) {
    // First add all files (including new untracked files) to the staging area
    await capabilities.git.call(
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "--git-dir",
        git_directory,
        "--work-tree",
        work_directory,
        "add",
        "--all"
    );

    try {
        await capabilities.git.call(
            "-c", "safe.directory=*",
            "--git-dir", git_directory,
            "--work-tree", work_directory,
            "diff",
            "--cached",
            "--quiet",
            "--exit-code",
            "--"
        );
        // Exit code 0: no staged changes
        return;
    } catch (error) {
        if (!isDiffHasChangesError(error)) {
            throw error;
        }
        // Exit code 1: staged changes exist, proceed to commit
    }

    await capabilities.git.call(
        "-c", "safe.directory=*",
        "-c", "user.name=volodyslav",
        "-c", "user.email=volodyslav",
        "--git-dir", git_directory,
        "--work-tree", work_directory,
        "commit",
        "--quiet",
        "--message", message,
    );
}

/**
 * Make the repository pushable by setting up the necessary configuration.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to make pushable
 * @returns {Promise<void>}
 */
async function makePushable(capabilities, workDirectory) {
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "config",
        "receive.denyCurrentBranch",
        "ignore"
    );
}

/**
 * Clone latest changes from the remote repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} remote_uri - The repository path to pull from (can be a remote URI or local path)
 * @param {string} work_directory - The repository directory to pull to
 * @param {{ branch?: string }} [options] - Optional clone options.
 * @returns {Promise<void>}
 */
async function clone(capabilities, remote_uri, work_directory, options) {
    const branch = (options && options.branch) ? options.branch : defaultBranch(capabilities);
    await capabilities.git.call(
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "clone",
        "--quiet",
        "--depth=1",
        "--no-single-branch",
        `--branch=${branch}`,
        "--",
        remote_uri,
        work_directory
    );
}

/**
 * Pull changes from the remote repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to pull from
 * @returns {Promise<void>}
 */
async function pull(capabilities, workDirectory) {
    const branch = defaultBranch(capabilities);
    await configureRemoteForAllBranches(capabilities, workDirectory);
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "fetch",
        "--quiet",
        "origin"
    );
    if (!(await ensureCurrentBranch(capabilities, workDirectory))) {
        return;
    }
    // Merge the already-fetched remote ref rather than calling git-pull,
    // which would perform a redundant second fetch.
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "merge",
        "--quiet",
        "--no-edit",
        "--ff-only",
        `origin/${branch}`
    );
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<void>}
 */
async function push(capabilities, workDirectory) {
    const branch = defaultBranch(capabilities);
    try {
        await ensureCurrentBranch(capabilities, workDirectory);
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "push",
            "--quiet",
            "-u",
            "origin",
            branch
        );
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : String(error);
        throw new PushError(
            `Failed to push to remote repository: ${errorMessage}`,
            workDirectory,
            error instanceof Error ? error : null
        );
    }
}

/**
 * Fetch from the remote and reset the local branch work tree to match the
 * remote branch content. If files changed, create a commit with a merge-like
 * message so reset mode remains push-safe with a normal push.
 *
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to reset
 * @param {string} [resetToHostname] - Optional hostname branch to reset to.
 * @returns {Promise<void>}
 * @throws {Error} When git fetch/read-tree/commit operation fails
 */
async function fetchAndReconcile(capabilities, workDirectory, resetToHostname) {
    const branch = resetToHostname === undefined
        ? defaultBranch(capabilities)
        : `${resetToHostname}-main`;
    await configureRemoteForAllBranches(capabilities, workDirectory);
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "fetch",
        "--quiet",
        "origin"
    );
    await ensureCurrentBranch(capabilities, workDirectory);
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "read-tree",
        "--quiet",
        "--reset",
        "-u",
        `origin/${branch}`
    );
    try {
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "diff",
            "--cached",
            "--quiet",
            "--exit-code",
            "--"
        );
        // Exit code 0: nothing changed
        return;
    } catch (error) {
        if (!isDiffHasChangesError(error)) {
            throw error;
        }
        // Exit code 1: tree changed, commit the merge-like reset
    }
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "commit",
        "--quiet",
        "--message",
        `Merge-like reset to origin/${branch}`
    );
}

/**
 * Initialize a new git repository.
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The directory to initialize as a git repository
 * @returns {Promise<void>}
 */
async function init(capabilities, workDirectory) {
    const branch = defaultBranch(capabilities);
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "-c",
        "user.name=volodyslav",
        "-c",
        "user.email=volodyslav",
        "init",
        "--quiet",
        "--template",
        "/proc/some/non/existant/path",
        "--initial-branch",
        branch
    );
}

module.exports = {
    ensureGitAvailable,
    commit,
    makePushable,
    clone,
    pull,
    mergeRemoteHostBranches,
    push,
    fetchAndReconcile,
    init,
    PushError,
    isPushError,
    MergeHostBranchesError,
    isMergeHostBranchesError,
};
