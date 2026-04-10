const path = require("path");
const {
    synchronizeNoLock,
    isInvalidSnapshotFormatError,
    isInvalidSnapshotReplicaError,
    isSyncMergeAggregateError,
    getRootDatabase,
    CHECKPOINT_WORKING_PATH,
    DATABASE_SUBPATH,
    LIVE_DATABASE_WORKING_PATH,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");
const defaultBranch = require("../src/gitstore/default_branch");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");
const { stubIncrementalDatabaseRemoteBranches } = require("./stub_incremental_database_remote");
jest.setTimeout(30000);


function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

/**
 * Maps a raw LevelDB key's filesystem path to the rendered path used in snapshots.
 * Active replica (x or y) entries are stored under the `r/` alias.
 * `_meta` entries remain under `_meta/`.
 * @param {string} key
 * @returns {string}
 */
function renderedKeyPath(key) {
    return keyToRelativePath(key).replace(/^[xy]\//, 'r/');
}

/**
 * @param {object} capabilities
 * @param {Array<[string, *]>} entries
 * @returns {Promise<void>}
 */
async function seedRemoteRepository(capabilities, entries) {
    await stubIncrementalDatabaseRemoteBranches(capabilities, [
        {
            hostname: capabilities.environment.hostname(),
            entries,
        },
    ]);
}

/**
 * @param {object} capabilities
 * @param {Array<{ path: string, content: string }>} renderedFiles
 * @returns {Promise<void>}
 */
async function seedHostnameBranchWithRenderedFiles(capabilities, renderedFiles) {
    const branch = `${capabilities.environment.hostname()}-main`;
    const remotePath = capabilities.environment.generatorsRepository();
    const workTree = await capabilities.creator.createTemporaryDirectory();
    try {
        await capabilities.git.call("init", "--bare", "--", remotePath);
        await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);
        for (const file of renderedFiles) {
            const created = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, file.path)
            );
            await capabilities.writer.writeFile(created, file.content);
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
            "seed rendered snapshot"
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

        const clonedRemote = await capabilities.creator.createTemporaryDirectory();
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
                ...renderedKeyPath(eventKey).split("/")
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
            ["!_meta!format", "xy-v2"],
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
        await seedRemoteRepository(capabilities, [["!_meta!format", "xy-v2"]]);

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
        const aliceNodeArgs = '{"head":"event","args":["alice"]}';
        const aliceInputsKey = `!x!!inputs!${aliceNodeArgs}`;
        const aliceTimestampsKey = `!x!!timestamps!${aliceNodeArgs}`;
        await stubIncrementalDatabaseRemoteBranches(capabilities, [
            {
                hostname: "test-host",
                entries: [["!_meta!format", "xy-v2"]],
            },
            {
                hostname: "alice",
                entries: [
                    ["!_meta!format", "xy-v2"],
                    [`!x!!values!${aliceNodeArgs}`, { source: "alice" }],
                    [aliceInputsKey, { inputs: [], inputCounters: [] }],
                    [aliceTimestampsKey, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" }],
                ],
            },
        ]);

        await synchronizeNoLock(capabilities);

        const reopened = await getRootDatabase(capabilities);
        try {
            // After merge the active replica pointer may have moved to "y";
            // look for the value in whichever replica is currently active.
            const replica = reopened.currentReplicaName();
            const activeAliceKey = `!${replica}!!values!${aliceNodeArgs}`;
            const entries = await collectRawEntries(reopened);
            expect(entries.get(activeAliceKey)).toEqual({ source: "alice" });
        } finally {
            await reopened.close();
        }
    });

    test("on partial host-merge failures, merges successful hosts before rethrowing", async () => {
        const capabilities = getTestCapabilities();
        const bobNodeArgs = '{"head":"event","args":["bob"]}';
        const bobInputsKey = `!x!!inputs!${bobNodeArgs}`;
        const bobTimestampsKey = `!x!!timestamps!${bobNodeArgs}`;

        await stubIncrementalDatabaseRemoteBranches(capabilities, [
            {
                hostname: "test-host",
                entries: [["!_meta!format", "xy-v2"]],
            },
            {
                hostname: "bob",
                entries: [
                    ["!_meta!format", "xy-v2"],
                    [`!x!!values!${bobNodeArgs}`, { source: "bob" }],
                    [bobInputsKey, { inputs: [], inputCounters: [] }],
                    [bobTimestampsKey, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" }],
                ],
            },
            {
                hostname: "zed",
                entries: [
                    ["!_meta!format", "xy-v2"],
                    ['!x!!meta!version', "incompatible-version"],
                    ['!x!!values!{"head":"event","args":["zed"]}', { source: "zed" }],
                    ['!x!!inputs!{"head":"event","args":["zed"]}', { inputs: [], inputCounters: [] }],
                ],
            },
        ]);

        let error;
        try {
            await synchronizeNoLock(capabilities);
        } catch (caught) {
            error = caught;
        }

        expect(isSyncMergeAggregateError(error)).toBe(true);
        expect(error.message).toMatch("Failed to merge generators database branches:\n- zed:");

        const reopened = await getRootDatabase(capabilities);
        try {
            // After merge the active replica pointer may have moved to "y";
            // look for bob's value in whichever replica is currently active.
            const replica = reopened.currentReplicaName();
            const activeBobKey = `!${replica}!!values!${bobNodeArgs}`;
            const entries = await collectRawEntries(reopened);
            expect(entries.get(activeBobKey)).toEqual({ source: "bob" });
        } finally {
            await reopened.close();
        }
    });

    test("throws InvalidSnapshotFormatError when snapshot has incompatible _meta/format", async () => {
        const capabilities = getTestCapabilities();
        const branch = `${capabilities.environment.hostname()}-main`;
        const remotePath = capabilities.environment.generatorsRepository();
        const workTree = await capabilities.creator.createTemporaryDirectory();
        try {
            await capabilities.git.call("init", "--bare", "--", remotePath);
            await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);

            const formatFile = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, "_meta", "format")
            );
            await capabilities.writer.writeFile(formatFile, JSON.stringify("xy-v1"));

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
                "seed snapshot without current_replica"
            );
            await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
            await capabilities.git.call("-C", workTree, "push", "origin", branch);

            let error;
            try {
                await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
            } catch (caught) {
                error = caught;
            }
            expect(isInvalidSnapshotFormatError(error)).toBe(true);
        } finally {
            await capabilities.deleter.deleteDirectory(workTree);
        }
    });

    test("throws InvalidSnapshotFormatError before checking _meta/current_replica when format is incompatible", async () => {
        const capabilities = getTestCapabilities();
        const branch = `${capabilities.environment.hostname()}-main`;
        const remotePath = capabilities.environment.generatorsRepository();
        const workTree = await capabilities.creator.createTemporaryDirectory();
        try {
            await capabilities.git.call("init", "--bare", "--", remotePath);
            await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);

            const formatFile = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, "_meta", "format")
            );
            await capabilities.writer.writeFile(formatFile, JSON.stringify("xy-v1"));

            const currentReplicaFile = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, "_meta", "current_replica")
            );
            await capabilities.writer.writeFile(currentReplicaFile, "not-json");

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
                "seed invalid current_replica"
            );
            await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
            await capabilities.git.call("-C", workTree, "push", "origin", branch);

            let error;
            try {
                await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
            } catch (caught) {
                error = caught;
            }
            expect(isInvalidSnapshotFormatError(error)).toBe(true);
            expect(isInvalidSnapshotReplicaError(error)).toBe(false);
        } finally {
            await capabilities.deleter.deleteDirectory(workTree);
        }
    });

    test("throws InvalidSnapshotReplicaError with unquoted undefined when _meta/current_replica is missing", async () => {
        const capabilities = getTestCapabilities();
        const branch = `${capabilities.environment.hostname()}-main`;
        const remotePath = capabilities.environment.generatorsRepository();
        const workTree = await capabilities.creator.createTemporaryDirectory();
        try {
            await capabilities.git.call("init", "--bare", "--", remotePath);
            await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);

            const formatFile = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, "_meta", "format")
            );
            await capabilities.writer.writeFile(formatFile, JSON.stringify("xy-v2"));

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
                "seed snapshot without current_replica"
            );
            await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
            await capabilities.git.call("-C", workTree, "push", "origin", branch);

            let error;
            try {
                await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
            } catch (caught) {
                error = caught;
            }
            expect(isInvalidSnapshotReplicaError(error)).toBe(true);
            expect(error.message).toContain('invalid value: undefined');
            expect(error.message).not.toContain('"undefined"');
        } finally {
            await capabilities.deleter.deleteDirectory(workTree);
        }
    });

    test("repeat reset bootstrap failures remain deterministic and do not create live database", async () => {
        const capabilities = getTestCapabilities();
        const branch = `${capabilities.environment.hostname()}-main`;
        const remotePath = capabilities.environment.generatorsRepository();
        const liveDbPath = path.join(
            capabilities.environment.workingDirectory(),
            LIVE_DATABASE_WORKING_PATH
        );
        const workTree = await capabilities.creator.createTemporaryDirectory();
        try {
            await capabilities.git.call("init", "--bare", "--", remotePath);
            await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);

            const formatFile = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, "_meta", "format")
            );
            await capabilities.writer.writeFile(formatFile, JSON.stringify("xy-v1"));
            const currentReplicaFile = await capabilities.creator.createFile(
                path.join(workTree, DATABASE_SUBPATH, "_meta", "current_replica")
            );
            await capabilities.writer.writeFile(currentReplicaFile, JSON.stringify("x"));

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
                "seed old format"
            );
            await capabilities.git.call("-C", workTree, "remote", "add", "origin", "--", remotePath);
            await capabilities.git.call("-C", workTree, "push", "origin", branch);

            let firstError;
            try {
                await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
            } catch (caught) {
                firstError = caught;
            }
            expect(isInvalidSnapshotFormatError(firstError)).toBe(true);
            expect(await capabilities.checker.directoryExists(liveDbPath)).toBeNull();

            let secondError;
            try {
                await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
            } catch (caught) {
                secondError = caught;
            }
            expect(isInvalidSnapshotFormatError(secondError)).toBe(true);
            expect(secondError.message).toContain('Snapshot _meta/format has invalid value: "xy-v1".');
            expect(await capabilities.checker.directoryExists(liveDbPath)).toBeNull();
        } finally {
            await capabilities.deleter.deleteDirectory(workTree);
        }
    });

    describe("resetToHostname no-healing scenario matrix", () => {
        /**
         * @typedef {{ name: string, files: Array<{ path: string, content: string }>, expectedErrorGuard: (error: unknown) => boolean }} ResetFailureScenario
         */

        /** @type {ResetFailureScenario[]} */
        const scenarios = [
            {
                name: "missing _meta/format",
                files: [
                    { path: "_meta/current_replica", content: JSON.stringify("x") },
                ],
                expectedErrorGuard: isInvalidSnapshotFormatError,
            },
            {
                name: "invalid JSON in _meta/format",
                files: [
                    { path: "_meta/format", content: "not-json" },
                    { path: "_meta/current_replica", content: JSON.stringify("x") },
                ],
                expectedErrorGuard: isInvalidSnapshotFormatError,
            },
            {
                name: "legacy _meta/format value",
                files: [
                    { path: "_meta/format", content: JSON.stringify("xy-v1") },
                    { path: "_meta/current_replica", content: JSON.stringify("x") },
                ],
                expectedErrorGuard: isInvalidSnapshotFormatError,
            },
            {
                name: "missing _meta/current_replica",
                files: [
                    { path: "_meta/format", content: JSON.stringify("xy-v2") },
                ],
                expectedErrorGuard: isInvalidSnapshotReplicaError,
            },
            {
                name: "invalid JSON in _meta/current_replica",
                files: [
                    { path: "_meta/format", content: JSON.stringify("xy-v2") },
                    { path: "_meta/current_replica", content: "not-json" },
                ],
                expectedErrorGuard: isInvalidSnapshotReplicaError,
            },
            {
                name: "invalid _meta/current_replica value",
                files: [
                    { path: "_meta/format", content: JSON.stringify("xy-v2") },
                    { path: "_meta/current_replica", content: JSON.stringify("z") },
                ],
                expectedErrorGuard: isInvalidSnapshotReplicaError,
            },
            {
                name: "invalid JSON payload in rendered r/ subtree",
                files: [
                    { path: "_meta/format", content: JSON.stringify("xy-v2") },
                    { path: "_meta/current_replica", content: JSON.stringify("x") },
                    { path: "r/values/%7B%22head%22%3A%22event%22%2C%22args%22%3A%5B%22broken%22%5D%7D", content: "not-json" },
                ],
                expectedErrorGuard: (error) =>
                    error instanceof Error &&
                    !isInvalidSnapshotFormatError(error) &&
                    !isInvalidSnapshotReplicaError(error),
            },
            {
                name: "invalid JSON payload in rendered _meta subtree after metadata checks",
                files: [
                    { path: "_meta/format", content: JSON.stringify("xy-v2") },
                    { path: "_meta/current_replica", content: JSON.stringify("x") },
                    { path: "_meta/another_key", content: "not-json" },
                ],
                expectedErrorGuard: (error) =>
                    error instanceof Error &&
                    !isInvalidSnapshotFormatError(error) &&
                    !isInvalidSnapshotReplicaError(error),
            },
        ];

        test.each(scenarios)(
            "does not heal for scenario: $name",
            async ({ files, expectedErrorGuard }) => {
                const capabilities = getTestCapabilities();
                const liveDbPath = path.join(
                    capabilities.environment.workingDirectory(),
                    LIVE_DATABASE_WORKING_PATH
                );

                await seedHostnameBranchWithRenderedFiles(capabilities, files);

                let firstError;
                try {
                    await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
                } catch (caught) {
                    firstError = caught;
                }

                expect(expectedErrorGuard(firstError)).toBe(true);
                expect(await capabilities.checker.directoryExists(liveDbPath)).toBeNull();

                let secondError;
                try {
                    await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });
                } catch (caught) {
                    secondError = caught;
                }

                expect(expectedErrorGuard(secondError)).toBe(true);
                expect(await capabilities.checker.directoryExists(liveDbPath)).toBeNull();
            }
        );

        test("if reset swap fails while replacing an existing live DB, old DB is restored", async () => {
            const capabilities = getTestCapabilities();
            const liveDbPath = path.join(
                capabilities.environment.workingDirectory(),
                LIVE_DATABASE_WORKING_PATH
            );

            const existingDb = await getRootDatabase(capabilities);
            try {
                await existingDb._rawPut('!_meta!sticky_marker', "old-db-marker");
            } finally {
                await existingDb.close();
            }

            await seedHostnameBranchWithRenderedFiles(capabilities, [
                { path: "_meta/format", content: JSON.stringify("xy-v2") },
                { path: "_meta/current_replica", content: JSON.stringify("x") },
            ]);

            const originalMoveDirectory = capabilities.mover.moveDirectory;
            let moveCount = 0;
            capabilities.mover.moveDirectory = jest.fn(async (from, to) => {
                moveCount++;
                if (moveCount === 2) {
                    throw new Error("simulated swap failure");
                }
                await originalMoveDirectory(from, to);
            });

            await expect(
                synchronizeNoLock(capabilities, { resetToHostname: "test-host" })
            ).rejects.toThrow("simulated swap failure");

            expect(await capabilities.checker.directoryExists(liveDbPath)).not.toBeNull();

            const reopened = await getRootDatabase(capabilities);
            try {
                const entries = await collectRawEntries(reopened);
                const marker = entries.get('!_meta!sticky_marker');
                expect(marker).toBe("old-db-marker");
            } finally {
                await reopened.close();
            }
        });
    });
});
