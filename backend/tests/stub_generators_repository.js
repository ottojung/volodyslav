const path = require("path");
const defaultBranch = require("../src/gitstore/default_branch");
const os = require("os");
const fs = require("fs").promises;

/**
 * Creates a test repository for use as the generators database remote.
 *
 * The sync code expects a real git repository at
 * `capabilities.environment.generatorsRepository()`, so tests that exercise
 * generator synchronization need to initialize one explicitly.
 *
 * @param {object} capabilities
 * @returns {Promise<void>}
 */
async function stubGeneratorsRepository(capabilities) {
    const gitDir = capabilities.environment.generatorsRepository();

    await capabilities.git.call("init", "--bare", "--", gitDir);

    const workTree = await fs.mkdtemp(path.join(os.tmpdir(), "jest-generators-worktree-"));
    await capabilities.creator.createDirectory(workTree);
    await capabilities.git.call(
        "init",
        "--initial-branch",
        defaultBranch,
        "--",
        workTree
    );

    const testFile = path.join(workTree, "README");
    const testFileObj = await capabilities.creator.createFile(testFile);
    await capabilities.writer.writeFile(testFileObj, "initial generators remote");

    await capabilities.git.call("-C", workTree, "add", "--all");
    await capabilities.git.call(
        "-C",
        workTree,
        "-c",
        "user.name=test-user",
        "-c",
        "user.email=test@example.com",
        "commit",
        "-m",
        "Initial commit"
    );

    await capabilities.git.call(
        "-C",
        workTree,
        "remote",
        "add",
        "origin",
        "--",
        gitDir
    );
    await capabilities.git.call(
        "-C",
        workTree,
        "push",
        "origin",
        defaultBranch
    );

    await capabilities.deleter.deleteDirectory(workTree);
}

module.exports = { stubGeneratorsRepository };
