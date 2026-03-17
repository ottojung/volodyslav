const defaultBranch = require("./default_branch");

/** @typedef {import('../subprocess/command').Command} Command */

/**
 * @typedef {object} Capabilities
 * @property {Command} git - A command instance for Git operations.
 */

/**
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @param {string} ref
 * @returns {Promise<boolean>}
 */
async function hasRef(capabilities, workDirectory, ref) {
    return capabilities.git.call(
        "-C",
        workDirectory,
        "-c",
        "safe.directory=*",
        "show-ref",
        "--verify",
        "--quiet",
        ref
    ).then(() => true).catch(() => false);
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<void>}
 */
async function configureRemoteForAllBranches(capabilities, workDirectory) {
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
        "--replace-all",
        "remote.origin.fetch",
        "+refs/heads/*:refs/remotes/origin/*"
    );
}

/**
 * Ensures the repository is currently on the hostname-specific branch.
 * If the branch only exists remotely, it is created locally to track origin.
 *
 * @param {Capabilities} capabilities
 * @param {string} workDirectory
 * @returns {Promise<boolean>} Whether the branch exists on origin.
 */
async function ensureCurrentBranch(capabilities, workDirectory) {
    const branch = defaultBranch(capabilities);
    const remoteRef = `refs/remotes/origin/${branch}`;
    const hasRemoteBranch = await hasRef(capabilities, workDirectory, remoteRef);

    if (await hasRef(capabilities, workDirectory, `refs/heads/${branch}`)) {
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "checkout",
            branch
        );
    } else if (hasRemoteBranch) {
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "checkout",
            "-B",
            branch,
            `origin/${branch}`
        );
    } else {
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "checkout",
            "-B",
            branch
        );
    }

    if (hasRemoteBranch) {
        await capabilities.git.call(
            "-C",
            workDirectory,
            "-c",
            "safe.directory=*",
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "branch",
            "--set-upstream-to",
            `origin/${branch}`,
            branch
        );
    }

    return hasRemoteBranch;
}

module.exports = {
    configureRemoteForAllBranches,
    ensureCurrentBranch,
};
