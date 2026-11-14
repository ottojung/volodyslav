"use strict";

/**
 * `incremental-graph-journal-testing.md` §Historical migration callbacks are not
 * replay behavior.
 *
 * After a successful Journal-aware migration cutover the retained Journal is
 * self-describing: replay obtains all historical value/proof state from the
 * retained records. Opening, replaying and rebuilding the projection therefore
 * never invoke the historical migration callback, and they remain correct without
 * access to it. This regression pins that the migrated history is data, not a live
 * dependency on the migration definition.
 *
 * The test runs a real cutover, then reads the retained Journal back through the
 * store's persisted-text path and projects it with the reference oracle. The
 * callback is instrumented to fail if it is invoked after the cutover, so a replay
 * path which reached back into the migration definition would not merely be
 * observable as an extra call: it would throw.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    GRAPH_SCHEME_KEY,
    getRootDatabase,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
} = require("../src/generators/incremental_graph");
const {
    makeJournalFormatCodec,
} = require("../src/generators/incremental_graph/migration_codec");
const {
    readCommittedWriterState,
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");
const {
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");
const { deriveInputPositions } = require("../src/generators/incremental_graph/database/graph_scheme");
const { numberComputedValue } = require("./computed_value_fixture");
const { getMockedRootCapabilities } = require("./spies");
const { stubDatetime, stubEnvironment, stubLogger } = require("./stubs");

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
 * A codec which renames the head of every node key and adds a constant to every
 * `calories` payload. The rename is a representation change only, so `keep` of a
 * transported key is allowed and the retained history is rewritten in place.
 *
 * @param {string} suffix
 * @returns {import('../src/generators/incremental_graph/migration_codec').JournalFormatCodec}
 */
function renamingCodec(suffix) {
    const codec = makeJournalFormatCodec({
        rewriteNodeKey: (sourceKey) => ({
            head: sourceKey.head + suffix,
            args: sourceKey.args,
        }),
        rewriteComputedValue: (_sourceKey, payload) => (
            payload.type === "calories"
                ? { type: "calories", value: payload.value + 1000 }
                : payload
        ),
    });
    if (codec instanceof Error) {
        throw codec;
    }
    return codec;
}

/** The node definitions of the renamed schema. */
const RENAMED_NODE_DEFS = [
    {
        output: "Arenamed", inputs: [],
        computor: async () => numberComputedValue(1),
        isDeterministic: true, hasSideEffects: false,
    },
    {
        output: "Brenamed", inputs: ["Arenamed"],
        computor: async (inputs) => numberComputedValue(Number(inputs[0].value) * 2),
        isDeterministic: true, hasSideEffects: false,
    },
];

/** The node definitions of the source schema. */
const SOURCE_NODE_DEFS = [
    {
        output: "A", inputs: [],
        computor: async () => numberComputedValue(1),
        isDeterministic: true, hasSideEffects: false,
    },
    {
        output: "B", inputs: ["A"],
        computor: async (inputs) => numberComputedValue(Number(inputs[0].value) * 2),
        isDeterministic: true, hasSideEffects: false,
    },
];

describe("a migrated Journal replays without its historical migration callback", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
    });

    test("replay reads the target state from the retained records alone", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS);
            await graph.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            /**
             * The historical migration callback, instrumented so that a replay
             * path which invoked it after the cutover throws rather than merely
             * recording an extra call.
             * @type {number}
             */
            let callbackInvocations = 0;
            let cutOver = false;
            const callback = async (storage) => {
                callbackInvocations += 1;
                if (cutOver) {
                    throw new Error("the historical migration callback ran after cutover");
                }
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            };

            db = await getRootDatabase(caps);
            await runMigration(caps, db, RENAMED_NODE_DEFS, callback, renamingCodec("renamed"));
            // Non-vacuity: the migration itself invoked the callback, so the
            // assertion below is about replay not invoking it, not about the
            // callback never being used.
            expect(callbackInvocations).toBe(1);
            cutOver = true;
            const invocationsAfterMigration = callbackInvocations;

            // Replay the retained Journal from the persisted records alone. No
            // migration definition or callback is in scope here.
            const storage = db.getSchemaStorage();
            const replica = await readRetainedJournal(storage.journal);
            expect(replica instanceof Error).toBe(false);
            if (replica instanceof Error) {
                throw replica;
            }
            const committed = await readCommittedWriterState(storage.journal, db.getFingerprint());
            expect(committed instanceof Error).toBe(false);
            if (committed instanceof Error) {
                throw committed;
            }
            const graphSchemeString = await storage.global.get(GRAPH_SCHEME_KEY);
            const currentInputKeysOfNode = (nodeKeyString) => {
                try {
                    return deriveInputPositions(graphSchemeString, nodeKeyString);
                } catch (error) {
                    return [];
                }
            };
            const projection = await projectRetainedJournal({
                source: makeReplicaSource(replica),
                localWriter: committed.localWriter,
                currentInputKeysOfNode,
            });
            expect(projection instanceof Error).toBe(false);
            if (projection instanceof Error) {
                throw projection;
            }

            // Replay never invoked the historical callback: the migrated history is
            // self-describing.
            expect(callbackInvocations).toBe(invocationsAfterMigration);

            // The replayed projection is the migrated target: every present node is
            // a renamed key, and the codec's payload transform is present in the
            // records rather than recomputed by the callback.
            const byKey = new Map(
                projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
            );
            const targetKeys = [...byKey.keys()];
            expect(targetKeys.length).toBeGreaterThan(0);
            for (const key of targetKeys) {
                expect(key).toContain("renamed");
            }
            const a = [...byKey.values()].find((occurrence) => occurrence.nodeKey.head === "Arenamed");
            const b = [...byKey.values()].find((occurrence) => occurrence.nodeKey.head === "Brenamed");
            expect(a).toBeDefined();
            expect(b).toBeDefined();
            if (a === undefined || b === undefined) {
                return;
            }
            expect(a.payload).toEqual({ type: "calories", value: 1001 });
            expect(b.payload).toEqual({ type: "calories", value: 1002 });
            // The migrated Journal is internally consistent: replay is fresh and
            // dependency-closed, so the replay target is a supported committed state.
            expect(a.fresh).toBe(true);
            expect(b.fresh).toBe(true);
            expect([...b.validInputs]).toEqual([a.nodeKeyString]);
        } finally {
            mockCheckpointMigration.mockReset();
            if (db) await db.close();
        }
    });
});
