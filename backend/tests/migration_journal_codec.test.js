/**
 * The source->target Journal format codec of a Journal-aware migration.
 *
 * `docs/specs/incremental-graph-journal-migrations.md` §9 step 1 rewrites all
 * retained history into the target representation, and §9a makes the
 * `JournalFormatCodec` the one mechanism which does it. §11 then addresses the
 * callback by `NodeIdentifier` while reasoning about `Kt = rewriteNodeKey(Ks)`,
 * which is the same transported key space the rewritten history is in.
 *
 * These tests run a real cutover and read the target replica's Journal and graph
 * state afterwards, so they assert that a declared codec actually reaches both
 * halves rather than only one of them.
 */

const { runMigration } = require("../src/generators/incremental_graph/migration_runner");
const {
    deserializeNodeKey,
    getRootDatabase,
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    stringToNodeKeyString,
} = require("../src/generators/incremental_graph/database");
const {
    createIncrementalGraph,
} = require("../src/generators/incremental_graph");
const {
    isJournalFormatCodec,
    makeIdentityJournalFormatCodec,
    makeJournalFormatCodec,
} = require("../src/generators/incremental_graph/migration_codec");
const {
    isJournalVersionCompatibilityError,
    nodeKeyToCanonicalString,
    semanticEventsOfReplica,
} = require("../src/generators/incremental_graph/journal");
const {
    readCurrentOccurrence,
    readRetainedJournal,
} = require("../src/generators/incremental_graph/journal_store");
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
 * A codec which renames the head of every node key and adds a constant to every
 * `calories` payload it meets.
 *
 * The rename is a representation change only: the node the target key denotes is
 * the node the source key denoted, so §11a.1 allows `keep` of it.
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

describe("journal-aware migration format codec", () => {
    beforeEach(() => {
        mockCheckpointMigration.mockReset();
        mockCheckpointMigration.mockImplementation(
            async (_caps, _db, _pre, _post, callback) => await callback()
        );
    });

    test("a declared codec rewrites the retained history and the identifier lookup it is carried with", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS);
            await graph.pull("B");
            const sourceIdentifiers = db.getActiveIdentifierLookup();
            const sourceAIdentifier = sourceIdentifiers.keyToId.get('{"head":"A","args":[]}');
            const sourceBIdentifier = sourceIdentifiers.keyToId.get('{"head":"B","args":[]}');
            expect(sourceAIdentifier).toBeDefined();
            expect(sourceBIdentifier).toBeDefined();
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, RENAMED_NODE_DEFS, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, renamingCodec("renamed"));

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            const events = semanticEventsOfReplica(retained);
            expect(events.length).toBeGreaterThan(0);
            for (const event of events) {
                const head = String(event.node.head);
                expect(head.endsWith("renamed")).toBe(true);
            }
            for (const event of events) {
                if (event.kind !== "value") {
                    continue;
                }
                expect(event.payload.type).toBe("calories");
                // The payload every source occurrence carried was re-derived
                // through the codec, so no carried payload keeps its source
                // number.
                expect(event.payload.value).toBeGreaterThanOrEqual(1000);
            }

            // Every embedded NodeKey was rewritten, including the basis inputs
            // of the certificates the source retained.
            for (const event of events) {
                if (event.kind !== "validate") {
                    continue;
                }
                for (const entry of event.basis) {
                    expect(String(entry.input.head).endsWith("renamed")).toBe(true);
                }
            }

            // The occurrence index is keyed by node key, so it was re-keyed as
            // well: the target key resolves, the source key does not.
            const targetOccurrence = await readCurrentOccurrence(
                db.getSchemaStorage().journal,
                deserializeNodeKey(stringToNodeKeyString('{"head":"Arenamed","args":[]}'))
            );
            expect(targetOccurrence).toBeDefined();
            const sourceOccurrence = await readCurrentOccurrence(
                db.getSchemaStorage().journal,
                deserializeNodeKey(stringToNodeKeyString('{"head":"A","args":[]}'))
            );
            expect(sourceOccurrence).toBeUndefined();

            // The target replica materializes the transported target keys under
            // the identifiers the source replica persisted.
            const targetIdentifiers = db.getActiveIdentifierLookup();
            expect(targetIdentifiers.keyToId.get('{"head":"Arenamed","args":[]}')).toBe(String(sourceAIdentifier));
            expect(targetIdentifiers.keyToId.get('{"head":"Brenamed","args":[]}')).toBe(String(sourceBIdentifier));
            expect(targetIdentifiers.idToKey.get(String(sourceAIdentifier)))
                .toBe('{"head":"Arenamed","args":[]}');
            expect(targetIdentifiers.idToKey.get(String(sourceBIdentifier)))
                .toBe('{"head":"Brenamed","args":[]}');
        } finally {
            if (db) await db.close();
        }
    });

    test("a codec which is not injective over the retained keys is rejected before the cutover", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS);
            await graph.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            const activeReplicaBefore = db.currentReplicaName();
            await db.close();

            const colliding = makeJournalFormatCodec({
                rewriteNodeKey: () => ({ head: "same", args: [] }),
            });
            expect(colliding instanceof Error).toBe(false);
            if (colliding instanceof Error) {
                return;
            }

            db = await getRootDatabase(caps);
            await expect(runMigration(caps, db, RENAMED_NODE_DEFS, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, colliding)).rejects.toMatchObject({ name: "JournalVersionCompatibilityError" });

            // The failed cutover left the previous active pair selected.
            expect(db.currentReplicaName()).toBe(activeReplicaBefore);
        } finally {
            if (db) await db.close();
        }
    });

    test("a codec transform which throws is rejected before the cutover", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS);
            await graph.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            const throwing = makeJournalFormatCodec({
                rewriteNodeKey: () => { throw new Error("no target representation for this key"); },
            });
            expect(throwing instanceof Error).toBe(false);
            if (throwing instanceof Error) {
                return;
            }

            db = await getRootDatabase(caps);
            await expect(runMigration(caps, db, RENAMED_NODE_DEFS, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, throwing)).rejects.toMatchObject({ name: "JournalVersionCompatibilityError" });
        } finally {
            if (db) await db.close();
        }
    });

    test("an omitted transform defaults to the identity transform, and an async one is not a codec", () => {
        const implicit = makeJournalFormatCodec();
        expect(implicit instanceof Error).toBe(false);
        if (implicit instanceof Error) {
            return;
        }
        expect(implicit.rewriteNodeKey({ head: "A", args: [] })).toEqual({ head: "A", args: [] });

        const declared = makeJournalFormatCodec({ rewriteNodeKey: (key) => key });
        expect(declared instanceof Error).toBe(false);
        if (declared instanceof Error) {
            return;
        }
        expect(declared.rewriteNodeKey({ head: "A", args: [] })).toEqual({ head: "A", args: [] });

        const asyncCodec = makeJournalFormatCodec({
            rewriteNodeKey: async (key) => key,
        });
        expect(isJournalVersionCompatibilityError(asyncCodec)).toBe(true);

        const asyncValueCodec = makeJournalFormatCodec({
            rewriteComputedValue: async (_key, payload) => payload,
        });
        expect(isJournalVersionCompatibilityError(asyncValueCodec)).toBe(true);

        const notAFunction = makeJournalFormatCodec({
            rewriteNodeKey: /** @type {never} */ ("not a function"),
        });
        expect(isJournalVersionCompatibilityError(notAFunction)).toBe(true);
    });

    test("the identity codec carries a retained record byte-for-byte", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS);
            await graph.pull("B");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, SOURCE_NODE_DEFS, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, makeIdentityJournalFormatCodec());

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            // A keep authors nothing, so the only records the target carries are
            // the ones it carried through the identity codec.
            const events = semanticEventsOfReplica(retained);
            expect(events.length).toBe(4);
            for (const event of events) {
                expect(nodeKeyToCanonicalString(event.node)).toMatch(/"head":"(A|B)"/);
            }
            const graphScheme = await db.getSchemaStorage().global.get(GRAPH_SCHEME_KEY);
            expect(typeof graphScheme).toBe("string");
            const identifiers = await db.getSchemaStorage().global.get(IDENTIFIERS_KEY);
            expect(Array.isArray(identifiers)).toBe(true);
        } finally {
            if (db) await db.close();
        }
    });

    test("the identity codec is a nominal codec value", () => {
        expect(isJournalFormatCodec(makeIdentityJournalFormatCodec())).toBe(true);
    });

    test("a codec whose target canonical order differs re-sorts every rewritten basis", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const sourceNodeDefs = [
                {
                    output: "A", inputs: [],
                    computor: async () => numberComputedValue(1),
                    isDeterministic: true, hasSideEffects: false,
                },
                {
                    output: "Z", inputs: [],
                    computor: async () => numberComputedValue(2),
                    isDeterministic: true, hasSideEffects: false,
                },
                {
                    output: "sum", inputs: ["A", "Z"],
                    computor: async (inputs) => numberComputedValue(
                        Number(inputs[0].value) + Number(inputs[1].value)
                    ),
                    isDeterministic: true, hasSideEffects: false,
                },
            ];
            const graph = await createIncrementalGraph(caps, db, sourceNodeDefs);
            await graph.pull("sum");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            // Under the source representation `A` sorts before `Z`; under the target
            // representation `a9` sorts before `z9`, which is the opposite order.
            const reordering = makeJournalFormatCodec({
                rewriteNodeKey: (sourceKey) => {
                    if (sourceKey.head === "A") {
                        return { head: "z9", args: sourceKey.args };
                    }
                    if (sourceKey.head === "Z") {
                        return { head: "a9", args: sourceKey.args };
                    }
                    return { head: sourceKey.head, args: sourceKey.args };
                },
            });
            expect(reordering instanceof Error).toBe(false);
            if (reordering instanceof Error) {
                return;
            }

            const targetNodeDefs = [
                {
                    output: "z9", inputs: [],
                    computor: async () => numberComputedValue(1),
                    isDeterministic: true, hasSideEffects: false,
                },
                {
                    output: "a9", inputs: [],
                    computor: async () => numberComputedValue(2),
                    isDeterministic: true, hasSideEffects: false,
                },
                {
                    output: "sum", inputs: ["z9", "a9"],
                    computor: async (inputs) => numberComputedValue(
                        Number(inputs[0].value) + Number(inputs[1].value)
                    ),
                    isDeterministic: true, hasSideEffects: false,
                },
            ];

            db = await getRootDatabase(caps);
            await runMigration(caps, db, targetNodeDefs, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, reordering);

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            const events = semanticEventsOfReplica(retained);
            /** @type {string[]} */
            const basisOrders = [];
            for (const event of events) {
                if (event.kind !== "validate") {
                    continue;
                }
                basisOrders.push(
                    event.basis.map((entry) => nodeKeyToCanonicalString(entry.input)).join(" ")
                );
            }
            // The zero-input nodes carry an empty basis, and the dependent carries
            // the one this test is about.
            expect(basisOrders).toEqual([
                "",
                "",
                '{"head":"a9","args":[]} {"head":"z9","args":[]}',
            ]);
        } finally {
            if (db) await db.close();
        }
    });

    test("a create collides with a transported target key rather than with the source spelling", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS.slice(0, 1));
            await graph.pull("A");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            const codec = renamingCodec("renamed");
            const targetNodeDefs = [
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

            db = await getRootDatabase(caps);
            let rejection;
            try {
                await runMigration(caps, db, targetNodeDefs, async (storage) => {
                    for await (const identifier of storage.listMaterializedNodes()) {
                        await storage.keep(identifier);
                    }
                    await storage.create(
                        '{"head":"Arenamed","args":[]}',
                        async () => numberComputedValue(9),
                        "up-to-date"
                    );
                }, codec);
            } catch (error) {
                rejection = error;
            }
            // `Arenamed` is the transported target key of a materialized source
            // node, so the target semantic node already exists and create refuses it.
            expect(rejection).toMatchObject({ name: "CreateExistingNodeError" });
        } finally {
            if (db) await db.close();
        }
    });

    test("keep validates the transported target key, not the source spelling", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS.slice(0, 1));
            await graph.pull("A");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            // The target schema declares only the transported key, so a check made
            // against the source spelling would refuse every keep.
            const targetNodeDefs = [
                {
                    output: "Arenamed", inputs: [],
                    computor: async () => numberComputedValue(1),
                    isDeterministic: true, hasSideEffects: false,
                },
            ];

            db = await getRootDatabase(caps);
            await runMigration(caps, db, targetNodeDefs, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, renamingCodec("renamed"));

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            const events = semanticEventsOfReplica(retained);
            expect(events.map((event) => nodeKeyToCanonicalString(event.node)))
                .toEqual([
                    '{"head":"Arenamed","args":[]}',
                    '{"head":"Arenamed","args":[]}',
                ]);
        } finally {
            if (db) await db.close();
        }
    });

    test("a codec whose transform is not a function is refused as a codec definition", () => {
        const badValue = makeJournalFormatCodec({
            rewriteComputedValue: /** @type {never} */ (42),
        });
        expect(isJournalVersionCompatibilityError(badValue)).toBe(true);
        expect(isJournalFormatCodec(badValue)).toBe(false);
    });

    test("keep of a key whose representation changed preserves its ValueId and authors nothing", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS);
            await graph.pull("B");
            await db.getSchemaStorage().global.put("version", "1");

            const sourceRetained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(sourceRetained instanceof Error).toBe(false);
            if (sourceRetained instanceof Error) {
                return;
            }
            /** @type {Map<string, string>} */
            const sourceValueIdByKey = new Map();
            for (const event of semanticEventsOfReplica(sourceRetained)) {
                if (event.kind === "value") {
                    sourceValueIdByKey.set(nodeKeyToCanonicalString(event.node), String(event.id));
                }
            }
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, RENAMED_NODE_DEFS, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.keep(identifier);
                }
            }, renamingCodec("renamed"));

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            /** @type {Map<string, string>} */
            const targetValueIdByKey = new Map();
            for (const event of semanticEventsOfReplica(retained)) {
                if (event.kind === "value") {
                    targetValueIdByKey.set(nodeKeyToCanonicalString(event.node), String(event.id));
                }
            }
            expect(targetValueIdByKey.get('{"head":"Arenamed","args":[]}'))
                .toBe(sourceValueIdByKey.get('{"head":"A","args":[]}'));
            expect(targetValueIdByKey.get('{"head":"Brenamed","args":[]}'))
                .toBe(sourceValueIdByKey.get('{"head":"B","args":[]}'));

            // A representation change is not a semantic occurrence replacement, so
            // the migration authored no value record and no absence record for it.
            /** @param {string} kind */
            const reasonsOf = (kind) => semanticEventsOfReplica(retained)
                .filter((event) => event.kind === kind)
                .map((event) => event.reason);
            expect(reasonsOf("value")).not.toContain("migration");
            expect(reasonsOf("delete")).not.toContain("migration");
        } finally {
            if (db) await db.close();
        }
    });

    test("a produced occurrence under a codec keeps the target representation in both halves", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS.slice(0, 1));
            await graph.pull("A");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            const targetNodeDefs = [
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

            db = await getRootDatabase(caps);
            await runMigration(caps, db, targetNodeDefs, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.replace(
                        identifier,
                        async () => numberComputedValue(50)
                    );
                }
                await storage.create(
                    '{"head":"Brenamed","args":[]}',
                    async () => numberComputedValue(60),
                    "up-to-date"
                );
            }, renamingCodec("renamed"));

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            /** @type {Map<string, {payload: unknown, reason: string}>} */
            const produced = new Map();
            for (const event of semanticEventsOfReplica(retained)) {
                if (event.kind === "value" && event.reason === "migration") {
                    produced.set(nodeKeyToCanonicalString(event.node), {
                        payload: event.payload,
                        reason: event.reason,
                    });
                }
            }
            expect([...produced.keys()].sort()).toEqual([
                '{"head":"Arenamed","args":[]}',
                '{"head":"Brenamed","args":[]}',
            ]);
            // The migration's own payload is target-representation callback output,
            // so the codec does not rewrite it.
            expect(produced.get('{"head":"Arenamed","args":[]}').payload)
                .toEqual({ type: "calories", value: 50 });
            expect(produced.get('{"head":"Brenamed","args":[]}').payload)
                .toEqual({ type: "calories", value: 60 });

            // Both occurrences the target graph materializes carry the same payload
            // the record naming them carries, which the cutover itself verifies
            // before it selects the target.
            const graph2 = await createIncrementalGraph(caps, db, targetNodeDefs);
            expect(await graph2.getValue("Arenamed")).toEqual({ type: "calories", value: 50 });
            expect(await graph2.getValue("Brenamed")).toEqual({ type: "calories", value: 60 });
        } finally {
            if (db) await db.close();
        }
    });

    test("an invalidated occurrence under a codec keeps its transported ValueId and authors a node-scoped invalidation", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const graph = await createIncrementalGraph(caps, db, SOURCE_NODE_DEFS.slice(0, 1));
            await graph.pull("A");
            await db.getSchemaStorage().global.put("version", "1");

            const sourceRetained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(sourceRetained instanceof Error).toBe(false);
            if (sourceRetained instanceof Error) {
                return;
            }
            const sourceValueId = semanticEventsOfReplica(sourceRetained)
                .filter((event) => event.kind === "value")
                .map((event) => String(event.id))[0];
            await db.close();

            const targetNodeDefs = [
                {
                    output: "Arenamed", inputs: [],
                    computor: async () => numberComputedValue(1),
                    isDeterministic: true, hasSideEffects: false,
                },
            ];

            db = await getRootDatabase(caps);
            await runMigration(caps, db, targetNodeDefs, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    await storage.invalidate(identifier);
                }
            }, renamingCodec("renamed"));

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            const events = semanticEventsOfReplica(retained);
            const valueIds = events
                .filter((event) => event.kind === "value")
                .map((event) => String(event.id));
            expect(valueIds).toEqual([sourceValueId]);
            const invalidations = events.filter((event) => event.kind === "invalidate");
            expect(invalidations).toHaveLength(1);
            expect(nodeKeyToCanonicalString(invalidations[0].node))
                .toBe('{"head":"Arenamed","args":[]}');
            if (invalidations[0].kind !== "invalidate") {
                return;
            }
            expect(invalidations[0].scope).toEqual({ kind: "node" });
            expect(invalidations[0].reason).toBe("migration");
        } finally {
            if (db) await db.close();
        }
    });

    test("a node family the target schema no longer declares keeps its retained history", async () => {
        const caps = getTestCapabilities();
        let db;
        try {
            db = await getRootDatabase(caps);
            const removedSourceDefs = [
                ...SOURCE_NODE_DEFS,
                {
                    output: "gone", inputs: [],
                    computor: async () => numberComputedValue(7),
                    isDeterministic: true, hasSideEffects: false,
                },
                {
                    output: "goneUser", inputs: ["gone"],
                    computor: async (inputs) => numberComputedValue(Number(inputs[0].value) + 1),
                    isDeterministic: true, hasSideEffects: false,
                },
            ];
            const graph = await createIncrementalGraph(caps, db, removedSourceDefs);
            await graph.pull("B");
            await graph.pull("goneUser");
            await db.getSchemaStorage().global.put("version", "1");
            await db.close();

            db = await getRootDatabase(caps);
            await runMigration(caps, db, RENAMED_NODE_DEFS, async (storage) => {
                for await (const identifier of storage.listMaterializedNodes()) {
                    const key = await storage.resolveNodeKey(identifier);
                    const head = key === undefined ? "" : String(key.head);
                    if (head === "A" || head === "B") {
                        await storage.keep(identifier);
                    } else {
                        await storage.delete(identifier);
                    }
                }
            }, renamingCodec("renamed"));

            const retained = await readRetainedJournal(db.getSchemaStorage().journal);
            expect(retained instanceof Error).toBe(false);
            if (retained instanceof Error) {
                return;
            }
            const events = semanticEventsOfReplica(retained);
            /** @type {Set<string>} */
            const removedFamilyKeys = new Set();
            /** @type {Set<string>} */
            const deletedKeys = new Set();
            for (const event of events) {
                const key = nodeKeyToCanonicalString(event.node);
                if (String(event.node.head).startsWith("gone")) {
                    removedFamilyKeys.add(key);
                }
                if (event.kind === "delete") {
                    deletedKeys.add(key);
                }
            }
            // The codec domain is all retained source history, including records for
            // node families absent from the target schema, so the removed family's
            // occurrences and its absence both survive the rewrite.
            expect(removedFamilyKeys).toEqual(new Set([
                '{"head":"gonerenamed","args":[]}',
                '{"head":"goneUserrenamed","args":[]}',
            ]));
            expect(deletedKeys).toEqual(new Set([
                '{"head":"gonerenamed","args":[]}',
                '{"head":"goneUserrenamed","args":[]}',
            ]));
            // Neither removed node resolves a current occurrence any more.
            for (const key of removedFamilyKeys) {
                const occurrence = await readCurrentOccurrence(
                    db.getSchemaStorage().journal,
                    deserializeNodeKey(stringToNodeKeyString(key))
                );
                expect(occurrence).toBeUndefined();
            }
        } finally {
            if (db) await db.close();
        }
    });
});
