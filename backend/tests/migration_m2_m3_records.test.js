/**
 * Passes M2 and M3 of Journal-aware migration: the target proof and persistent
 * freshness records the cutover authors.
 *
 * `incremental-graph-journal-migrations.md` §16 makes M2 author the proof which
 * makes replay derive the target's validity edges, and §17 makes M3 author the
 * persistent markers which make replay derive the target's staleness. These tests
 * read the target replica's Journal after a real cutover, so they pin what the
 * migration authors rather than only what the post-migration graph happens to
 * compute. The cutover's own verification (`migration_verification.js`) compares the
 * replayed projection against the graph, so a record these tests miss is still
 * caught whenever the two disagree.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const { getRootDatabase } = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const {
    isInvalidateEvent,
    isValidateEvent,
    isValueEvent,
    nodeKeyToCanonicalString,
    semanticEventsOfReplica,
} = require("../src/generators/incremental_graph/journal");
const { numberComputedValue } = require("./computed_value_fixture");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubDatetime, stubEnvironment } = require("./stubs");

jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubEnvironment(capabilities);
    return capabilities;
}

/**
 * Every semantic event the active replica's Journal retains.
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} db
 * @returns {Promise<Array<import('../src/generators/incremental_graph/journal/records').JournalRecord>>}
 */
async function readSemanticEvents(db) {
    const retained = await readRetainedJournal(db.getSchemaStorage().journal);
    if (retained instanceof Error) {
        throw retained;
    }
    return semanticEventsOfReplica(retained);
}

describe("migration Pass M2 records", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
    });

    test("a create authors a migration certificate establishing its target proof", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async () => numberComputedValue(2), isDeterministic: true, hasSideEffects: false },
            ];
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("A");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const nk of storage.listMaterializedNodes()) {
                    await storage.keep(nk);
                }
                await storage.create(
                    '{"head":"B","args":[]}',
                    async () => numberComputedValue(2),
                    "up-to-date"
                );
            });

            const events = await readSemanticEvents(db);
            const certificate = events.find(
                (record) => isValidateEvent(record) &&
                    record.reason === "migration" &&
                    nodeKeyToCanonicalString(record.node) === '{"head":"B","args":[]}'
            );
            expect(certificate).toBeDefined();
            if (certificate === undefined || !isValidateEvent(certificate)) {
                throw new Error("the created node authors no migration certificate");
            }
            // §16.3: the basis names the selected target occurrence of every valid
            // input edge, so replay derives B's proof against the target A.
            expect(certificate.basis).toHaveLength(1);
            expect(nodeKeyToCanonicalString(certificate.basis[0].input)).toBe('{"head":"A","args":[]}');
            expect(certificate.basis[0].value).not.toBe("unknown");
        } finally {
            if (db) await db.close();
        }
    });

    test("a replacement authors a migration certificate for its new occurrence", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async () => numberComputedValue(2), isDeterministic: true, hasSideEffects: false },
            ];
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const nk of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(nk);
                    if (!key) continue;
                    if (String(key.head) === "B") {
                        await storage.replace(nk, async () => numberComputedValue(20));
                    } else {
                        await storage.keep(nk);
                    }
                }
            });

            const events = await readSemanticEvents(db);
            const value = events.find(
                (record) => isValueEvent(record) && record.reason === "migration" &&
                    nodeKeyToCanonicalString(record.node) === '{"head":"B","args":[]}'
            );
            expect(value).toBeDefined();
            if (value === undefined || !isValueEvent(value)) {
                throw new Error("the replacement authors no migration value");
            }
            const certificate = events.find(
                (record) => isValidateEvent(record) && record.reason === "migration" &&
                    nodeKeyToCanonicalString(record.node) === '{"head":"B","args":[]}'
            );
            expect(certificate).toBeDefined();
            if (certificate === undefined || !isValidateEvent(certificate)) {
                throw new Error("the replacement authors no migration certificate");
            }
            // §11a.4: a replacement establishes full positive proof against every
            // selected target input, so its certificate names A's selected occurrence.
            expect(certificate.basis).toHaveLength(1);
            expect(nodeKeyToCanonicalString(certificate.basis[0].input)).toBe('{"head":"A","args":[]}');
            expect(certificate.basis[0].value).not.toBe("unknown");
        } finally {
            if (db) await db.close();
        }
    });
});

describe("migration Pass M3 records", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
    });

    test("a kept dependent staled through an invalidated input gets a value-scoped marker", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: ["A"], computor: async () => numberComputedValue(2), isDeterministic: true, hasSideEffects: false },
            ];
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const nk of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(nk);
                    if (!key) continue;
                    if (String(key.head) === "A") {
                        await storage.invalidate(nk);
                    } else {
                        await storage.keep(nk);
                    }
                }
            });

            const events = await readSemanticEvents(db);
            // §16.1: the explicit invalidation authors a node-scoped record at A.
            const nodeInvalidation = events.find(
                (record) => isInvalidateEvent(record) && record.reason === "migration" &&
                    record.scope.kind === "node" &&
                    nodeKeyToCanonicalString(record.node) === '{"head":"A","args":[]}'
            );
            expect(nodeInvalidation).toBeDefined();
            // §17: B is target-stale only through its stale input, which is not a
            // persistent marker, so M3 authors a value-scoped record for B.
            const valueMarker = events.find(
                (record) => isInvalidateEvent(record) && record.reason === "migration" &&
                    record.scope.kind === "value" &&
                    nodeKeyToCanonicalString(record.node) === '{"head":"B","args":[]}'
            );
            expect(valueMarker).toBeDefined();
        } finally {
            if (db) await db.close();
        }
    });
});
