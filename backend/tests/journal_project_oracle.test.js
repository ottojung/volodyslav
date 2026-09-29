const {
    isJournalCausalClosureError,
    isJournalForkError,
    isJournalGapError,
    isJournalProjectionError,
    compareJournalSequence,
    isValueEvent,
    journalRecordIdToString,
    journalSequenceAtFrontier,
    makeAuthorityTime,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeProofScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    makeWriterStateRecord,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    makeReplicaSource,
    makeUnionSource,
    projectRetainedJournal,
    readerOverIterable,
} = require("../src/generators/incremental_graph/journal/oracle");

const { declarativeProject } = require("./oracle_declarative_reference");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_C = { head: "event", args: [{ id: 3 }] };
const NODE_D = { head: "event", args: [{ id: 4 }] };
const NODE_E = { head: "event", args: [{ id: 5 }] };
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const WRITER_A = makeJournalAuthor("aaaaaaaaa");
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_C = nodeKeyToCanonicalString(NODE_C);
const KEY_D = nodeKeyToCanonicalString(NODE_D);
const KEY_E = nodeKeyToCanonicalString(NODE_E);
const NODES = [NODE_A, NODE_B, NODE_C];
const WRITER_NAMES = ["aaaaaaaaa", "bbbbbbbbb", "ccccccccc"];

/**
 * A deterministic pseudo-random source, so a generated history is a function of
 * its seed and a disagreement can be replayed exactly.
 * @param {number} seed
 * @returns {() => number}
 */
function makeRandom(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state * 1664525 + 1013904223) >>> 0;
        return state / 4294967296;
    };
}

/**
 * @param {ReadonlyArray<ReadonlyArray<string>>} coordinates
 * @returns {import("../src/generators/incremental_graph/journal").JournalFrontier}
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * @param {number} physical
 * @param {number} logical
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical, logical) {
    return makeAuthorityTime(physical, String(logical));
}

/**
 * The current schema: A depends on B and C, B depends on A, C depends on A, and
 * a fourth node is the cycle detector's subject.
 * @param {ReadonlyArray<string>} inputsOfA
 * @returns {(nodeKeyString: string) => ReadonlyArray<string>}
 */
function schemaOf(inputsOfA) {
    return (nodeKeyString) => {
        if (nodeKeyString === KEY_A) {
            return inputsOfA;
        }
        if (nodeKeyString === KEY_B) {
            return [KEY_A];
        }
        if (nodeKeyString === KEY_C) {
            return [KEY_A];
        }
        return [];
    };
}

/**
 * @param {string} nodeKeyString
 * @returns {import("../src/generators/incremental_graph/journal").NodeKey}
 */
function nodeKeyOf(nodeKeyString) {
    return JSON.parse(nodeKeyString);
}

/**
 * A distinct physical identifier per node, so a generated history does not
 * present two live nodes under one identifier. Two present nodes which do select
 * one identifier is unsupported current state, and it has its own test rather
 * than being smuggled in through the generator.
 * @param {string} nodeKeyString
 * @returns {import("../src/generators/incremental_graph/database/types").NodeIdentifier}
 */
function identifierOf(nodeKeyString) {
    const argument = JSON.parse(nodeKeyString).args[0].id;
    return String(argument) + "-abcdefghi";
}

/**
 * The textual form of a value id, which the oracle holds as a `JournalRecordId`
 * and the declarative model already reduced to text.
 * @param {string | import("../src/generators/incremental_graph/journal").JournalRecordId} valueId
 * @returns {string}
 */
function valueIdText(valueId) {
    return typeof valueId === "string" ? valueId : journalRecordIdToString(valueId);
}

/**
 * Reduce a projection to a comparable plain value, so a disagreement names the
 * node and the field rather than comparing object identities.
 * @param {object} projection
 * @returns {object}
 */
function summarize(projection) {
    return {
        lastNodeIndex: projection.lastNodeIndex,
        occurrences: projection.occurrences.map((occurrence) => ({
            nodeKeyString: occurrence.nodeKeyString,
            valueId: valueIdText(occurrence.valueId),
            nodeIdentifier: occurrence.nodeIdentifier,
            createdAt: occurrence.createdAt,
            modifiedAt: occurrence.modifiedAt,
            fresh: occurrence.fresh,
            validInputs: [...occurrence.validInputs].sort(),
        })),
    };
}

/**
 * Every way in which the two models disagree, named field by field.
 * @param {object} oracleProjection
 * @param {object} declarativeProjection
 * @returns {string[]}
 */
function disagreementsBetween(oracleProjection, declarativeProjection) {
    const left = summarize(oracleProjection);
    const right = summarize(declarativeProjection);
    /** @type {string[]} */
    const differences = [];
    if (left.lastNodeIndex !== right.lastNodeIndex) {
        differences.push(
            "lastNodeIndex: oracle " + left.lastNodeIndex + " vs declarative " + right.lastNodeIndex
        );
    }
    const leftKeys = left.occurrences.map((occurrence) => occurrence.nodeKeyString);
    const rightKeys = right.occurrences.map((occurrence) => occurrence.nodeKeyString);
    if (leftKeys.join(",") !== rightKeys.join(",")) {
        differences.push(
            "present keys: oracle [" +
                leftKeys.join(" ") +
                "] vs declarative [" +
                rightKeys.join(" ") +
                "]"
        );
    }
    const shared = Math.min(left.occurrences.length, right.occurrences.length);
    for (let index = 0; index < shared; index++) {
        const mine = left.occurrences[index];
        const theirs = right.occurrences[index];
        const fields = ["valueId", "nodeIdentifier", "createdAt", "modifiedAt", "fresh"];
        for (const field of fields) {
            if (mine[field] !== theirs[field]) {
                differences.push(
                    mine.nodeKeyString +
                        "." +
                        field +
                        ": oracle " +
                        mine[field] +
                        " vs declarative " +
                        theirs[field]
                );
            }
        }
        if (mine.validInputs.join(",") !== theirs.validInputs.join(",")) {
            differences.push(
                mine.nodeKeyString +
                    ".validInputs: oracle [" +
                    mine.validInputs.join(" ") +
                    "] vs declarative [" +
                    theirs.validInputs.join(" ") +
                    "]"
            );
        }
    }
    return differences;
}

/**
 * A generated history over three writers, built so every context is the exact
 * complete observed prefix, which is what makes it a supported journal.
 *
 * The generator produces the cases the two models could disagree about: competing
 * value and delete events on one node, partial and stale bases, and all three
 * invalidation scopes, including proof barriers for inputs a certificate does not
 * name.
 * @param {number} seed
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function generateHistory(seed) {
    const random = makeRandom(seed);
    /** @type {Map<string, number>} */
    const nextSequence = new Map(WRITER_NAMES.map((name) => [name, 0]));
    /** @type {Record<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const streams = Object.fromEntries(WRITER_NAMES.map((name) => [name, []]));
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").ValueEvent[]>} */
    const valueHistory = new Map();
    const schema = schemaOf([KEY_B, KEY_C]);
    let physical = 1000;

    /**
     * The complete committed retained frontier one record would observe, which is
     * the exact own-writer prefix plus every other writer's retained head.
     * @param {string} writerName
     * @returns {Array<Array<string>>}
     */
    function observedCoordinates(writerName) {
        const coordinates = [];
        for (const name of WRITER_NAMES) {
            const sequence = nextSequence.get(name);
            if (sequence > 0) {
                coordinates.push([name, String(sequence)]);
            }
        }
        void writerName;
        return coordinates;
    }

    /**
     * The most recent value occurrence of a node which the frontier has already
     * observed, so a reference this generation authors is one the record layer
     * accepts.
     * @param {string} nodeKeyString
     * @param {import("../src/generators/incremental_graph/journal").JournalFrontier} observed
     * @returns {import("../src/generators/incremental_graph/journal").ValueEvent | undefined}
     */
    function observedValueOf(nodeKeyString, observed) {
        const history = valueHistory.get(nodeKeyString);
        if (history === undefined) {
            return undefined;
        }
        let latest;
        for (const candidate of history) {
            const coordinate = journalSequenceAtFrontier(observed, candidate.id.author);
            if (compareJournalSequence(candidate.id.sequence, coordinate) <= 0) {
                latest = candidate;
            }
        }
        return latest;
    }

    for (let step = 0; step < 18; step++) {
        const writerName = WRITER_NAMES[Math.floor(random() * WRITER_NAMES.length)];
        const nodeKey = NODES[Math.floor(random() * NODES.length)];
        const nodeKeyString = nodeKeyToCanonicalString(nodeKey);
        const observed = contextOf(observedCoordinates(writerName));
        physical += 10;
        const authorityTime = authorityOf(physical, step);
        const kind = random();
        /** @type {import("../src/generators/incremental_graph/journal").JournalRecord | undefined} */
        let record;
        if (kind < 0.3) {
            const sequence = (nextSequence.get(writerName) ?? 0) + 1;
            record = makeValueEvent(
                {
                    id: writerName + ":" + sequence,
                    context: observed,
                    authorityTime,
                    node: nodeKey,
                },
                identifierOf(nodeKeyString),
                { type: "entry_description", description: "v" + step },
                NOW,
                LATER,
                "compute"
            );
        } else if (kind < 0.42) {
            const sequence = (nextSequence.get(writerName) ?? 0) + 1;
            record = makeDeleteEvent(
                {
                    id: writerName + ":" + sequence,
                    context: observed,
                    authorityTime,
                    node: nodeKey,
                },
                "operation"
            );
        } else if (kind < 0.68) {
            const target = observedValueOf(nodeKeyString, observed);
            if (target === undefined) {
                continue;
            }
            const entries = [];
            for (const inputKeyString of schema(nodeKeyString)) {
                if (random() < 0.25) {
                    continue;
                }
                const input = observedValueOf(inputKeyString, observed);
                if (input === undefined) {
                    continue;
                }
                entries.push(makeValidationBasisEntry(nodeKeyOf(inputKeyString), input.id));
            }
            if (entries.length === 0) {
                continue;
            }
            const sequence = (nextSequence.get(writerName) ?? 0) + 1;
            record = makeValidateEvent(
                {
                    id: writerName + ":" + sequence,
                    context: observed,
                    authorityTime,
                    node: nodeKey,
                },
                target.id,
                entries,
                "compute"
            );
        } else if (kind < 0.86) {
            const scopeChoice = random();
            const sequence = (nextSequence.get(writerName) ?? 0) + 1;
            const base = {
                id: writerName + ":" + sequence,
                context: observed,
                authorityTime,
                node: nodeKey,
            };
            if (scopeChoice < 0.4) {
                record = makeInvalidateEvent(base, makeNodeScope(), "explicit");
            } else {
                const target = observedValueOf(nodeKeyString, observed);
                if (target === undefined) {
                    continue;
                }
                const targetId = journalRecordIdToString(target.id);
                if (scopeChoice < 0.7) {
                    record = makeInvalidateEvent(base, makeValueScope(targetId), "propagated");
                } else {
                    const inputs = schema(nodeKeyString);
                    const inputKeyString = inputs[Math.floor(random() * inputs.length)];
                    if (inputKeyString === undefined) {
                        continue;
                    }
                    record = makeInvalidateEvent(
                        base,
                        makeProofScope(targetId, nodeKeyOf(inputKeyString)),
                        "reset"
                    );
                }
            }
        } else {
            const sequence = (nextSequence.get(writerName) ?? 0) + 1;
            const record2 = makeWriterStateRecord(writerName + ":" + sequence, step);
            if (record2 instanceof Error) {
                continue;
            }
            record = record2;
        }
        if (record === undefined || record instanceof Error) {
            continue;
        }
        nextSequence.set(writerName, (nextSequence.get(writerName) ?? 0) + 1);
        streams[writerName].push(record);
        if (isValueEvent(record)) {
            const history = valueHistory.get(nodeKeyString) ?? [];
            history.push(record);
            valueHistory.set(nodeKeyString, history);
        }
    }
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    const all = [];
    for (const writerName of WRITER_NAMES) {
        for (const record of streams[writerName]) {
            all.push(record);
        }
    }
    return all;
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalRecordIdToString(record.id).split(":")[0];
        const list = byWriter.get(name) ?? [];
        list.push(record);
        byWriter.set(name, list);
    }
    return makeJournalReplica(
        WRITER_NAMES.map((name) => [makeJournalAuthor(name), byWriter.get(name) ?? []])
    );
}

/**
 * Two nodes which are each present, each self-validated with an empty basis, and
 * which depend on nothing.
 *
 * Under the current schema both are fresh, because an empty basis is the complete
 * current input set of a zero-input node. Told instead that A depends on B, a
 * model can no longer use A's empty-basis certificate as current-shape-compatible
 * proof, so A is no longer fresh. That is the difference the schema test needs,
 * and it is a difference about current-shape compatibility alone.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function twoZeroInputProvenNodes() {
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    const records = [];
    let sequence = 0;
    for (const nodeKey of [NODE_A, NODE_B]) {
        sequence++;
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf(sequence === 1 ? [] : [["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(100 * sequence, 0),
                node: nodeKey,
            },
            identifierOf(nodeKeyToCanonicalString(nodeKey)),
            { type: "entry_description", description: "n" + sequence },
            NOW,
            LATER,
            "compute"
        );
        sequence++;
        const validate = makeValidateEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(100 * sequence, 0),
                node: nodeKey,
            },
            value.id,
            [],
            "compute"
        );
        records.push(value, validate);
    }
    return records;
}

/**
 * Two nodes, each present with a certificate proving exactly the other, so that
 * making the schema cyclic forces freshness resolution to re-enter a node it is
 * already resolving.
 * @returns {import("../src/generators/incremental_graph/journal").JournalRecord[]}
 */
function twoNodeProvenPair() {
    const valueA = makeValueEvent(
        {
            id: "aaaaaaaaa:1",
            context: contextOf([]),
            authorityTime: authorityOf(100, 0),
            node: NODE_A,
        },
        identifierOf(KEY_A),
        { type: "entry_description", description: "a" },
        NOW,
        LATER,
        "compute"
    );
    const valueB = makeValueEvent(
        {
            id: "aaaaaaaaa:2",
            context: contextOf([["aaaaaaaaa", "1"]]),
            authorityTime: authorityOf(200, 0),
            node: NODE_B,
        },
        identifierOf(KEY_B),
        { type: "entry_description", description: "b" },
        NOW,
        LATER,
        "compute"
    );
    const validateA = makeValidateEvent(
        {
            id: "aaaaaaaaa:3",
            context: contextOf([["aaaaaaaaa", "2"]]),
            authorityTime: authorityOf(300, 0),
            node: NODE_A,
        },
        "aaaaaaaaa:1",
        [makeValidationBasisEntry(NODE_B, valueB.id)],
        "compute"
    );
    const validateB = makeValidateEvent(
        {
            id: "aaaaaaaaa:4",
            context: contextOf([["aaaaaaaaa", "3"]]),
            authorityTime: authorityOf(400, 0),
            node: NODE_B,
        },
        "aaaaaaaaa:2",
        [makeValidationBasisEntry(NODE_A, valueA.id)],
        "compute"
    );
    return [valueA, valueB, validateA, validateB];
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} schema
 * @returns {object}
 */
function projectBothWays(records, schema) {
    const replica = replicaOf(records);
    const oracle = projectRetainedJournal({
        source: makeReplicaSource(replica),
        localWriter: WRITER_A,
        currentInputKeysOfNode: schema,
    });
    const declarative = declarativeProject(replica, "aaaaaaaaa", schema);
    if (oracle instanceof Error) {
        return {
            oracleRejected: true,
            declarative,
            differences: declarative.publishable
                ? ["the oracle rejected with " + oracle.name + " but the declarative model published"]
                : [],
        };
    }
    return {
        oracleRejected: false,
        declarative,
        differences: declarative.publishable
            ? disagreementsBetween(oracle, declarative)
            : ["the declarative model declined to publish, but the oracle did"],
    };
}

describe("the streaming project oracle against a declarative reference", () => {
    test("generated histories agree with the declarative model, on acceptance too", () => {
        const schema = schemaOf([KEY_B, KEY_C]);
        const seeds = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597];
        let compared = 0;
        for (const seed of seeds) {
            const { differences, declarative } = projectBothWays(generateHistory(seed), schema);
            expect({ seed, differences }).toEqual({ seed, differences: [] });
            if (declarative.publishable) {
                compared++;
            }
        }
        expect(compared).toBeGreaterThan(0);
    });

    test("the generator really produces all three invalidation scopes", () => {
        const scopes = new Set();
        for (const seed of [1, 2, 3, 5, 8, 13]) {
            for (const record of generateHistory(seed)) {
                if (record.kind === "invalidate") {
                    scopes.add(record.scope.kind);
                }
            }
        }
        expect([...scopes].sort()).toEqual(["node", "proof", "value"]);
    });
});

describe("the three structural properties follow from the prefix-union merge", () => {
    test("a hole in a writer prefix is reported by the merge", () => {
        const records = generateHistory(3);
        const withHole = records.filter(
            (record) => journalRecordIdToString(record.id) !== "aaaaaaaaa:2"
        );
        const source = makeReplicaSource(replicaOf(withHole));
        const projection = projectRetainedJournal({
            source,
            localWriter: WRITER_A,
            currentInputKeysOfNode: schemaOf([KEY_B, KEY_C]),
        });
        expect(isJournalGapError(projection)).toBe(true);
        expect(String(projection.message)).toMatch(/aaaaaaaaa:2/);
    });

    test("a source which claims a length past the end of its own prefix is a gap", () => {
        // The single-source reader bounds its walk by the claimed retained length
        // in the other direction too. A source which says "writer A retains
        // through A:4" and then delivers only A:1 must not be treated as a whole
        // prefix of length one, because a later record could legitimately be
        // authored into the coordinate it failed to deliver.
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const underReporting = {
            writers: () => [WRITER_A],
            retainedLengthOf: () => makeJournalSequence("4"),
            prefixReaderOf: () => readerOverIterable("aaaaaaaaa", [value], makeJournalSequence("4")),
        };
        const projection = projectRetainedJournal({
            source: underReporting,
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        expect(isJournalGapError(projection)).toBe(true);
        expect(String(projection.message)).toMatch(/aaaaaaaaa:2/);
    });

    test("two prefixes disagreeing at one coordinate are reported as a fork", () => {
        const records = generateHistory(5);
        const left = records.filter((record) => journalRecordIdToString(record.id).startsWith("aaaaaaaaa:"));
        const right = left.map((record) => {
            if (journalRecordIdToString(record.id) !== "aaaaaaaaa:2") {
                return record;
            }
            return makeValueEvent(
                {
                    id: "aaaaaaaaa:2",
                    context: record.context,
                    authorityTime: record.authorityTime,
                    node: record.node,
                },
                "1-abcdefghi",
                { type: "entry_description", description: "different" },
                NOW,
                LATER,
                "compute"
            );
        });
        const source = makeUnionSource([
            makeReplicaSource(replicaOf(left)),
            makeReplicaSource(replicaOf(right)),
        ]);
        const projection = projectRetainedJournal({
            source,
            localWriter: WRITER_A,
            currentInputKeysOfNode: schemaOf([KEY_B, KEY_C]),
        });
        expect(isJournalForkError(projection)).toBe(true);
    });

    test("agreeing prefixes union without a fork and project the same either way", () => {
        const records = generateHistory(8);
        // One replica retains only writer A's prefix; the other retains all three.
        // The union is then the whole journal, and its overlap agrees.
        const left = records.filter((record) => journalRecordIdToString(record.id).startsWith("aaaaaaaaa:"));
        const right = records;
        const schema = schemaOf([KEY_B, KEY_C]);
        const union = projectRetainedJournal({
            source: makeUnionSource([
                makeReplicaSource(replicaOf(left)),
                makeReplicaSource(replicaOf(right)),
            ]),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        const whole = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (union instanceof Error || whole instanceof Error) {
            throw new Error("an agreeing prefix union was rejected");
        }
        expect(disagreementsBetween(union, whole)).toEqual([]);
    });

    test("a context claiming a coordinate past a writer's retained end is rejected", () => {
        // The claiming writer retains only A:1, but the context claims A:2. This
        // is the case a retained-range check which only looked for a wholly
        // unknown writer would miss, and it is the one the source's retained
        // lengths exist to decide.
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([value])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        if (projection instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + projection.message);
        }
        const second = makeValueEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const beyondEnd = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([value, second])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        expect(isJournalCausalClosureError(beyondEnd)).toBe(true);
        expect(String(beyondEnd.message)).toMatch(/aaaaaaaaa:2/);
    });

    test("a context claiming a writer which retains nothing is rejected", () => {
        const context = contextOf([
            ["aaaaaaaaa", "1"],
            ["bbbbbbbbb", "900"],
        ]);
        const record = makeDeleteEvent(
            { id: "ccccccccc:1", context, authorityTime: authorityOf(5000, 0), node: NODE_A },
            "operation"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([record])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schemaOf([KEY_B, KEY_C]),
        });
        expect(isJournalCausalClosureError(projection)).toBe(true);
    });

    test("an own-writer context which is not the exact prefix is rejected", () => {
        const first = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(4000, 0),
                node: NODE_A,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "v1" },
            NOW,
            LATER,
            "compute"
        );
        // A:2 exists, so A:1 is retained, but A:2 claims to have observed nothing.
        const second = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([]),
                authorityTime: authorityOf(5000, 0),
                node: NODE_B,
            },
            "2-abcdefghi",
            { type: "entry_description", description: "v2" },
            NOW,
            LATER,
            "compute"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([first, second])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        expect(isJournalCausalClosureError(projection)).toBe(true);
    });
});

describe("the oracle reads replay, not a transcription of it", () => {
    test("the two models disagree when the declarative model is given a wrong schema", () => {
        const records = twoZeroInputProvenNodes();
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        expect(oracle.occurrences).toHaveLength(2);
        expect(oracle.occurrences.map((o) => o.fresh)).toEqual([true, true]);

        const wrongSchema = declarativeProject(
            replicaOf(records),
            "aaaaaaaaa",
            (nodeKeyString) => (nodeKeyString === KEY_A ? [KEY_B] : [])
        );
        const differences = disagreementsBetween(oracle, wrongSchema);
        expect(differences.length).toBeGreaterThan(0);
        // The disagreement must name a node and a field, not merely "not equal".
        expect(differences.join(" ")).toMatch(KEY_A);
        expect(differences.join(" ")).toMatch(/fresh|validInputs/);
    });

    test("the oracle reports a cyclic current schema as a projection failure", () => {
        // A and B are each present and each fully proven against the other, so
        // resolving freshness genuinely re-enters A. The specification defines
        // freshness recursively over a DAG, so a cycle has no defined answer and
        // the oracle reports it instead of inventing one.
        const records = twoNodeProvenPair();
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: (nodeKeyString) => {
                if (nodeKeyString === KEY_A) {
                    return [KEY_B];
                }
                if (nodeKeyString === KEY_B) {
                    return [KEY_A];
                }
                return [];
            },
        });
        expect(isJournalProjectionError(projection)).toBe(true);
        expect(String(projection.message)).toMatch(/cyclic/);
    });

    test("the oracle reports a non-dependency-closed head set rather than projecting it", () => {
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(10, 0),
                node: NODE_A,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([valueA])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schemaOf([KEY_B, KEY_C]),
        });
        expect(isJournalProjectionError(projection)).toBe(true);
    });

    test("a retained union can be self-proof-ready and stale, and the oracle names it", () => {
        // `incremental-graph-journal-replay.md` §Persistent propagated staleness
        // states the committed implication `selfProofReady(K) => fresh(K)` and
        // then says the value-scoped marker rule which maintains it is
        // "procedural, not a second committed-state implication": a raw retained
        // union need not satisfy it, because the authoring path adds the marker.
        //
        // So the oracle reports the nodes which break the implication rather than
        // assuming they cannot exist. Asserting the implication here would be
        // asserting something the specification says only supported committed
        // states satisfy.
        const schema = schemaOf([KEY_B, KEY_C]);
        /** @type {string[]} */
        const reported = [];
        for (const seed of [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233, 377, 610, 987, 1597]) {
            const projection = projectRetainedJournal({
                source: makeReplicaSource(replicaOf(generateHistory(seed))),
                localWriter: WRITER_A,
                currentInputKeysOfNode: schema,
            });
            if (projection instanceof Error) {
                continue;
            }
            for (const nodeKeyString of projection.selfProofReadyNodes) {
                const occurrence = projection.occurrences.find(
                    (candidate) => candidate.nodeKeyString === nodeKeyString
                );
                expect(occurrence).toBeDefined();
                if (occurrence.fresh) {
                    continue;
                }
                // Every reported node is self-proof-ready and stale only through
                // its direct inputs, which is exactly the situation the
                // pre-marker authoring rule describes.
                reported.push(seed + ":" + nodeKeyString);
                expect(projection.unmarkedPropagatedStaleness.has(nodeKeyString)).toBe(true);
            }
        }
        // A raw union really does contain this case, so the reporting path is
        // exercised rather than being dead code.
        expect(reported.length).toBeGreaterThan(0);
    });

    test("a supported committed history reports no unmarked propagated staleness", () => {
        // The two hand-built histories below are what an ordinary local operation
        // produces: a value, then a validation which observes it. There is no
        // concurrent marker to add, so the committed implication holds and the
        // reporting set is empty.
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const validate = makeValidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([value, validate])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        if (projection instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + projection.message);
        }
        expect([...projection.unmarkedPropagatedStaleness]).toEqual([]);
    });

    test("a certificate which covers the current-value invalidation wins over greater authority", () => {
        // `incremental-graph-journal-testing.md` §Certificate-selection regression.
        //
        //   R2: I = Invalidate(K, scope=value(V))
        //   R2: C2 = Validate(K, V, full basis), causally after I
        //   R1 concurrently: C1 = Validate(K, V, same full basis), greater
        //                      authority, does not observe I
        //
        // C2 must win, because `coversValueInvalidations` precedes
        // `authorityCompare` in the selection order.
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        // C1 is authored by B and observes A:1, so it is concurrent with I.
        const certificateNotObserving = makeValidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const invalidation = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            makeValueScope("aaaaaaaaa:1"),
            "propagated"
        );
        // C2 observes the invalidation, so it covers the current value.
        const certificateObserving = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"], ["bbbbbbbbb", "1"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const records = [value, certificateNotObserving, invalidation, certificateObserving];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        // A is zero-input, so C2 proves the complete current basis and covers the
        // marker, which is exactly why it is the fresh one.
        expect(oracle.occurrences[0].fresh).toBe(true);
        expect(oracle.selfProofReadyNodes.has(KEY_A)).toBe(true);

        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", () => []);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("a proof barrier removes exactly its own edge and no other", () => {
        // `incremental-graph-journal-testing.md` §Invalidation-scope tests: a
        // barrier for (V, A) must not suppress the certificate's B edge, and must
        // not affect a certificate for a replacement ValueId.
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const inputA = makeValueEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a2" },
            NOW,
            LATER,
            "compute"
        );
        // A fresh occurrence with a full two-input basis, both effective.
        const valueA2 = makeValueEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a3" },
            NOW,
            LATER,
            "compute"
        );
        const validateBoth = makeValidateEvent(
            {
                id: "aaaaaaaaa:5",
                context: contextOf([["aaaaaaaaa", "4"]]),
                authorityTime: authorityOf(500, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:4",
            [
                makeValidationBasisEntry(NODE_A, valueA2.id),
                makeValidationBasisEntry(NODE_B, valueB.id),
            ],
            "compute"
        );
        const barrier = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:6",
                context: contextOf([["aaaaaaaaa", "5"]]),
                authorityTime: authorityOf(600, 0),
                node: NODE_A,
            },
            makeProofScope("aaaaaaaaa:4", NODE_A),
            "reset"
        );
        const schema = (nodeKeyString) =>
            nodeKeyString === KEY_B ? [KEY_A] : nodeKeyString === KEY_A ? [KEY_B] : [];
        const records = [valueA, valueB, inputA, valueA2, validateBoth, barrier];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeB = oracle.occurrences.find((o) => o.nodeKeyString === KEY_B);
        // B's input A is the current occurrence, and the barrier names A as B's
        // input, so B's A edge is suppressed and B is not fresh.
        expect([...nodeB.validInputs]).toEqual([]);
        expect(nodeB.fresh).toBe(false);
        expect(disagreementsBetween(oracle, declarativeProject(replicaOf(records), "aaaaaaaaa", schema))).toEqual([]);
    });

    test("a proof barrier suppresses one edge of a two-input basis and leaves the other", () => {
        // A schema with two independent zero-input nodes B and C, and a dependent
        // A which depends on both. A's certificate proves both, so its basis has
        // two effective entries; a barrier for (V, B) must remove exactly B's edge
        // and leave C's edge in place. A model which treated a barrier as a
        // whole-certificate verdict would return no edges at all here, and one
        // which ignored barriers would return both.
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const valueC = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_C,
            },
            identifierOf(KEY_C),
            { type: "entry_description", description: "c" },
            NOW,
            LATER,
            "compute"
        );
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const validateA = makeValidateEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:3",
            [
                makeValidationBasisEntry(NODE_B, valueB.id),
                makeValidationBasisEntry(NODE_C, valueC.id),
            ],
            "compute"
        );
        const barrier = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:5",
                context: contextOf([["aaaaaaaaa", "4"]]),
                authorityTime: authorityOf(500, 0),
                node: NODE_A,
            },
            makeProofScope("aaaaaaaaa:3", NODE_B),
            "reset"
        );
        const schema = (nodeKeyString) => {
            if (nodeKeyString === KEY_A) {
                return [KEY_B, KEY_C];
            }
            return [];
        };
        const records = [valueB, valueC, valueA, validateA, barrier];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeA = oracle.occurrences.find((o) => o.nodeKeyString === KEY_A);
        // B's edge is retired, C's survives.
        expect([...nodeA.validInputs]).toEqual([KEY_C]);
        // The basis is incomplete, so the node is not self-proof-ready and not
        // fresh, even though the surviving edge is present.
        expect(nodeA.fresh).toBe(false);
        expect(oracle.selfProofReadyNodes.has(KEY_A)).toBe(false);
        expect(disagreementsBetween(oracle, declarativeProject(replicaOf(records), "aaaaaaaaa", schema))).toEqual(
            []
        );
    });

    test("a proof barrier does not affect a certificate for a replacement occurrence", () => {
        // `incremental-graph-journal-testing.md` §Invalidvalidation-scope tests: a
        // barrier for (V1, B) must not affect a certificate for a later V2 merely
        // because V2 names the same node.
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const firstA = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a1" },
            NOW,
            LATER,
            "compute"
        );
        const barrier = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            makeProofScope("aaaaaaaaa:2", NODE_B),
            "reset"
        );
        const secondA = makeValueEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a2" },
            NOW,
            LATER,
            "compute"
        );
        const validateB = makeValidateEvent(
            {
                id: "aaaaaaaaa:6",
                context: contextOf([["aaaaaaaaa", "5"]]),
                authorityTime: authorityOf(600, 0),
                node: NODE_B,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const validateSecond = makeValidateEvent(
            {
                id: "aaaaaaaaa:5",
                context: contextOf([["aaaaaaaaa", "4"]]),
                authorityTime: authorityOf(500, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:4",
            [makeValidationBasisEntry(NODE_B, valueB.id)],
            "compute"
        );
        const schema = (nodeKeyString) => (nodeKeyString === KEY_A ? [KEY_B] : []);
        const records = [valueB, firstA, barrier, secondA, validateSecond, validateB];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeA = oracle.occurrences.find((o) => o.nodeKeyString === KEY_A);
        expect([...nodeA.validInputs]).toEqual([KEY_B]);
        expect(nodeA.fresh).toBe(true);
        expect(disagreementsBetween(oracle, declarativeProject(replicaOf(records), "aaaaaaaaa", schema))).toEqual(
            []
        );
    });

    test("authority breaks the tie between two equally applicable certificates", () => {
        // Two eligible certificates for the same occurrence, both proving the
        // complete current input set, neither covering a current-value marker:
        // the only difference is authority. The greater-authority one must be
        // selected, so a model which stopped at the first two ordering keys would
        // return the wrong occurrence proof and the wrong validity edge.
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        // C_low observes A:2 and proves the same complete basis, at low authority.
        const lowAuthority = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:2",
            [makeValidationBasisEntry(NODE_B, valueB.id)],
            "compute"
        );
        // C_high proves the same basis with the same current input occurrence, at
        // greater authority. It is concurrent with C_low and does not observe it.
        const highAuthority = makeValidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:2",
            [makeValidationBasisEntry(NODE_B, valueB.id)],
            "compute"
        );
        const validateB = makeValidateEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"], ["bbbbbbbbb", "1"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_B,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const schema = (nodeKeyString) => (nodeKeyString === KEY_A ? [KEY_B] : []);
        const records = [valueB, valueA, lowAuthority, highAuthority, validateB];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        // Both models publish, and both must select the greater-authority
        // certificate, which the differential confirms only if the comparison is
        // reached at all.
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(declarative.publishable).toBe(true);
        const nodeA = oracle.occurrences.find((o) => o.nodeKeyString === KEY_A);
        expect([...nodeA.validInputs]).toEqual([KEY_B]);
        expect(nodeA.fresh).toBe(true);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("two present nodes selecting one physical identifier are unsupported state", () => {
        // `incremental-graph-journal-replay.md` §Physical identifier consistency:
        // if two distinct present NodeKeys nevertheless select the same physical
        // NodeIdentifier, projection fails as unsupported/corrupt current state.
        // Replay does not resolve it and does not scan history to decide.
        const first = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const second = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_B,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([first, second])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        expect(isJournalProjectionError(projection)).toBe(true);
        expect(String(projection.message)).toMatch(/same physical node identifier/);
    });

    test("authority selects between two certificates which differ only in which edge a barrier retired", () => {
        // `incremental-graph-journal-testing.md` §Reset losing-certificate proof
        // exposure. Two eligible certificates for one occurrence, each with an
        // effective basis of exactly one edge: C1 keeps A's edge, C2 keeps B's.
        // They tie on the first two ordering keys, so only `authorityCompare`
        // separates them, and the selected edge is the observable consequence.
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const valueK = makeValueEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_D,
            },
            identifierOf(KEY_D),
            { type: "entry_description", description: "k" },
            NOW,
            LATER,
            "compute"
        );
        const basis = [
            makeValidationBasisEntry(NODE_A, valueA.id),
            makeValidationBasisEntry(NODE_B, valueB.id),
        ];
        // A barrier for (V, A) which C1 observes and C2 does not.
        const barrier = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_D,
            },
            makeProofScope("aaaaaaaaa:3", NODE_A),
            "reset"
        );
        // C_high observes the barrier, so A's edge is retired and B's survives.
        const highAuthority = makeValidateEvent(
            {
                id: "aaaaaaaaa:5",
                context: contextOf([["aaaaaaaaa", "4"]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_D,
            },
            "aaaaaaaaa:3",
            basis,
            "compute"
        );
        // C_low does not observe the barrier, so both of its edges are effective
        // and it wins on basis strength instead of on authority.
        const lowAuthority = makeValidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(500, 0),
                node: NODE_D,
            },
            "aaaaaaaaa:3",
            basis,
            "compute"
        );
        const schema = (nodeKeyString) => {
            if (nodeKeyString === KEY_D) {
                return [KEY_A, KEY_B];
            }
            if (nodeKeyString === KEY_B) {
                return [KEY_A];
            }
            return [];
        };
        const records = [valueA, valueB, valueK, barrier, highAuthority, lowAuthority];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeD = oracle.occurrences.find((o) => o.nodeKeyString === KEY_D);
        // Basis strength is the first key, so C_low's two effective edges beat
        // C_high's one even though C_high has far greater authority.
        expect([...nodeD.validInputs].sort()).toEqual([KEY_A, KEY_B]);
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(declarative.publishable).toBe(true);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("an unknown basis entry contributes no effective edge", () => {
        // A maintenance certificate may legitimately carry `"unknown"` for an
        // input. The specification says `"unknown"` never equals a current
        // ValueId, so it can never prove an edge: the node keeps no proof for
        // that input and is therefore not fresh.
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        // A maintenance reason is required for an "unknown" basis entry.
        const validate = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:2",
            [makeValidationBasisEntry(NODE_B, "unknown")],
            "reset"
        );
        const schema = (nodeKeyString) => (nodeKeyString === KEY_A ? [KEY_B] : []);
        const records = [valueB, valueA, validate];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeA = oracle.occurrences.find((o) => o.nodeKeyString === KEY_A);
        expect([...nodeA.validInputs]).toEqual([]);
        expect(nodeA.fresh).toBe(false);
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("authority decides between two certificates of equal effective basis strength", () => {
        // Two barriers, each observed by exactly one of two concurrent
        // certificates. C1 keeps B's edge, C2 keeps A's, so both have an effective
        // basis of exactly one entry, both cover the same (empty) current-value
        // invalidation set, and neither observes the other. Only `authorityCompare`
        // separates them, so the selected edge is entirely its consequence.
        const valueA = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            identifierOf(KEY_A),
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const valueK = makeValueEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_D,
            },
            identifierOf(KEY_D),
            { type: "entry_description", description: "k" },
            NOW,
            LATER,
            "compute"
        );
        const basis = [
            makeValidationBasisEntry(NODE_A, valueA.id),
            makeValidationBasisEntry(NODE_B, valueB.id),
        ];
        // Each barrier is authored by a *different* writer, and each certificate
        // observes exactly one of them. A certificate which observed both would
        // clear both and have no effective edges, and two barriers on one writer
        // could not be observed independently, because a transitively closed
        // context claiming C:2 also claims C:1.
        const barrierA = makeInvalidateEvent(
            {
                id: "ccccccccc:1",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_D,
            },
            makeProofScope("aaaaaaaaa:3", NODE_A),
            "reset"
        );
        const barrierB = makeInvalidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(500, 0),
                node: NODE_D,
            },
            makeProofScope("aaaaaaaaa:3", NODE_B),
            "reset"
        );
        // C_low does not observe barrierA, so A's edge stays suppressed and it
        // proves B alone.
        const lowAuthority = makeValidateEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"], ["bbbbbbbbb", "1"]]),
                authorityTime: authorityOf(600, 0),
                node: NODE_D,
            },
            "aaaaaaaaa:3",
            basis,
            "compute"
        );
        // C_high does not observe barrierB, so B's edge stays suppressed and it
        // proves A alone, at greater authority.
        const highAuthority = makeValidateEvent(
            {
                id: "aaaaaaaaa:5",
                context: contextOf([["aaaaaaaaa", "4"], ["ccccccccc", "1"]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_D,
            },
            "aaaaaaaaa:3",
            basis,
            "compute"
        );
        const schema = (nodeKeyString) => {
            if (nodeKeyString === KEY_D) {
                return [KEY_A, KEY_B];
            }
            if (nodeKeyString === KEY_B) {
                return [KEY_A];
            }
            return [];
        };
        const records = [valueA, valueB, valueK, barrierA, barrierB, lowAuthority, highAuthority];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeD = oracle.occurrences.find((o) => o.nodeKeyString === KEY_D);
        // Equal basis strength, so the greater-authority certificate C_high wins
        // and the edge it still proves is A's.
        expect([...nodeD.validInputs]).toEqual([KEY_A]);
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(declarative.publishable).toBe(true);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("a basis naming the wrong inputs is not current-shape-compatible", () => {
        // C's current inputs are B and D. One certificate names B and D; another,
        // at greater authority, names B and E, where E is a present node which is
        // not an input of C at all. The second has the right *number* of basis
        // entries and the wrong identities, so it is inspectable history rather
        // than current proof, and the lower-authority compatible one is selected.
        const nodeKeys = [NODE_B, NODE_D, NODE_E];
        /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
        const records = [];
        let sequence = 0;
        /** @type {Map<string, import("../src/generators/incremental_graph/journal").ValueEvent>} */
        const values = new Map();
        for (const nodeKey of nodeKeys) {
            sequence++;
            const value = makeValueEvent(
                {
                    id: "aaaaaaaaa:" + sequence,
                    context: contextOf(sequence === 1 ? [] : [["aaaaaaaaa", String(sequence - 1)]]),
                    authorityTime: authorityOf(100 * sequence, 0),
                    node: nodeKey,
                },
                identifierOf(nodeKeyToCanonicalString(nodeKey)),
                { type: "entry_description", description: "n" + sequence },
                NOW,
                LATER,
                "compute"
            );
            sequence++;
            const validate = makeValidateEvent(
                {
                    id: "aaaaaaaaa:" + sequence,
                    context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                    authorityTime: authorityOf(100 * sequence, 0),
                    node: nodeKey,
                },
                value.id,
                [],
                "compute"
            );
            records.push(value, validate);
            values.set(nodeKeyToCanonicalString(nodeKey), value);
        }
        sequence++;
        const valueC = makeValueEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(100 * sequence, 0),
                node: NODE_C,
            },
            identifierOf(KEY_C),
            { type: "entry_description", description: "c" },
            NOW,
            LATER,
            "compute"
        );
        sequence++;
        // The greater-authority certificate names B and E, and E is not an input.
        const wrongInputs = makeValidateEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_C,
            },
            valueC.id,
            [
                makeValidationBasisEntry(NODE_B, values.get(KEY_B).id),
                makeValidationBasisEntry(NODE_E, values.get(KEY_E).id),
            ],
            "compute"
        );
        sequence++;
        // The lower-authority certificate names exactly the current inputs.
        const rightInputs = makeValidateEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(100 * sequence, 0),
                node: NODE_C,
            },
            valueC.id,
            [
                makeValidationBasisEntry(NODE_B, values.get(KEY_B).id),
                makeValidationBasisEntry(NODE_D, values.get(KEY_D).id),
            ],
            "compute"
        );
        records.push(valueC, wrongInputs, rightInputs);
        const schema = (nodeKeyString) => (nodeKeyString === KEY_C ? [KEY_B, KEY_D] : []);
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeC = oracle.occurrences.find((o) => o.nodeKeyString === KEY_C);
        // Only the compatible certificate's edges are present, and because it
        // proves the complete current input set the node is fresh. Had shape
        // compatibility been ignored, the higher-authority certificate would have
        // won and proved nothing.
        expect([...nodeC.validInputs].sort()).toEqual([KEY_B, KEY_D]);
        expect(nodeC.fresh).toBe(true);
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("a lone certificate naming the wrong inputs proves nothing", () => {
        // C's current inputs are B and D, but the only certificate for C names B
        // and E. E is present and is a real occurrence, so every per-entry check
        // on the entries it does name passes; what fails is that the *set* of
        // named inputs is not the current input set. A check which compared only
        // the size of the two sets would accept it and prove B's edge.
        const nodeKeys = [NODE_B, NODE_D, NODE_E];
        /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
        const records = [];
        /** @type {Map<string, import("../src/generators/incremental_graph/journal").ValueEvent>} */
        const values = new Map();
        let sequence = 0;
        for (const nodeKey of nodeKeys) {
            sequence++;
            const value = makeValueEvent(
                {
                    id: "aaaaaaaaa:" + sequence,
                    context: contextOf(sequence === 1 ? [] : [["aaaaaaaaa", String(sequence - 1)]]),
                    authorityTime: authorityOf(100 * sequence, 0),
                    node: nodeKey,
                },
                identifierOf(nodeKeyToCanonicalString(nodeKey)),
                { type: "entry_description", description: "n" + sequence },
                NOW,
                LATER,
                "compute"
            );
            records.push(value);
            values.set(nodeKeyToCanonicalString(nodeKey), value);
        }
        sequence++;
        const valueC = makeValueEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(100 * sequence, 0),
                node: NODE_C,
            },
            identifierOf(KEY_C),
            { type: "entry_description", description: "c" },
            NOW,
            LATER,
            "compute"
        );
        sequence++;
        const onlyCertificate = makeValidateEvent(
            {
                id: "aaaaaaaaa:" + sequence,
                context: contextOf([["aaaaaaaaa", String(sequence - 1)]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_C,
            },
            valueC.id,
            [
                makeValidationBasisEntry(NODE_B, values.get(KEY_B).id),
                makeValidationBasisEntry(NODE_E, values.get(KEY_E).id),
            ],
            "compute"
        );
        records.push(valueC, onlyCertificate);
        const schema = (nodeKeyString) => (nodeKeyString === KEY_C ? [KEY_B, KEY_D] : []);
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeC = oracle.occurrences.find((o) => o.nodeKeyString === KEY_C);
        expect([...nodeC.validInputs]).toEqual([]);
        expect(nodeC.fresh).toBe(false);
        expect(oracle.selfProofReadyNodes.has(KEY_C)).toBe(false);
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("effective basis strength outranks authority in certificate selection", () => {
        // Two current-shape-compatible certificates for one occurrence. The
        // greater-authority one proves only B (D is "unknown"), the
        // lower-authority one proves B and D. The first ordering key is the
        // effective basis match count, so the complete proof wins despite losing
        // on authority; dropping that key would let the greater-authority partial
        // proof win and lose D's edge.
        const valueB = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_B,
            },
            identifierOf(KEY_B),
            { type: "entry_description", description: "b" },
            NOW,
            LATER,
            "compute"
        );
        const valueD = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_D,
            },
            identifierOf(KEY_D),
            { type: "entry_description", description: "d" },
            NOW,
            LATER,
            "compute"
        );
        const valueK = makeValueEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_C,
            },
            identifierOf(KEY_C),
            { type: "entry_description", description: "k" },
            NOW,
            LATER,
            "compute"
        );
        // The partial proof, at greater authority. A maintenance reason is
        // required for an "unknown" basis entry.
        const partial = makeValidateEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(9000, 0),
                node: NODE_C,
            },
            valueK.id,
            [
                makeValidationBasisEntry(NODE_B, valueB.id),
                makeValidationBasisEntry(NODE_D, "unknown"),
            ],
            "reset"
        );
        // The complete proof, at lower authority.
        const complete = makeValidateEvent(
            {
                id: "aaaaaaaaa:5",
                context: contextOf([["aaaaaaaaa", "4"]]),
                authorityTime: authorityOf(400, 0),
                node: NODE_C,
            },
            valueK.id,
            [
                makeValidationBasisEntry(NODE_B, valueB.id),
                makeValidationBasisEntry(NODE_D, valueD.id),
            ],
            "compute"
        );
        const schema = (nodeKeyString) => (nodeKeyString === KEY_C ? [KEY_B, KEY_D] : []);
        const records = [valueB, valueD, valueK, partial, complete];
        const oracle = projectRetainedJournal({
            source: makeReplicaSource(replicaOf(records)),
            localWriter: WRITER_A,
            currentInputKeysOfNode: schema,
        });
        if (oracle instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + oracle.message);
        }
        const nodeC = oracle.occurrences.find((o) => o.nodeKeyString === KEY_C);
        expect([...nodeC.validInputs].sort()).toEqual([KEY_B, KEY_D]);
        // The node is not fresh, because its inputs B and D carry no certificate
        // of their own; that is recursive freshness working, and is why the
        // selection is read from the validity edges rather than from freshness.
        expect(nodeC.fresh).toBe(false);
        const declarative = declarativeProject(replicaOf(records), "aaaaaaaaa", schema);
        expect(disagreementsBetween(oracle, declarative)).toEqual([]);
    });

    test("a value-scoped invalidation a certificate did not observe keeps the node stale", () => {
        // A:a1 validated, then a concurrent value-scoped invalidation of that same
        // occurrence. The stale marker is uncovered, so the node is not fresh even
        // though its own basis is complete.
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const validate = makeValidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const invalidate = makeInvalidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(300, 0),
                node: NODE_A,
            },
            makeValueScope("aaaaaaaaa:1"),
            "propagated"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([value, validate, invalidate])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        if (projection instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + projection.message);
        }
        expect(projection.occurrences).toHaveLength(1);
        expect(projection.occurrences[0].fresh).toBe(false);
        expect(projection.selfProofReadyNodes.has(KEY_A)).toBe(false);
    });

    test("a node whose own basis is complete and uninvalidated is self-proof-ready", () => {
        const value = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(100, 0),
                node: NODE_A,
            },
            "1-abcdefghi",
            { type: "entry_description", description: "a" },
            NOW,
            LATER,
            "compute"
        );
        const validate = makeValidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(200, 0),
                node: NODE_A,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const projection = projectRetainedJournal({
            source: makeReplicaSource(replicaOf([value, validate])),
            localWriter: WRITER_A,
            currentInputKeysOfNode: () => [],
        });
        if (projection instanceof Error) {
            throw new Error("the oracle rejected a supported history: " + projection.message);
        }
        expect(projection.occurrences[0].fresh).toBe(true);
        expect(projection.selfProofReadyNodes.has(KEY_A)).toBe(true);
    });
});
