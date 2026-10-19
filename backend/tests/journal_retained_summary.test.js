/**
 * The persisted, maintained change-bounded proof summary.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires the
 * active/staged Journal state to provide an incrementally maintained derived summary and
 * forbids `reset`, `synchronization` and routine open from falling back to scanning
 * unrelated retained history to obtain it. §Derived indexes requires a maintained index
 * to be updated in durable staging before the state it describes becomes active.
 *
 * These tests pin the three halves of that requirement:
 *
 * - the codec which lets the summary survive the process that published the records, by
 *   round-tripping every container the state class declares;
 * - the store which reads the summary as one key rather than by traversal, so acquiring
 *   it is change-bounded; and
 * - the production receiver wiring, which must not call the maintenance traversal at all.
 *
 * The last is a source guard rather than a call counter because the receiver modules no
 * longer import the traversal, so a future edit which reintroduces a scan is caught here
 * even though no runtime seam remains to spy on.
 */

const fs = require("fs");
const path = require("path");

const {
    journalAuthorToString,
    journalRecordIdToString,
    makeAuthorityTime,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeNodeScope,
    makeProofScope,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    makeWriterStateRecord,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    buildRetainedReplayState,
    deserializeRetainedReplayState,
    eligibleProofEdgeUnion,
    makeEmptyRetainedReplayState,
    projectRetainedReplay,
    selectedOccurrencesOf,
    serializeRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const {
    appendRetainedStateOp,
    readRetainedJournal,
    readRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_store");

const {
    createIncrementalGraph,
} = require("../src/generators/incremental_graph");
const {
    getRootDatabase,
} = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger } = require("./stubs");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_LOCAL = "aaaaaaaaa";
const PAYLOAD = { type: "entry_description", description: "x" };

/**
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    return nodeKeyString === nodeKeyToCanonicalString(NODE_B) ? [KEY_A] : [];
}

/**
 * @template T
 * @param {T | Error} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

/**
 * @param {number} physical
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical) {
    return made(makeAuthorityTime(physical, "0"));
}

/**
 * A materialization-and-validation pair.
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<[string, string]>} occurrence.context
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} occurrence.basis
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function materialize(occurrence) {
    const valueId = occurrence.writer + ":" + occurrence.sequence;
    const valueSequence = String(Number(occurrence.sequence) + 1);
    const nodeIdentifier = String(occurrence.node.args[0].id) + "-abcdefghi";
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: makeJournalFrontierFromText(occurrence.context),
                authorityTime: authorityOf(Number(occurrence.sequence)),
                node: occurrence.node,
            },
            nodeIdentifier,
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: occurrence.writer + ":" + valueSequence,
                context: makeJournalFrontierFromText(occurrence.context),
                authorityTime: authorityOf(Number(valueSequence)),
                node: occurrence.node,
            },
            valueId,
            occurrence.basis.map((entry) => makeValidationBasisEntry(entry.node, entry.value)),
            "compute"
        )),
    ];
}

/**
 * A receiver with a certificate, a node-scoped invalidation, a value-scoped one and a
 * proof-scoped one, so every scope map of the summary is non-empty.
 * @returns {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function richReceiver() {
    const a = materialize({
        writer: WRITER_LOCAL,
        sequence: "1",
        node: NODE_A,
        context: [],
        basis: [],
    });
    const b = materialize({
        writer: WRITER_LOCAL,
        sequence: "3",
        node: NODE_B,
        context: [],
        basis: [{ node: NODE_A, value: WRITER_LOCAL + ":1" }],
    });
    const writerState = made(makeWriterStateRecord(WRITER_LOCAL + ":8", 42));
    const nodeScoped = made(makeInvalidateEvent(
        { id: WRITER_LOCAL + ":5", context: makeJournalFrontierFromText([]), authorityTime: authorityOf(5), node: NODE_A },
        makeNodeScope(),
        "explicit"
    ));
    const valueScoped = made(makeInvalidateEvent(
        { id: WRITER_LOCAL + ":6", context: makeJournalFrontierFromText([]), authorityTime: authorityOf(6), node: NODE_A },
        makeValueScope(WRITER_LOCAL + ":1"),
        "propagated"
    ));
    const proofScoped = made(makeInvalidateEvent(
        { id: WRITER_LOCAL + ":7", context: makeJournalFrontierFromText([]), authorityTime: authorityOf(7), node: NODE_A },
        makeProofScope(WRITER_LOCAL + ":1", NODE_A),
        "reset"
    ));
    return [...a, ...b, nodeScoped, valueScoped, proofScoped, writerState];
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, Array<import("../src/generators/incremental_graph/journal").JournalRecord>>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return makeJournalReplica([...byWriter.entries()]);
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal_retained").RetainedReplayState>}
 */
async function buildOf(records) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: makeJournalAuthor(WRITER_LOCAL),
        currentInputKeysOfNode: chainInputs,
    });
    if ("error" in built) {
        throw new Error("the fixture state could not be built: " + built.error.message);
    }
    return built.state;
}

/**
 * The comparable resolution of a state.
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
 */
function resolutionOf(state) {
    const projected = projectRetainedReplay(state);
    if ("error" in projected) {
        throw new Error("the state did not project: " + projected.error.message);
    }
    return {
        occurrences: projected.occurrences.map((occurrence) => [
            occurrence.nodeKeyString,
            journalRecordIdToString(occurrence.valueId),
            occurrence.fresh,
            [...occurrence.validInputs].sort(),
            JSON.stringify(occurrence.payload),
        ]),
        lastNodeIndex: projected.lastNodeIndex,
    };
}

/**
 * The comparable proof union of a state.
 * @param {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState} state
 */
function proofUnionOf(state) {
    /** @type {Array<[string, ReadonlyArray<string>]>} */
    const edges = [];
    for (const [nodeKeyString, occurrence] of selectedOccurrencesOf(state)) {
        const union = eligibleProofEdgeUnion({
            summary: state.proofs,
            nodeKeyString,
            valueId: occurrence.valueId,
            authorOf: (name) => state.writers.get(name),
        });
        edges.push([nodeKeyString, [...union].sort()]);
    }
    edges.sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
    return edges;
}

/**
 * A fake Journal sublevel which counts point reads and key iterations.
 * @returns {{journal: object, gets: Array<string>, iterations: number}}
 */
function countingJournal() {
    /** @type {Map<string, string>} */
    const stored = new Map();
    const gets = [];
    let iterations = 0;
    return {
        gets,
        get iterations() {
            return iterations;
        },
        journal: {
            async get(key) {
                gets.push(String(key));
                return stored.get(String(key));
            },
            putOp(key, value) {
                return { type: "put", key, value, __fake: true, commit: () => stored.set(String(key), value) };
            },
            async *keys() {
                iterations += 1;
                for (const key of stored.keys()) {
                    yield key;
                }
            },
        },
    };
}

describe("the retained replay state codec", () => {
    test("round-trips a state with certificates and all three invalidation scopes", async () => {
        const state = await buildOf(richReceiver());
        expect(state.proofs.certificates.size).toBeGreaterThan(0);
        expect(state.proofs.nodeScoped.size).toBeGreaterThan(0);
        expect(state.proofs.valueScoped.size).toBeGreaterThan(0);
        expect(state.proofs.proofScoped.size).toBeGreaterThan(0);

        const decoded = deserializeRetainedReplayState(serializeRetainedReplayState(state), {
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: chainInputs,
        });
        if (decoded instanceof Error) {
            throw decoded;
        }

        expect(resolutionOf(decoded)).toEqual(resolutionOf(state));
        expect(proofUnionOf(decoded)).toEqual(proofUnionOf(state));
        expect(decoded.lastNodeIndex).toBe(state.lastNodeIndex);
        expect(decoded.lastNodeIndex).toBe(42);
        expect([...decoded.admittedLengths.entries()]).toEqual([...state.admittedLengths.entries()]);
        expect([...decoded.writers.keys()]).toEqual([...state.writers.keys()]);
    });

    test("rejects a state built for another local writer", async () => {
        const state = await buildOf(richReceiver());
        const decoded = deserializeRetainedReplayState(serializeRetainedReplayState(state), {
            localWriter: makeJournalAuthor("bbbbbbbbb"),
            currentInputKeysOfNode: chainInputs,
        });
        expect(decoded).toBeInstanceOf(Error);
        expect(decoded.message).toMatch(/local writer/);
    });

    test("rejects text which is not a retained replay state", () => {
        const decoded = deserializeRetainedReplayState("{\"not\":\"a state\"}", {
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: chainInputs,
        });
        expect(decoded).toBeInstanceOf(Error);
        expect(decoded.message).toMatch(/malformed/);
    });

    test("rejects malformed JSON rather than partially accepting it", () => {
        const decoded = deserializeRetainedReplayState("{not json", {
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: chainInputs,
        });
        expect(decoded).toBeInstanceOf(Error);
    });

    test("an empty state round-trips and is the empty summary of an empty journal", () => {
        const empty = makeEmptyRetainedReplayState(makeJournalAuthor(WRITER_LOCAL), chainInputs);
        const decoded = deserializeRetainedReplayState(serializeRetainedReplayState(empty), {
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: chainInputs,
        });
        if (decoded instanceof Error) {
            throw decoded;
        }
        expect(decoded.heads.size).toBe(0);
        expect(decoded.admittedLengths.size).toBe(0);
        expect(decoded.lastNodeIndex).toBe(0);
    });
});

describe("the persisted summary is acquired as one key, not by traversal", () => {
    test("reading the summary performs exactly one point read and no iteration", async () => {
        const state = await buildOf(richReceiver());
        const counter = countingJournal();
        const ops = [];
        const rejected = appendRetainedStateOp(counter.journal, ops, state);
        expect(rejected).toBeUndefined();
        expect(ops).toHaveLength(1);
        ops[0].commit();

        const decoded = await readRetainedReplayState(counter.journal, {
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: chainInputs,
        });
        expect(decoded).not.toBeInstanceOf(Error);
        expect(decoded).not.toBeUndefined();
        expect(counter.gets.length).toBe(1);
        expect(counter.iterations).toBe(0);
    });

    test("an absent summary reads as undefined without iteration", async () => {
        const counter = countingJournal();
        const decoded = await readRetainedReplayState(counter.journal, {
            localWriter: makeJournalAuthor(WRITER_LOCAL),
            currentInputKeysOfNode: chainInputs,
        });
        expect(decoded).toBeUndefined();
        expect(counter.gets.length).toBe(1);
        expect(counter.iterations).toBe(0);
    });
});

describe("the production receivers consume the maintained summary", () => {
    /**
     * @param {string} file
     * @returns {string}
     */
    function sourceOf(file) {
        return fs.readFileSync(
            path.join(__dirname, "..", "src", "generators", "incremental_graph", "journal_publish", file),
            "utf8"
        );
    }

    test("the sync receiver does not reconstruct the summary by traversal", () => {
        const source = sourceOf("sync_receiver.js");
        expect(source).toContain("readRetainedReplayState");
        expect(source).not.toContain("buildRetainedReplayState");
    });

    test("the reset receiver does not reconstruct the summary by traversal", () => {
        const source = sourceOf("reset_receiver.js");
        expect(source).toContain("readRetainedReplayState");
        expect(source).not.toContain("buildRetainedReplayState");
    });

    test("both receivers fail closed rather than scanning when the summary is absent", () => {
        for (const file of ["sync_receiver.js", "reset_receiver.js"]) {
            const source = sourceOf(file);
            expect(source).toContain("no persisted change-bounded proof summary");
            expect(source).toContain("explicit rebuild/maintenance");
        }
    });

    test("the publication paths persist the summary atomically with the pair", () => {
        for (const file of ["sync_publication.js", "reset_publication.js"]) {
            const source = sourceOf(file);
            expect(source).toContain("appendRetainedStateOp");
        }
    });
});

describe("an ordinary publication maintains the persisted summary", () => {
    test("the persisted summary equals the state an explicit rebuild produces", async () => {
        const capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
        stubEnvironment(capabilities);
        const db = await getRootDatabase(capabilities);
        try {
            const graph = await createIncrementalGraph(capabilities, db, [
                {
                    output: "input1",
                    inputs: [],
                    computor: () => ({ type: "all_events", events: [] }),
                    isDeterministic: true,
                    hasSideEffects: false,
                },
            ]);
            await graph.pull("input1");

            const storage = db.getSchemaStorage();
            const localWriter = makeJournalAuthor(db.getFingerprint());
            if (localWriter instanceof Error) {
                throw localWriter;
            }
            const currentInputKeysOfNode = () => [];

            const persisted = await readRetainedReplayState(storage.journal, {
                localWriter,
                currentInputKeysOfNode,
            });
            expect(persisted).not.toBeUndefined();
            expect(persisted).not.toBeInstanceOf(Error);
            if (persisted === undefined || persisted instanceof Error) {
                return;
            }

            const replica = await readRetainedJournal(storage.journal);
            if (replica instanceof Error) {
                throw replica;
            }
            const rebuilt = await buildRetainedReplayState({
                source: makeReplicaSource(replica),
                localWriter,
                currentInputKeysOfNode,
            });
            if ("error" in rebuilt) {
                throw rebuilt.error;
            }

            expect(resolutionOf(persisted)).toEqual(resolutionOf(rebuilt.state));
            expect(proofUnionOf(persisted)).toEqual(proofUnionOf(rebuilt.state));
            expect([...persisted.admittedLengths.entries()]).toEqual(
                [...rebuilt.state.admittedLengths.entries()]
            );
        } finally {
            await db.close();
        }
    });
});
