const { isCommandUnavailable } = require("../subprocess");
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

    const statusResult = await capabilities.git.call(
        "-c", "safe.directory=*",
        "--git-dir", git_directory,
        "--work-tree", work_directory,
        "status",
        "--porcelain"
    );
    if (statusResult.stdout.trim() === "") {
        return;
    }

    await capabilities.git.call(
        "-c", "safe.directory=*",
        "-c", "user.name=volodyslav",
        "-c", "user.email=volodyslav",
        "--git-dir", git_directory,
        "--work-tree", work_directory,
        "commit",
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
        "--no-edit",
        "--ff-only",
        `origin/${branch}`
    );
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @param {boolean} [force]
 * @returns {Promise<void>}
 */
async function push(capabilities, workDirectory, force) {
    const branch = defaultBranch(capabilities);
    try {
        await ensureCurrentBranch(capabilities, workDirectory);
        /** @type {string[]} */
        const forceArgs = force ? ["--force"] : [];
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
            ...forceArgs,
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
 * Fetch from the remote and reconcile the local branch to match the remote
 * branch content while preserving a push-safe history.
 *
 * The merge/read-tree sequence intentionally avoids `git reset --hard` so that
 * reset mode can publish with a normal non-force push.
 *
 * @param {Capabilities} capabilities - The capabilities object containing the git command.
 * @param {string} workDirectory - The repository directory to reset
 * @param {string} [resetToHostname] - Optional hostname branch to reset to.
 * @returns {Promise<void>}
 * @throws {Error} When git fetch or merge operation fails
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
        "origin"
    );
    await ensureCurrentBranch(capabilities, workDirectory);
    const currentHead = (await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "rev-parse",
        "HEAD"
    )).stdout.trim();
    const targetHead = (await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "rev-parse",
        `origin/${branch}`
    )).stdout.trim();
    if (currentHead === targetHead) {
        return;
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
        "merge",
        "--no-ff",
        "--allow-unrelated-histories",
        "--strategy=ours",
        "--no-commit",
        `origin/${branch}`
    );
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
        "--reset",
        "-u",
        `origin/${branch}`
    );
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
        "--allow-empty",
        "--message",
        `Reset contents to origin/${branch}`
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
