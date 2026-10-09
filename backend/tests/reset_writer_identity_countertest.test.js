const path = require("path");
const {
    synchronizeNoLock,
    getRootDatabase,
    DATABASE_SUBPATH,
    keyToRelativePath,
} = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubDatetime, stubLogger } = require("./stubs");
jest.setTimeout(30000);

const SNAPSHOT_FINGERPRINT = "snapshotwriteridentity";
const SNAPSHOT_NODE_ID = "1-snapshotwriteridentity";
const SNAPSHOT_SEMANTIC_KEY = '{"head":"event","args":["countertest"]}';

/**
 * @returns {object}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

/**
 * @param {string} key
 * @returns {string}
 */
function renderedKeyPath(key) {
    return keyToRelativePath(key).replace(/^[xy]\//, 'r/');
}

/**
 * Seeds the remote branch with a fully initialized rendered snapshot whose
 * replica fingerprint is SNAPSHOT_FINGERPRINT.
 * @param {object} capabilities
 * @returns {Promise<void>}
 */
async function seedInitializedSnapshot(capabilities) {
    const branch = `${capabilities.environment.hostname()}-main`;
    const remotePath = capabilities.environment.generatorsRepository();
    const workTree = await capabilities.creator.createTemporaryDirectory();
    const files = [
        { path: renderedKeyPath(`!x!!values!${SNAPSHOT_NODE_ID}`), content: JSON.stringify("from-snapshot") },
        { path: renderedKeyPath(`!x!!freshness!${SNAPSHOT_NODE_ID}`), content: JSON.stringify('potentially-outdated') },
        { path: renderedKeyPath(`!x!!timestamps!${SNAPSHOT_NODE_ID}`), content: JSON.stringify({ createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-01T00:00:00.000Z' }) },
        { path: 'r/global/version', content: JSON.stringify('snapshot-version') },
        { path: 'r/global/graph_scheme', content: JSON.stringify(JSON.stringify({ format: 1, nodes: [{ head: 'event', arity: 1, inputTemplates: [] }] })) },
        { path: 'r/global/identifiers_keys_map', content: JSON.stringify([[SNAPSHOT_NODE_ID, SNAPSHOT_SEMANTIC_KEY]]) },
        { path: 'r/global/last_node_index', content: JSON.stringify(0) },
        { path: 'r/global/fingerprint', content: JSON.stringify(SNAPSHOT_FINGERPRINT) },
    ];
    try {
        await capabilities.git.call("init", "--bare", "--", remotePath);
        await capabilities.git.call("init", "--initial-branch", branch, "--", workTree);
        for (const file of files) {
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

describe("reset writer identity counter-test", () => {
    test("an existing receiver keeps its own DatabaseFingerprint and only its own", async () => {
        const capabilities = getTestCapabilities();
        await seedInitializedSnapshot(capabilities);

        const db = await getRootDatabase(capabilities);
        const localFingerprint = db.getFingerprint();
        await db._rawPut(`!${db.currentReplicaName()}!!values!1-localnode`, { source: 'local' });
        await db.close();

        await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });

        const reopened = await getRootDatabase(capabilities);
        try {
            expect(reopened.getFingerprint()).toBe(localFingerprint);
            expect(reopened.getFingerprint()).not.toBe(SNAPSHOT_FINGERPRINT);
        } finally {
            await reopened.close();
        }
    });

    test("a completely absent receiver adopts the snapshot DatabaseFingerprint", async () => {
        const capabilities = getTestCapabilities();
        await seedInitializedSnapshot(capabilities);

        await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });

        const reopened = await getRootDatabase(capabilities);
        try {
            expect(reopened.getFingerprint()).toBe(SNAPSHOT_FINGERPRINT);
        } finally {
            await reopened.close();
        }
    });

    test("the retained receiver fingerprint is what the activated replica stores", async () => {
        const capabilities = getTestCapabilities();
        await seedInitializedSnapshot(capabilities);

        const db = await getRootDatabase(capabilities);
        const localFingerprint = db.getFingerprint();
        await db.close();

        await synchronizeNoLock(capabilities, { resetToHostname: "test-host" });

        const reopened = await getRootDatabase(capabilities);
        try {
            const active = reopened.currentReplicaName();
            const stored = await reopened.replicaGlobalSublevel(active).get("fingerprint");
            expect(stored).toBe(localFingerprint);
        } finally {
            await reopened.close();
        }
    });
});