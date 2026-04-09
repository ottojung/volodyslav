const path = require("path");
const {
    DATABASE_SUBPATH,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");

/** @typedef {import("../src/capabilities/root").Capabilities} Capabilities */

const CURRENT_REPLICA_META_KEY = "!_meta!current_replica";
const EMPTY_FIXTURE_NAME = "mock-incremental-database-remote";
const POPULATED_FIXTURE_NAME = "mock-incremental-database-remote-populated";

class IncrementalDatabaseRemoteFixtureError extends Error {
    /**
     * @param {string} message
     * @param {string} [fixtureName]
     */
    constructor(message, fixtureName) {
        super(message);
        this.name = "IncrementalDatabaseRemoteFixtureError";
        this.fixtureName = fixtureName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is IncrementalDatabaseRemoteFixtureError}
 */
function isIncrementalDatabaseRemoteFixtureError(object) {
    return object instanceof IncrementalDatabaseRemoteFixtureError;
}

/**
 * @typedef {object} IncrementalDatabaseRemoteBranch
 * @property {string} hostname
 * @property {"empty" | "populated"} [fixtureName]
 * @property {Array<[string, *]>} [entries]
 */

/**
 * @param {string} fixtureName
 * @returns {string}
 */
function fixturePath(fixtureName) {
    switch (fixtureName) {
        case "empty":
            return path.join(__dirname, EMPTY_FIXTURE_NAME);
        case "populated":
            return path.join(__dirname, POPULATED_FIXTURE_NAME);
        default:
            throw new IncrementalDatabaseRemoteFixtureError(
                `Unknown incremental database remote fixture: ${fixtureName}`,
                fixtureName
            );
    }
}

/**
 * @param {string} hostname
 * @returns {string}
 */
function branchNameForHostname(hostname) {
    return `${hostname}-main`;
}

/**
 * @param {string} key
 * @returns {string}
 */
function renderedKeyPath(key) {
    return keyToRelativePath(key).replace(/^[xy]\//, "r/");
}

/**
 * @param {Capabilities} capabilities
 * @param {string} sourceDir
 * @param {string} destinationDir
 * @returns {Promise<void>}
 */
async function copyDirectoryRecursively(capabilities, sourceDir, destinationDir) {
    await capabilities.creator.createDirectory(destinationDir);
    const members = await capabilities.scanner.scanDirectory(sourceDir);

    for (const member of members) {
        const targetPath = path.join(destinationDir, path.basename(member.path));
        if (await capabilities.checker.directoryExists(member.path)) {
            await copyDirectoryRecursively(capabilities, member.path, targetPath);
            continue;
        }

        const existingFile = await capabilities.checker.instantiate(member.path);
        await capabilities.copier.copyFile(existingFile, targetPath);
    }
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workTree
 * @param {Array<[string, *]>} entries
 * @returns {Promise<void>}
 */
async function writeRenderedEntries(capabilities, workTree, entries) {
    const entriesToWrite = [...entries];
    if (!entriesToWrite.some(([key]) => key === CURRENT_REPLICA_META_KEY)) {
        entriesToWrite.push([CURRENT_REPLICA_META_KEY, "x"]);
    }

    for (const [key, value] of entriesToWrite) {
        const filePath = path.join(
            workTree,
            DATABASE_SUBPATH,
            ...renderedKeyPath(key).split("/")
        );
        const file = await capabilities.creator.createFile(filePath);
        await capabilities.writer.writeFile(file, JSON.stringify(value, null, 2));
    }
}

/**
 * @param {Capabilities} capabilities
 * @param {string} workTree
 * @param {IncrementalDatabaseRemoteBranch} branch
 * @returns {Promise<void>}
 */
async function seedWorkTree(capabilities, workTree, branch) {
    if (branch.entries !== undefined) {
        await writeRenderedEntries(capabilities, workTree, branch.entries);
        return;
    }

    const sourceFixture = fixturePath(branch.fixtureName ?? "empty");
    await copyDirectoryRecursively(capabilities, sourceFixture, workTree);
}

/**
 * @param {Capabilities} capabilities
 * @param {string} remotePath
 * @param {IncrementalDatabaseRemoteBranch} branch
 * @returns {Promise<void>}
 */
async function pushRemoteBranch(capabilities, remotePath, branch) {
    const branchName = branchNameForHostname(branch.hostname);
    const workTree = await capabilities.creator.createTemporaryDirectory();

    try {
        await capabilities.git.call(
            "init",
            "--initial-branch",
            branchName,
            "--",
            workTree
        );
        await seedWorkTree(capabilities, workTree, branch);
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
            `Seed ${branchName}`
        );
        await capabilities.git.call(
            "-C",
            workTree,
            "remote",
            "add",
            "origin",
            "--",
            remotePath
        );
        await capabilities.git.call("-C", workTree, "push", "origin", branchName);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

/**
 * Creates a bare git remote containing one or more rendered incremental-database branches.
 *
 * @param {Capabilities} capabilities
 * @param {Array<IncrementalDatabaseRemoteBranch>} branches
 * @returns {Promise<void>}
 */
async function stubIncrementalDatabaseRemoteBranches(capabilities, branches) {
    const remotePath = capabilities.environment.generatorsRepository();
    if (await capabilities.checker.directoryExists(remotePath)) {
        await capabilities.deleter.deleteDirectory(remotePath);
    }

    await capabilities.git.call("init", "--bare", "--", remotePath);

    for (const branch of branches) {
        await pushRemoteBranch(capabilities, remotePath, branch);
    }
}

/**
 * Creates an empty rendered incremental-database remote for the current hostname.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function stubIncrementalDatabaseRemote(capabilities) {
    await stubIncrementalDatabaseRemoteBranches(capabilities, [
        {
            hostname: capabilities.environment.hostname(),
            fixtureName: "empty",
        },
    ]);
}

/**
 * Creates a populated rendered incremental-database remote for the current hostname.
 *
 * @param {Capabilities} capabilities
 * @returns {Promise<void>}
 */
async function stubPopulatedIncrementalDatabaseRemote(capabilities) {
    await stubIncrementalDatabaseRemoteBranches(capabilities, [
        {
            hostname: capabilities.environment.hostname(),
            fixtureName: "populated",
        },
    ]);
}

module.exports = {
    stubIncrementalDatabaseRemote,
    stubPopulatedIncrementalDatabaseRemote,
    stubIncrementalDatabaseRemoteBranches,
    IncrementalDatabaseRemoteFixtureError,
    isIncrementalDatabaseRemoteFixtureError,
};