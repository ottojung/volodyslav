const path = require("path");
const temporary = require("./temporary");
const defaultBranch = require("../src/gitstore/default_branch");

/**
 * Creates a test repository for use in tests.
 * Specifically, it creates the eventLogRepository.
 *
 * This function initializes a bare git repository and a worktree,
 * adds some content to the worktree, and commits it.
 * The content is then pushed to the bare repository.
 *
 * Note that this function does not return anything.
 * This is because all the paths are derived from conventions in the source code.
 * I.e. the test repository is always created in the same location
 *  - the location that is later used throughout the implementation code.
 *
 * @returns {Promise<void>} A promise that resolves when the repository is created.
 */
async function stubEventLogRepository(capabilities) {
    // Let eventLogRepository be our test repository
    const gitDir = capabilities.environment.eventLogRepository();

    // Initialize a git repository
    await capabilities.git.call("init", "--bare", "--", gitDir);

    // Create a worktree
    const workTree = path.join(temporary.input(), "worktree");
    await capabilities.creator.createDirectory(workTree);
    await capabilities.git.call(
        "init",
        "--initial-branch",
        defaultBranch,
        "--",
        workTree
    );

    // Create some content
    const testFile = path.join(workTree, "test.txt");
    const testFileObj = await capabilities.creator.createFile(testFile);
    await capabilities.writer.writeFile(testFileObj, "initial content");
    const dataFile = path.join(workTree, "data.json");
    const dataFileObj = await capabilities.creator.createFile(dataFile);
    await capabilities.writer.writeFile(dataFileObj, "");

    // Add and commit the content
    await capabilities.git.call("-C", workTree, "add", "--all");
    await capabilities.git.call(
        "-C",
        workTree,
        "-c",
        "user.name=1",
        "-c",
        "user.email=1",
        "commit",
        "-m",
        "Initial commit"
    );

    // Push the content to the bare repository
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

module.exports = { stubEventLogRepository };
