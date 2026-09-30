/**
 * Pass M1 of Journal-aware migration: the records the migration cutover authors.
 *
 * `incremental-graph-journal-migrations.md` §15 makes M1 about two things only:
 * a genuine create or replace authors a `ValueEvent(reason="migration")`, and a key
 * which was present in the converted source and is absent from the target authors one
 * `DeleteEvent(reason="migration")`. An occurrence-preserving decision authors no
 * value record at all, because the transported occurrence keeps the `ValueId` the
 * converted history already gave it.
 *
 * These tests read the target replica's Journal after a real cutover and assert on the
 * records it carries, so they pin what the migration authors rather than only what the
 * post-migration graph happens to compute.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    getRootDatabase,
} = require("../src/generators/incremental_graph/database");
const { createIncrementalGraph } = require("../src/generators/incremental_graph");
const { readCurrentOccurrence, readRetainedJournal } = require("../src/generators/incremental_graph/journal_store");
const {
    isDeleteEvent,
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
 * Every semantic event the active replica's Journal retains, in writer-stream order.
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

describe("migration Pass M1 records", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
    });

    test("a genuine create authors a migration ValueEvent, and keep authors none", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: [], computor: async () => numberComputedValue(2), isDeterministic: true, hasSideEffects: false },
            ];
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("A");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(identifier);
                    if (key && String(key.head) === "A") {
                        await storage.keep(identifier);
                    }
                }
                await storage.create(
                    '{"head":"B","args":[]}',
                    async () => numberComputedValue(20),
                    "up-to-date"
                );
            });

            const events = await readSemanticEvents(db);
            const migrationValues = events.filter(
                (record) => isValueEvent(record) && record.reason === "migration"
            );
            const createdValues = migrationValues.filter(
                (record) => nodeKeyToCanonicalString(record.node) === '{"head":"B","args":[]}'
            );
            // Exactly one ValueEvent for the created key: the created occurrence.
            expect(createdValues).toHaveLength(1);
            expect(createdValues[0].nodeIdentifier).toBeDefined();
            // The kept key's occurrence came through the converted history, so the
            // migration itself authored no value record for it.
            const keptValues = migrationValues.filter(
                (record) => nodeKeyToCanonicalString(record.node) === '{"head":"A","args":[]}'
            );
            expect(keptValues).toHaveLength(0);
        } finally {
            if (db) await db.close();
        }
    });

    test("a delete authors a migration DeleteEvent and clears the node's occurrence", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: [], computor: async () => numberComputedValue(2), isDeterministic: true, hasSideEffects: false },
            ];
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(identifier);
                    if (key && String(key.head) === "A") {
                        await storage.keep(identifier);
                    } else if (key && String(key.head) === "B") {
                        await storage.delete(identifier);
                    }
                }
            });

            const events = await readSemanticEvents(db);
            const migrationDeletes = events.filter(
                (record) => isDeleteEvent(record) && record.reason === "migration"
            );
            expect(migrationDeletes).toHaveLength(1);
            expect(nodeKeyToCanonicalString(migrationDeletes[0].node)).toBe('{"head":"B","args":[]}');

            // The DeleteEvent is semantic absence authority, so the target's current
            // occurrence index no longer resolves the deleted key.
            const { deserializeNodeKey } = require("../src/generators/incremental_graph/database");
            const occurrence = await readCurrentOccurrence(
                db.getSchemaStorage().journal,
                deserializeNodeKey('{"head":"B","args":[]}')
            );
            expect(occurrence).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });
});
