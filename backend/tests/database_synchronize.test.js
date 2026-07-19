const path = require("path");
const {
    synchronizeNoLock,
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
        await seedRemoteRepository(capabilities, [["!_meta!current_replica", "z"]]);

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
        const remoteNodeId = '1-testfingerprnt';
        const remoteSemanticKey = '{"head":"event","args":["remote"]}';
        const remoteKey = `!x!!values!${remoteNodeId}`;
        await seedRemoteRepository(capabilities, [
                        [remoteKey, { source: "remote" }],
            [`!x!!freshness!${remoteNodeId}`, "potentially-outdated"],
            [`!x!!timestamps!${remoteNodeId}`, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" }],
            ["!x!!global!version", "remote-version"],
            ["!x!!global!graph_scheme", JSON.stringify({ format: 1, nodes: [{ head: "event", arity: 1, inputTemplates: [] }] })],
            ["!x!!global!identifiers_keys_map", [[remoteNodeId, remoteSemanticKey]]],
            ["!x!!global!last_node_index", 0],
            ["!x!!global!fingerprint", "testfingerprnt"],
        ]);

        const db = await getRootDatabase(capabilities);
        const capturedFingerprint = db.getFingerprint();
        try {
            await db._rawPut('!x!!values!{"head":"event","args":["local-only"]}', { source: "local" });
        } finally {
            await db.close();
        }

        await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });

        const reopened = await getRootDatabase(capabilities);
        try {
            const entries = await collectRawEntries(reopened);
            const activeReplica = reopened.currentReplicaName();
            const activeRemoteKey = remoteKey.replace('!x!!', `!${activeReplica}!!`);
            expect(entries.get(activeRemoteKey)).toEqual({ source: "remote" });
            expect(entries.get(`!${activeReplica}!!global!version`)).toBe("remote-version");
            const reopenedFingerprint = reopened.getFingerprint();
            expect(reopenedFingerprint).not.toBe("testfingerprnt");
            expect(reopenedFingerprint).toBe(capturedFingerprint);
        } finally {
            await reopened.close();
        }
    });

    test("can synchronize twice even though the persistent rendered repository work tree is stale between runs", async () => {
        const capabilities = getTestCapabilities();
        await seedRemoteRepository(capabilities, [["!_meta!current_replica", "x"]]);

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

    async function writeLocalGraphScheme(capabilities) {
        const db = await getRootDatabase(capabilities);
        try {
            const scheme = { format: 1, nodes: [{ head: "event", arity: 1, inputTemplates: [] }] };
            await db._rawPut('!x!!global!graph_scheme', JSON.stringify(scheme));
        } finally {
            await db.close();
        }
    }

    test("merges rendered data from other hostname branches into the live database", async () => {
        const capabilities = getTestCapabilities();
        const aliceNodeArgs = '{"head":"event","args":["alice"]}';
        const aliceNodeIdentifier = 'aliceaaaa';
        const aliceTimestampsKey = `!x!!timestamps!${aliceNodeIdentifier}`;
        const aliceGraphScheme = JSON.stringify({ format: 1, nodes: [{ head: "event", arity: 1, inputTemplates: [] }] });
        await writeLocalGraphScheme(capabilities);
        await stubIncrementalDatabaseRemoteBranches(capabilities, [
            {
                hostname: "test-host",
                entries: [
                    ["!_meta!current_replica", "x"],
                    ["!x!!global!identifiers_keys_map", []],
                    ["!x!!global!graph_scheme", aliceGraphScheme],
                ],
            },
            {
                hostname: "alice",
                entries: [
                    [`!x!!values!${aliceNodeIdentifier}`, { source: "alice" }],
                    [aliceTimestampsKey, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" }],
                    [`!x!!freshness!${aliceNodeIdentifier}`, "up-to-date"],
                    ["!x!!global!identifiers_keys_map", [[aliceNodeIdentifier, aliceNodeArgs]]],
                    ["!x!!global!graph_scheme", aliceGraphScheme],
                ],
            },
        ]);

        await synchronizeNoLock(capabilities);

        const reopened = await getRootDatabase(capabilities);
        try {
            // After merge the active replica pointer may have moved to "y";
            // look for the value in whichever replica is currently active.
            const replica = reopened.currentReplicaName();
            const activeAliceKey = `!${replica}!!values!${aliceNodeIdentifier}`;
            const entries = await collectRawEntries(reopened);
            expect(entries.get(activeAliceKey)).toEqual({ source: "alice" });
        } finally {
            await reopened.close();
        }
    });

    test("on partial host-merge failures, merges successful hosts before rethrowing", async () => {
        const capabilities = getTestCapabilities();
        const bobNodeArgs = '{"head":"event","args":["bob"]}';
        const bobNodeIdentifier = 'bobbbbbbb';
        const bobTimestampsKey = `!x!!timestamps!${bobNodeIdentifier}`;
        const graphSchemeJson = JSON.stringify({ format: 1, nodes: [{ head: "event", arity: 1, inputTemplates: [] }] });
        await writeLocalGraphScheme(capabilities);
        await stubIncrementalDatabaseRemoteBranches(capabilities, [
            {
                hostname: "test-host",
                entries: [
                    ["!_meta!current_replica", "x"],
                    ["!x!!global!identifiers_keys_map", []],
                    ["!x!!global!graph_scheme", graphSchemeJson],
                ],
            },
            {
                hostname: "bob",
                entries: [
                    [`!x!!values!${bobNodeIdentifier}`, { source: "bob" }],
                    [bobTimestampsKey, { createdAt: "2024-01-01T00:00:00.000Z", modifiedAt: "2024-01-01T00:00:00.000Z" }],
                    [`!x!!freshness!${bobNodeIdentifier}`, "up-to-date"],
                    ["!x!!global!identifiers_keys_map", [[bobNodeIdentifier, bobNodeArgs]]],
                    ["!x!!global!graph_scheme", graphSchemeJson],
                ],
            },
            {
                hostname: "zed",
                entries: [
                    ['!x!!global!version', "incompatible-version"],
                    ['!x!!values!{"head":"event","args":["zed"]}', { source: "zed" }],
                    ['!x!!global!identifiers_keys_map', [['z-abcdefghi', '{"head":"event","args":["zed"]}']]],
                    ['!x!!global!graph_scheme', graphSchemeJson],
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
            const activeBobKey = `!${replica}!!values!${bobNodeIdentifier}`;
            const entries = await collectRawEntries(reopened);
            expect(entries.get(activeBobKey)).toEqual({ source: "bob" });
        } finally {
            await reopened.close();
        }
    });

    test("reports host snapshot merge failure with explicit hostname", async () => {
        const capabilities = getTestCapabilities();

        await stubIncrementalDatabaseRemoteBranches(capabilities, [
            {
                hostname: "test-host",
                entries: [["!_meta!current_replica", "x"]],
            },
            {
                hostname: "prismo",
                entries: [],
            },
        ]);

        let error;
        try {
            await synchronizeNoLock(capabilities);
        } catch (caught) {
            error = caught;
        }

        expect(isSyncMergeAggregateError(error)).toBe(true);
        expect(error.message).toContain("prismo");
        expect(error.message).toContain("input directory does not exist");
    });

    test("resetToHostname succeeds even when snapshot omits _meta/current_replica", async () => {
        const capabilities = getTestCapabilities();
        const snapshotNodeId = '1-snapshotfp';
        const snapshotSemanticKey = '{"head":"event","args":["reset"]}';
        const snapshotKey = `!x!!values!${snapshotNodeId}`;
        await seedHostnameBranchWithRenderedFiles(capabilities, [
            { path: renderedKeyPath(snapshotKey), content: JSON.stringify("after-reset") },
            { path: renderedKeyPath(`!x!!freshness!${snapshotNodeId}`), content: JSON.stringify('potentially-outdated') },
            { path: renderedKeyPath(`!x!!timestamps!${snapshotNodeId}`), content: JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' }) },
            { path: 'r/global/version', content: JSON.stringify('snapshot-version') },
            { path: 'r/global/graph_scheme', content: JSON.stringify(JSON.stringify({ format: 1, nodes: [{ head: 'event', arity: 1, inputTemplates: [] }] })) },
            { path: 'r/global/identifiers_keys_map', content: JSON.stringify([[snapshotNodeId, snapshotSemanticKey]]) },
            { path: 'r/global/last_node_index', content: JSON.stringify(0) },
            { path: 'r/global/fingerprint', content: JSON.stringify('snapshotfingerprint') },
        ]);
        await expect(
            synchronizeNoLock(capabilities, { resetToHostname: "test-host" })
        ).resolves.toBeUndefined();
    });

    test("reset preserves local fingerprint when database exists", async () => {
        const capabilities = getTestCapabilities();
        const snapshotNodeId = '1-snapshotfp';
        const snapshotSemanticKey = '{"head":"event","args":["reset"]}';
        const snapshotKey = `!x!!values!${snapshotNodeId}`;
        await seedHostnameBranchWithRenderedFiles(capabilities, [
            { path: renderedKeyPath(snapshotKey), content: JSON.stringify("after-reset") },
            { path: renderedKeyPath(`!x!!freshness!${snapshotNodeId}`), content: JSON.stringify('potentially-outdated') },
            { path: renderedKeyPath(`!x!!timestamps!${snapshotNodeId}`), content: JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' }) },
            { path: 'r/global/version', content: JSON.stringify('snapshot-version') },
            { path: 'r/global/graph_scheme', content: JSON.stringify(JSON.stringify({ format: 1, nodes: [{ head: 'event', arity: 1, inputTemplates: [] }] })) },
            { path: 'r/global/identifiers_keys_map', content: JSON.stringify([[snapshotNodeId, snapshotSemanticKey]]) },
            { path: 'r/global/last_node_index', content: JSON.stringify(0) },
            { path: 'r/global/fingerprint', content: JSON.stringify('snapshotfingerprint') },
        ]);

        const db = await getRootDatabase(capabilities);
        const localFingerprint = db.getFingerprint();
        await db.close();

        await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });

        const reopened = await getRootDatabase(capabilities);
        try {
            expect(reopened.getFingerprint()).toBe(localFingerprint);
        } finally {
            await reopened.close();
        }
    });
});

    
