const defaultBranch = require("./default_branch");
const { configureRemoteForAllBranches } = require("./branch_setup");
const { parseRemoteHostnameBranch } = require("../hostname");

/** @typedef {import('../subprocess/command').Command} Command */
/** @typedef {import('../environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - Environment access including hostname.
 */

class MergeHostBranchesError extends Error {
    /**
     * @param {string} workDirectory
     * @param {Array<{ hostname: string, message: string }>} failures
     */
    constructor(workDirectory, failures) {
        super(formatMergeHostBranchesMessage(failures));
        this.name = "MergeHostBranchesError";
        this.workDirectory = workDirectory;
        this.failures = failures;
    }
}

/** @param {unknown} object @returns {object is MergeHostBranchesError} */
function isMergeHostBranchesError(object) {
    return object instanceof MergeHostBranchesError;
}

/**
 * @param {Array<{ hostname: string, message: string }>} failures
 * @returns {string}
 */
function formatMergeHostBranchesMessage(failures) {
    return [
        "Failed to merge generators database branches:",
        ...failures.map(({ hostname, message }) => `- ${hostname}: ${message}`),
    ].join("\n");
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<Array<string>>}
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
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<void>}
 */
async function abortMerge(capabilities, workDirectory) {
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
        "--abort"
    );
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<void>}
 */
async function mergeRemoteHostBranches(capabilities, workDirectory) {
    const currentBranch = defaultBranch(capabilities);
    const failures = [];

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
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "reset",
        "--hard",
    );
    await capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "clean",
        "-fd",
    );

    for (const remoteBranch of await listRemoteBranches(capabilities, workDirectory)) {
        const hostname = parseRemoteHostnameBranch(remoteBranch);
        if (hostname === null || remoteBranch === `origin/${currentBranch}`) {
            continue;
        }

        try {
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
                "--allow-unrelated-histories",
                remoteBranch
            );
        } catch (error) {
            try {
                await abortMerge(capabilities, workDirectory);
            } catch (abortError) {
                const errorMessage = error instanceof Error ? error.message : String(error);
                const abortMessage = abortError instanceof Error
                    ? abortError.message
                    : String(abortError);
                failures.push({
                    hostname,
                    message: `${errorMessage} (and merge abort failed: ${abortMessage})`,
                });
                continue;
            }

            failures.push({
                hostname,
                message: error instanceof Error ? error.message : String(error),
            });
        }
    }

    if (failures.length > 0) {
        throw new MergeHostBranchesError(workDirectory, failures);
    }
}

module.exports = {
    mergeRemoteHostBranches,
    MergeHostBranchesError,
    isMergeHostBranchesError,
};
