const path = require("path");
const { defaultBranch } = require("../src/gitstore");
const { FORMAT_MARKER } = require("../src/generators/incremental_graph/database");

/** @typedef {import("../src/capabilities/root").Capabilities} Capabilities */

/**
 * Creates a test repository for use as the generators database remote.
 *
 * The sync code expects a real git repository at
 * `capabilities.environment.generatorsRepository()`, so tests that exercise
 * generator synchronization need to initialize one explicitly.
 *
 * The remote also needs a minimal rendered snapshot so that the
 * reset-to-hostname boot path can scan `_meta/` back into LevelDB.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function stubGeneratorsRepository(capabilities) {
    const branch = defaultBranch(capabilities);
    const gitDir = capabilities.environment.generatorsRepository();

    await capabilities.git.call("init", "--bare", "--", gitDir);

    const workTree = path.join(
        capabilities.environment.workingDirectory(),
        "generators-remote-bootstrap"
    );
    if (await capabilities.checker.directoryExists(workTree)) {
        await capabilities.deleter.deleteDirectory(workTree);
    }
    await capabilities.creator.createDirectory(workTree);
    await capabilities.git.call(
        "init",
        "--initial-branch",
        branch,
        "--",
        workTree
    );

    const testFile = path.join(workTree, "README");
    const testFileObj = await capabilities.creator.createFile(testFile);
    await capabilities.writer.writeFile(testFileObj, "initial generators remote");

    // Add a minimal rendered snapshot so the reset-to-hostname path can
    // scan `_meta/` back into LevelDB.  The format marker and replica
    // pointer are the only required keys; `r/` is left absent (git does
    // not track empty dirs) and the scan path handles that as an empty
    // replica.
    const renderedMetaDir = path.join(workTree, "rendered", "_meta");
    await capabilities.creator.createDirectory(renderedMetaDir);

    // Use the FORMAT_MARKER constant exported from root_database so that this
    // stub does not drift if the format value ever changes.
    const formatFile = path.join(renderedMetaDir, "format");
    const formatFileObj = await capabilities.creator.createFile(formatFile);
    await capabilities.writer.writeFile(formatFileObj, JSON.stringify(FORMAT_MARKER));

    const replicaFile = path.join(renderedMetaDir, "current_replica");
    const replicaFileObj = await capabilities.creator.createFile(replicaFile);
    await capabilities.writer.writeFile(replicaFileObj, '"x"');

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
        branch
    );

    await capabilities.deleter.deleteDirectory(workTree);
}

module.exports = { stubGeneratorsRepository };
