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
    deserializeNodeKey,
    getRootDatabase,
    stringToNodeKeyString,
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
const { stubLogger, stubDatetime, stubEnvironment, getDatetimeControl } = require("./stubs");
const { fromISOString } = require("../src/datetime");

jest.mock('../src/generators/incremental_graph/database', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/database'),
    checkpointMigration: jest.fn(),
}));
const { checkpointMigration: mockCheckpointMigration } = require('../src/generators/incremental_graph/database');
jest.mock('../src/generators/incremental_graph/migration_journal', () => ({
    ...jest.requireActual('../src/generators/incremental_graph/migration_journal'),
    buildMigrationJournal: jest.fn(),
}));
const { buildMigrationJournal } = require('../src/generators/incremental_graph/migration_journal');

/**
 * Let the cutover build the target's Journal with the production implementation.
 */
function useProductionJournalBuild() {
    buildMigrationJournal.mockReset();
    buildMigrationJournal.mockImplementation(
        jest.requireActual('../src/generators/incremental_graph/migration_journal').buildMigrationJournal
    );
}

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

/**
 * Raised when a node key the test expects to be materialized has no identifier.
 */
class MissingNodeIdentifierError extends Error {
    /**
     * @param {string} nodeKey
     */
    constructor(nodeKey) {
        super(`The graph assigned no identifier to node key ${nodeKey}`);
        this.name = 'MissingNodeIdentifierError';
        this.nodeKey = nodeKey;
    }
}

/**
 * Read the identifier the migration assigned to a semantic node key.
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} db
 * @param {import('../src/generators/incremental_graph/database').NodeKeyString} nodeKey
 * @returns {import('../src/generators/incremental_graph/database').NodeIdentifier}
 */
function identifierForNodeKey(db, nodeKey) {
    const nodeIdentifier = db.nodeKeyToId(nodeKey);
    if (nodeIdentifier === undefined) {
        throw new MissingNodeIdentifierError(String(nodeKey));
    }
    return nodeIdentifier;
}

describe("migration Pass M1 records", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
        useProductionJournalBuild();
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
            const occurrence = await readCurrentOccurrence(
                db.getSchemaStorage().journal,
                deserializeNodeKey('{"head":"B","args":[]}')
            );
            expect(occurrence).toBeUndefined();
        } finally {
            if (db) await db.close();
        }
    });

    test("a replacement's journal record and the target graph state name the same modifiedAt", async () => {
        const caps = getTestCapabilities();
        const keyA = stringToNodeKeyString('{"head":"A","args":[]}');
        const publicationInstant = "2024-06-01T00:00:00.000Z";
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
            ];
            const g1 = await createIncrementalGraph(caps, db, nodeDefs);
            await g1.pull("A");
            const replacedIdentifier = identifierForNodeKey(db, keyA);
            const sourceTimestamps = await db.getSchemaStorage().timestamps.get(replacedIdentifier);
            expect(sourceTimestamps).toBeDefined();
            const sourceCreatedAt = sourceTimestamps?.createdAt;
            expect(sourceCreatedAt).toBeDefined();
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            // The publication instant must differ from the source occurrence's
            // modifiedAt, otherwise the two representations cannot disagree
            // visibly and this test would pass under either semantics.
            getDatetimeControl(caps).setDateTime(fromISOString(publicationInstant));

            db = await getRootDatabase(caps);
            await runMigration(caps, db, nodeDefs, async (storage) => {
                await storage.replace(
                    replacedIdentifier,
                    async () => numberComputedValue(20)
                );
            });

            const replacement = (await readSemanticEvents(db)).find(
                (record) => isValueEvent(record) && record.reason === "migration"
            );
            expect(replacement).toBeDefined();
            if (replacement === undefined || !isValueEvent(replacement)) {
                throw new Error("the replacement authors no migration ValueEvent");
            }
            expect(nodeKeyToCanonicalString(replacement.node)).toBe('{"head":"A","args":[]}');

            const targetTimestamps = await db.getSchemaStorage().timestamps.get(
                identifierForNodeKey(db, keyA)
            );
            expect(targetTimestamps).toBeDefined();
            if (targetTimestamps === undefined) {
                throw new Error("the target graph state carries no timestamps for the replaced node");
            }

            // §11a.3: a replacement preserves the existing materialization and its
            // createdAt, and takes the migration publication time as its modifiedAt.
            // The graph and the journal are two representations of that one occurrence,
            // so they must agree, and both must be the publication time.
            expect(replacement.createdAt).toBe(sourceCreatedAt);
            expect(replacement.modifiedAt).toBe(publicationInstant);
            expect(targetTimestamps.createdAt).toBe(replacement.createdAt);
            expect(targetTimestamps.modifiedAt).toBe(replacement.modifiedAt);
        } finally {
            if (db) await db.close();
        }
    });
});

describe("the migration cutover verifies the target before selecting it", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
        useProductionJournalBuild();
    });

    afterEach(() => {
        useProductionJournalBuild();
    });

    /**
     * A source replica with one materialized node, at database version "1".
     * @param {object} caps
     * @returns {Promise<{nodeDefs: Array<object>, nodeKey: import('../src/generators/incremental_graph/database').NodeKeyString, identifier: import('../src/generators/incremental_graph/database').NodeIdentifier, keepAll: (storage: object) => Promise<void>}>}
     */
    async function openSourceWithOneNode(caps) {
        const db = await getRootDatabase(caps);
        const nodeDefs = [
            { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
        ];
        const graph = await createIncrementalGraph(caps, db, nodeDefs);
        await graph.pull("A");
        await db.getSchemaStorage().global.put("version", "1");
        const nodeKey = stringToNodeKeyString('{"head":"A","args":[]}');
        const identifier = identifierForNodeKey(db, nodeKey);
        await db.close();
        return {
            nodeDefs,
            nodeKey,
            identifier,
            keepAll: async (storage) => {
                for await (const existing of storage.listMaterializedNodes()) {
                    await storage.keep(existing);
                }
            },
        };
    }

    test("a target whose graph and journal disagree about an occurrence is not selected", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            const source = await openSourceWithOneNode(caps);
            db = await getRootDatabase(caps);
            const replicaBefore = db.currentReplicaName();

            // The M1 publication is where the target's two representations are both
            // written, so a migration which leaves them disagreeing is caught by the
            // step which runs after it and before the cutover.
            const realBuildMigrationJournal = jest.requireActual(
                "../src/generators/incremental_graph/migration_journal"
            ).buildMigrationJournal;
            buildMigrationJournal.mockImplementation(async (...args) => {
                await realBuildMigrationJournal(...args);
                const targetStorage = args[1];
                const targetTimestamps = await targetStorage.timestamps.get(source.identifier);
                if (targetTimestamps === undefined) {
                    throw new Error("the target replica persisted no timestamps to disagree about");
                }
                await targetStorage.timestamps.put(source.identifier, {
                    createdAt: targetTimestamps.createdAt,
                    modifiedAt: "1999-01-01T00:00:00.000Z",
                });
            });

            await expect(
                runMigration(caps, db, source.nodeDefs, source.keepAll)
            ).rejects.toThrow(/journal and graph disagree/);
            expect(db.currentReplicaName()).toBe(replicaBefore);
        } finally {
            if (db) await db.close();
        }
    });

    test("a target whose retained history explains none of its values is not selected", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            const source = await openSourceWithOneNode(caps);
            db = await getRootDatabase(caps);
            const replicaBefore = db.currentReplicaName();

            buildMigrationJournal.mockImplementation(async () => undefined);

            await expect(
                runMigration(caps, db, source.nodeDefs, source.keepAll)
            ).rejects.toThrow(/selects no occurrence for/);
            expect(db.currentReplicaName()).toBe(replicaBefore);
        } finally {
            if (db) await db.close();
        }
    });

    test("a retry after a crash converges on the decisions the retry makes", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const nodeDefs = [
                { output: "A", inputs: [], computor: async () => numberComputedValue(1), isDeterministic: true, hasSideEffects: false },
                { output: "B", inputs: [], computor: async () => numberComputedValue(2), isDeterministic: true, hasSideEffects: false },
            ];
            const graph = await createIncrementalGraph(caps, db, nodeDefs);
            await graph.pull("A");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            const sourceReplica = db.currentReplicaName();

            // A first attempt which creates B and then dies before the cutover. The
            // source still reports the old version, so the migration runs again, and
            // the retry is free to decide differently about B.
            const realBuildMigrationJournal = jest.requireActual(
                "../src/generators/incremental_graph/migration_journal"
            ).buildMigrationJournal;
            buildMigrationJournal.mockImplementation(async (...args) => {
                await realBuildMigrationJournal(...args);
                throw new InterruptedMigrationError();
            });
            await expect(
                runMigration(caps, db, nodeDefs, async (storage) => {
                    for await (const existing of storage.listMaterializedNodes()) {
                        await storage.keep(existing);
                    }
                    await storage.create(
                        '{"head":"B","args":[]}',
                        async () => numberComputedValue(20),
                        "up-to-date"
                    );
                })
            ).rejects.toThrow(InterruptedMigrationError);
            expect(db.currentReplicaName()).toBe(sourceReplica);

            // The retry creates nothing, so B is not part of the target the retry
            // builds. The records and occurrence-index entries the discarded attempt
            // wrote must not survive into it.
            useProductionJournalBuild();
            await runMigration(caps, db, nodeDefs, async (storage) => {
                for await (const existing of storage.listMaterializedNodes()) {
                    await storage.keep(existing);
                }
            });

            const nodeB = stringToNodeKeyString('{"head":"B","args":[]}');
            expect(db.nodeKeyToId(nodeB)).toBeUndefined();
            expect(await readCurrentOccurrence(db.getSchemaStorage().journal, deserializeNodeKey(nodeB)))
                .toBeUndefined();
            const migrationValues = (await readSemanticEvents(db)).filter(
                (record) => isValueEvent(record) && record.reason === "migration"
            );
            expect(
                migrationValues.filter(
                    (record) => nodeKeyToCanonicalString(record.node) === '{"head":"B","args":[]}'
                )
            ).toHaveLength(0);
        } finally {
            if (db) await db.close();
        }
    });
});

/**
 * Raised to abandon a cutover after the target's Journal has been written and
 * before the pointer selects the target.
 */
class InterruptedMigrationError extends Error {
    constructor() {
        super("the migration was interrupted before the cutover");
        this.name = 'InterruptedMigrationError';
    }
}
