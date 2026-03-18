const path = require("path");
const {
    synchronizeNoLock,
    getRootDatabase,
    DATABASE_SUBPATH,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

/**
 * @param {object} capabilities
 * @param {string} hostname
 * @param {Array<[string, *]>} entries
 * @returns {Promise<void>}
 */
async function pushRemoteRepositoryBranch(capabilities, hostname, entries) {
    const branch = `${hostname}-main`;
    const remotePath = capabilities.environment.generatorsRepository();
    const workTree = await capabilities.creator.createTemporaryDirectory(capabilities);
    try {
        await capabilities.git.call(
            "init",
            "--initial-branch",
            branch,
            "--",
            workTree
        );
        for (const [key, value] of entries) {
            const filePath = path.join(
                workTree,
                DATABASE_SUBPATH,
                ...keyToRelativePath(key).split("/")
            );
            const file = await capabilities.creator.createFile(filePath);
            await capabilities.writer.writeFile(file, JSON.stringify(value));
        }
        await capabilities.git.call("-C", workTree, "add", "--all");
        await capabilities.git.call(
            "-C",
            workTree,
            "-c",
            "user.name=volodyslav",
            "-c",
            "user.email=volodyslav",
            "commit",
            "-m",
            "Initial rendered snapshot"
        );
        await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
        await capabilities.git.call("-C", workTree, "push", "origin", branch);
    } finally {
        await capabilities.deleter.deleteDirectory(workTree);
    }
}

/**
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} db
 * @returns {Promise<Map<string, *>>}
 */
async function collectRawEntries(db) {
    const entries = new Map();
    for await (const [key, value] of db._rawEntries()) {
        entries.set(key, value);
    }
    return entries;
}

describe("synchronizeNoLock reset-to-host merge failures", () => {
    test("does not fail reset-to-host when merge failure happens and local repository already exists", async () => {
        const capabilities = getTestCapabilities();
        const bobKey = '!x!!values!{"head":"event","args":["bob"]}';
        const sharedKey = '!x!!values!{"head":"event","args":["shared"]}';

        await capabilities.git.call(
            "init",
            "--bare",
            "--",
            capabilities.environment.generatorsRepository()
        );
        await pushRemoteRepositoryBranch(capabilities, "test-host", [
            ["!_meta!format", "xy-v1"],
            [sharedKey, { source: "test-host" }],
        ]);
        await synchronizeNoLock(capabilities);
        await pushRemoteRepositoryBranch(capabilities, "bob", [
            ["!_meta!format", "xy-v1"],
            [sharedKey, { source: "test-host" }],
            [bobKey, { source: "bob" }],
        ]);
        await pushRemoteRepositoryBranch(capabilities, "gunter", [
            ["!_meta!format", "xy-v1"],
            [sharedKey, { source: "gunter" }],
        ]);

        await expect(
            synchronizeNoLock(capabilities, { resetToHostname: "test-host" })
        ).resolves.toBeUndefined();
        expect(capabilities.logger.logWarning).toHaveBeenCalledTimes(1);
        const warningEntry = capabilities.logger.logWarning.mock.calls[0][0];
        expect(warningEntry.error.failures).toHaveLength(1);
        expect(warningEntry.error.failures[0].hostname).toBe("gunter");

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(bobKey)).toEqual({ source: "bob" });
        } finally {
            await reopened.close();
        }
    });

    test("does not fail reset-to-host when merge failure happens and local repository does not exist yet", async () => {
        const capabilities = getTestCapabilities();
        const bobKey = '!x!!values!{"head":"event","args":["bob"]}';
        const sharedKey = '!x!!values!{"head":"event","args":["shared"]}';

        await capabilities.git.call(
            "init",
            "--bare",
            "--",
            capabilities.environment.generatorsRepository()
        );
        await pushRemoteRepositoryBranch(capabilities, "test-host", [
            ["!_meta!format", "xy-v1"],
            [sharedKey, { source: "test-host" }],
        ]);
        await pushRemoteRepositoryBranch(capabilities, "bob", [
            ["!_meta!format", "xy-v1"],
            [sharedKey, { source: "test-host" }],
            [bobKey, { source: "bob" }],
        ]);
        await pushRemoteRepositoryBranch(capabilities, "gunter", [
            ["!_meta!format", "xy-v1"],
            [sharedKey, { source: "gunter" }],
        ]);

        await expect(
            synchronizeNoLock(capabilities, { resetToHostname: "test-host" })
        ).resolves.toBeUndefined();
        expect(capabilities.logger.logWarning).toHaveBeenCalledTimes(1);
        const warningEntry = capabilities.logger.logWarning.mock.calls[0][0];
        expect(warningEntry.error.failures).toHaveLength(1);
        expect(warningEntry.error.failures[0].hostname).toBe("gunter");

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(bobKey)).toEqual({ source: "bob" });
        } finally {
            await reopened.close();
        }
    });
});
