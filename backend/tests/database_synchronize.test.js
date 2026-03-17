const path = require("path");
const {
    synchronizeNoLock,
    getRootDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");
const defaultBranch = require("../src/gitstore/default_branch");
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
 * @param {object} capabilities
 * @param {Array<[string, *]>} entries
 * @returns {Promise<void>}
 */
async function seedRemoteRepository(capabilities, entries) {
    await capabilities.git.call(
        "init",
        "--bare",
        "--",
        capabilities.environment.generatorsRepository()
    );
    await pushRemoteRepositoryBranch(
        capabilities,
        capabilities.environment.hostname(),
        entries
    );
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

describe("synchronizeNoLock", () => {
    test("renders the live database into the tracked repository and pushes it to remote", async () => {
        const capabilities = getTestCapabilities();
        const branch = defaultBranch(capabilities);
        await seedRemoteRepository(capabilities, [["!_meta!format", "xy-v1"]]);

        const db = await getRootDatabase(capabilities);
        const eventKey = '!x!!values!{"head":"event","args":["local"]}';
        try {
            await db._rawPut(eventKey, { source: "local" });
        } finally {
            await db.close();
        }

        await synchronizeNoLock(capabilities);

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(eventKey)).toEqual({ source: "local" });
        } finally {
            await reopened.close();
        }

        const clonedRemote = await capabilities.creator.createTemporaryDirectory(capabilities);
        try {
            await capabilities.git.call(
                "clone",
                `--branch=${branch}`,
                capabilities.environment.generatorsRepository(),
                clonedRemote
            );
            const renderedFile = path.join(
                clonedRemote,
                DATABASE_SUBPATH,
                ...keyToRelativePath(eventKey).split("/")
            );
            expect(await capabilities.reader.readFileAsText(renderedFile)).toBe(
                JSON.stringify({ source: "local" }, null, 2)
            );
            expect(
                await capabilities.checker.directoryExists(
                    path.join(
                        capabilities.environment.workingDirectory(),
                        CHECKPOINT_WORKING_PATH,
                        DATABASE_SUBPATH
                    )
                )
            ).toBeTruthy();
            expect(
                await capabilities.checker.directoryExists(
                    path.join(
                        capabilities.environment.workingDirectory(),
                        LIVE_DATABASE_WORKING_PATH
                    )
                )
            ).toBeTruthy();
        } finally {
            await capabilities.deleter.deleteDirectory(clonedRemote);
        }
    });

    test("scans the synchronized rendered repository back into the live database", async () => {
        const capabilities = getTestCapabilities();
        const remoteKey = '!x!!values!{"head":"event","args":["remote"]}';
        await seedRemoteRepository(capabilities, [
            ["!_meta!format", "xy-v1"],
            [remoteKey, { source: "remote" }],
            ["!x!!meta!version", "remote-version"],
        ]);

        const db = await getRootDatabase(capabilities);
        try {
            await db._rawPut('!x!!values!{"head":"event","args":["local-only"]}', { source: "local" });
        } finally {
            await db.close();
        }

        await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(remoteKey)).toEqual({ source: "remote" });
            expect(entries.get("!x!!meta!version")).toBe("remote-version");
            expect(entries.has('!x!!values!{"head":"event","args":["local-only"]}')).toBe(false);
        } finally {
            await reopened.close();
        }
    });

    test("can synchronize twice even though the persistent rendered repository work tree is stale between runs", async () => {
        const capabilities = getTestCapabilities();
        await seedRemoteRepository(capabilities, [["!_meta!format", "xy-v1"]]);

        const firstKey = '!x!!values!{"head":"event","args":["first"]}';
        const secondKey = '!x!!values!{"head":"event","args":["second"]}';

        const firstDb = await getRootDatabase(capabilities);
        try {
            await firstDb._rawPut(firstKey, { source: "first-sync" });
        } finally {
            await firstDb.close();
        }

        await synchronizeNoLock(capabilities);

        const secondDb = await getRootDatabase(capabilities);
        try {
            await secondDb._rawPut(secondKey, { source: "second-sync" });
        } finally {
            await secondDb.close();
        }

        await expect(synchronizeNoLock(capabilities)).resolves.toBeUndefined();

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(firstKey)).toEqual({ source: "first-sync" });
            expect(entries.get(secondKey)).toEqual({ source: "second-sync" });
        } finally {
            await reopened.close();
        }
    });

    test("merges rendered data from other hostname branches into the live database", async () => {
        const capabilities = getTestCapabilities();
        const aliceKey = '!x!!values!{"head":"event","args":["alice"]}';
        await capabilities.git.call(
            "init",
            "--bare",
            "--",
            capabilities.environment.generatorsRepository()
        );
        await pushRemoteRepositoryBranch(capabilities, "test-host", [["!_meta!format", "xy-v1"]]);
        await pushRemoteRepositoryBranch(capabilities, "alice", [
            ["!_meta!format", "xy-v1"],
            [aliceKey, { source: "alice" }],
        ]);

        await synchronizeNoLock(capabilities);

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(aliceKey)).toEqual({ source: "alice" });
        } finally {
            await reopened.close();
        }
    });

    test("on partial host-merge failures, scans back successful merges before rethrowing", async () => {
        const capabilities = getTestCapabilities();
        const bobKey = '!x!!values!{"head":"event","args":["bob"]}';

        await capabilities.git.call(
            "init",
            "--bare",
            "--",
            capabilities.environment.generatorsRepository()
        );
        await pushRemoteRepositoryBranch(capabilities, "test-host", [
            ["!_meta!format", "xy-v1"],
        ]);
        await pushRemoteRepositoryBranch(capabilities, "bob", [
            ["!_meta!format", "xy-v1"],
            [bobKey, { source: "bob" }],
        ]);
        await pushRemoteRepositoryBranch(capabilities, "zed", [
            ["!_meta!format", "xy-v1"],
            ['!x!!values!{"head":"event","args":["zed"]}', { source: "zed" }],
        ]);

        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            if (
                args.includes("merge") &&
                args.includes("origin/zed-main")
            ) {
                throw new Error("Simulated zed merge failure");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        await expect(synchronizeNoLock(capabilities)).rejects.toThrow(
            "Failed to merge generators database branches:\n- zed:"
        );

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            expect(entries.get(bobKey)).toEqual({ source: "bob" });
        } finally {
            await reopened.close();
        }
    });
});
