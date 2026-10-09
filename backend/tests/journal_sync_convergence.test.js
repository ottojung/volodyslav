/**
 * Synchronization convergence: fair-order convergence and the host-count
 * bounded settling schedule.
 *
 * `incremental-graph-journal-sync.md` §Convergence and termination requires
 * that after non-normalization graph-changing operations stop, fair
 * synchronization eventually disseminates actual authored records,
 * participating replicas reach equivalent projections, and further
 * synchronization is a semantic no-op. §Host-count bounded settling schedule
 * requires that a gather-to-one/broadcast-from-one schedule settles within
 * at most 2(H-1) state-advancing successful pairwise synchronizations.
 *
 * Every fixture here is a supported graph plus Journal pair, in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: each
 * replica's records are built by a writer which materializes a node and then
 * validates it against the exact current direct-input occurrences it observed.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeValidateEvent,
    makeValueEvent,
    makeValidationBasisEntry,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const {
    isSyncOutcome,
    SnapshotIdentityClass,
    synchronizeRetainedJournal,
} = require("../src/generators/incremental_graph/journal_sync");

const { makeReplicaSource } = require("../src/generators/incremental_graph/journal/oracle/record_source");

const {
    buildRetainedReplayState,
    isRetainedReplayState,
} = require("../src/generators/incremental_graph/journal_retained");

const NODE_A = { head: "event", args: [{ id: 1 }] };
const NODE_B = { head: "event", args: [{ id: 2 }] };
const NODE_C = { head: "event", args: [{ id: 3 }] };
const KEY_A = nodeKeyToCanonicalString(NODE_A);
const KEY_B = nodeKeyToCanonicalString(NODE_B);
const KEY_C = nodeKeyToCanonicalString(NODE_C);
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;

/**
 * The chain schema `A -> B -> C`. A node with no entry is a node with no direct
 * input, which is what makes it a leaf the freshness recursion can bottom out on.
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    if (nodeKeyString === KEY_B) {
        return [KEY_A];
    }
    if (nodeKeyString === KEY_C) {
        return [KEY_B];
    }
    return [];
}

/**
 * The writer names for H replicas. Each is a valid database fingerprint.
 * @param {number} count
 * @returns {Array<string>}
 */
function writerNames(count) {
    /** @type {Array<string>} */
    const names = [];
    for (let i = 0; i < count; i += 1) {
        names.push(String.fromCharCode(97 + i).repeat(9));
    }
    return names;
}

/**
 * @param {string} nodeKeyString
 */
function identifierOf(nodeKeyString) {
    return JSON.parse(nodeKeyString).args[0].id + "-abcdefghi";
}

/**
 * The coordinates a writer's record at `sequence` observed: what the caller saw
 * plus the writer's own complete already-committed prefix.
 *
 * @param {string} writer
 * @param {string} sequence
 * @param {ReadonlyArray<string>} observed
 * @returns {ReadonlyArray<string>}
 */
function observedUpTo(writer, sequence, observed) {
    const previous = Number(sequence) - 1;
    if (previous === 0) {
        return [...observed];
    }
    return [...observed, [writer, String(previous)]];
}

/**
 * @param {ReadonlyArray<string>} coordinates
 */
function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

/**
 * @param {number} physical
 */
function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
}

/**
 * Fail the fixture at its own construction rather than inside the algorithm.
 *
 * @template T
 * @param {T | import("../src/generators/incremental_graph/journal").JournalError} value
 * @returns {T}
 */
function made(value) {
    if (value instanceof Error) {
        throw new Error("the fixture built an invalid record: " + value.message);
    }
    return value;
}

/**
 * The one materialization-and-validation pair of a node, as the writer which
 * produced it retained it.
 *
 * @param {object} occurrence
 * @param {string} occurrence.writer
 * @param {string} occurrence.sequence
 * @param {import("../src/generators/incremental_graph/journal").NodeKey} occurrence.node
 * @param {ReadonlyArray<string>} occurrence.context - The writer-local coordinates the
 *   materialization observed, before its own coordinate.
 * @param {ReadonlyArray<{node: import("../src/generators/incremental_graph/journal").NodeKey, value: string}>} occurrence.basis
 * @returns {Array<import("../src/generators/incremental_graph/journal").JournalRecord>}
 */
function materialize(occurrence) {
    const nodeKey = nodeKeyToCanonicalString(occurrence.node);
    const valueSequence = String(Number(occurrence.sequence) * 2 - 1);
    const validateSequence = String(Number(occurrence.sequence) * 2);
    const valueId = occurrence.writer + ":" + valueSequence;
    const validateId = occurrence.writer + ":" + validateSequence;
    return [
        made(makeValueEvent(
            {
                id: valueId,
                context: contextOf(observedUpTo(occurrence.writer, valueSequence, occurrence.context)),
                authorityTime: authorityOf(Number(valueSequence)),
                node: occurrence.node,
            },
            identifierOf(nodeKey),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )),
        made(makeValidateEvent(
            {
                id: validateId,
                context: contextOf(observedUpTo(occurrence.writer, validateSequence, occurrence.context)),
                authorityTime: authorityOf(Number(validateSequence)),
                node: occurrence.node,
            },
            valueId,
            occurrence.basis,
            "compute"
        )),
    ];
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
 * The receiver's committed writer state after having retained exactly `records`.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {string} localWriter
 * @param {number} authorityPhysical
 */
function committedAfter(records, localWriter, authorityPhysical) {
    const own = records.filter(
        (record) => journalAuthorToString(record.id.author) === localWriter
    );
    const last = own[own.length - 1];
    return {
        localWriter: makeJournalAuthor(localWriter),
        writerHead: last === undefined ? { __value: "0" } : last.id.sequence,
        committedFrontier: contextOf(
            last === undefined ? [] : [[localWriter, last.id.sequence]]
        ),
        authorityHighWater: authorityOf(authorityPhysical),
        allocatorWatermark: 0,
    };
}

/**
 * The activated replica's retained replay state for a receiver's retained journal.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiver
 * @param {string} localWriter
 * @returns {import("../src/generators/incremental_graph/journal_retained").RetainedReplayState}
 */
function retainedStateOf(receiver, localWriter) {
    const built = buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(receiver)),
        localWriter: makeJournalAuthor(localWriter),
        currentInputKeysOfNode: chainInputs,
    });
    if ("error" in built) {
        throw new Error("the receiver's retained state could not be built: " + built.error.message);
    }
    if (!isRetainedReplayState(built.state)) {
        throw new Error("the receiver's retained state is not a retained replay state");
    }
    return built.state;
}

/**
 * A monotonic publication instant source, so no two synchronizations share an
 * authority time.
 */
function makePublicationClock() {
    let instant = INSTANT;
    return () => {
        instant += 1;
        return instant;
    };
}

/**
 * Synchronize one replica from another, returning the outcome.
 *
 * @param {object} options
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.receiver
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} options.source
 * @param {string} options.localWriter
 * @param {number} options.authorityPhysical
 * @param {() => number} options.nextInstant
 * @returns {{outcome: import("../src/generators/incremental_graph/journal_sync").SyncOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}}
 */
function synchronize(options) {
    const identity = new SnapshotIdentityClass("v1", "scheme");
    return synchronizeRetainedJournal({
        receiver: makeReplicaSource(replicaOf(options.receiver)),
        source: makeReplicaSource(replicaOf(options.source)),
        localWriter: makeJournalAuthor(options.localWriter),
        committed: committedAfter(options.receiver, options.localWriter, options.authorityPhysical),
        observedHighWater: authorityOf(options.authorityPhysical),
        publicationInstant: options.nextInstant(),
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: identity,
        sourceIdentity: identity,
        retainedState: retainedStateOf(options.receiver, options.localWriter),
    });
}

/**
 * Assert that a synchronization succeeded, reporting the failure it produced.
 *
 * @param {{outcome: import("../src/generators/incremental_graph/journal_sync").SyncOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}} result
 * @returns {import("../src/generators/incremental_graph/journal_sync").SyncOutcome}
 */
function outcomeOf(result) {
    if (!("outcome" in result)) {
        throw new Error("synchronization failed with " + result.error.name + ": " + result.error.message);
    }
    if (!isSyncOutcome(result.outcome)) {
        throw new Error("the synchronization outcome is not a sync outcome");
    }
    return result.outcome;
}

/**
 * The semantic content of a projection: every present node mapped to its
 * selected occurrence's identity, payload, and freshness.
 *
 * @param {import("../src/generators/incremental_graph/journal/oracle/projection").Projection} projection
 * @returns {Array<[string, string, object, boolean]>}
 */
function projectionSignature(projection) {
    return projection.occurrences
        .map((occurrence) => [
            occurrence.nodeKeyString,
            occurrence.valueId,
            occurrence.payload,
            occurrence.fresh,
        ])
        .sort((left, right) => (left[0] < right[0] ? -1 : 1));
}

/**
 * Whether two projections are semantically equivalent.
 *
 * @param {import("../src/generators/incremental_graph/journal/oracle/projection").Projection} left
 * @param {import("../src/generators/incremental_graph/journal/oracle/projection").Projection} right
 */
function projectionsEquivalent(left, right) {
    const leftSignature = projectionSignature(left);
    const rightSignature = projectionSignature(right);
    if (leftSignature.length !== rightSignature.length) {
        return false;
    }
    for (let i = 0; i < leftSignature.length; i += 1) {
        const a = leftSignature[i];
        const b = rightSignature[i];
        if (a[0] !== b[0] || a[1] !== b[1] || a[3] !== b[3]) {
            return false;
        }
        if (JSON.stringify(a[2]) !== JSON.stringify(b[2])) {
            return false;
        }
    }
    return true;
}

/**
 * The projection of one replica's retained records.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @param {string} localWriter
 * @returns {import("../src/generators/incremental_graph/journal/oracle/projection").Projection}
 */
function projectionOf(records, localWriter) {
    const state = retainedStateOf(records, localWriter);
    const { projectRetainedReplay } = require("../src/generators/incremental_graph/journal_retained");
    const projected = projectRetainedReplay(state);
    if ("error" in projected) {
        throw new Error("the replica's projection failed: " + projected.error.message);
    }
    return projected;
}

/**
 * The node a canonical node key string names, for basis construction.
 *
 * @param {string} nodeKeyString
 * @returns {import("../src/generators/incremental_graph/journal").NodeKey}
 */
function nodeOfKey(nodeKeyString) {
    if (nodeKeyString === KEY_A) {
        return NODE_A;
    }
    if (nodeKeyString === KEY_B) {
        return NODE_B;
    }
    return NODE_C;
}

/**
 * Generate a random quiescent compatible state for H replicas.
 *
 * Each replica has its own writer and a random subset of the three nodes
 * materialized and validated. A node is materialized only when every current
 * direct input the schema requires is already materialized, so the validation
 * basis names occurrences the writer actually retained. The writers' streams
 * are independent, so the state is compatible by Laws 8/8a.
 *
 * @param {number} count - The number of replicas H.
 * @param {() => number} random - A random source returning [0, 1).
 * @returns {Array<{writer: string, records: Array<import("../src/generators/incremental_graph/journal").JournalRecord>}>}
 */
function generateQuiescentState(count, random) {
    const names = writerNames(count);
    return names.map((writer) => {
        /** @type {Array<import("../src/generators/incremental_graph/journal").JournalRecord>} */
        const records = [];
        /** @type {Map<string, string>} */
        const valueIdOfNode = new Map();
        let sequence = 0;
        for (const node of [NODE_A, NODE_B, NODE_C]) {
            if (random() < 0.5) {
                continue;
            }
            const nodeKey = nodeKeyToCanonicalString(node);
            const inputs = chainInputs(nodeKey);
            const basis = [];
            let inputsReady = true;
            for (const inputKey of inputs) {
                const inputValueId = valueIdOfNode.get(inputKey);
                if (inputValueId === undefined) {
                    inputsReady = false;
                    break;
                }
                basis.push(makeValidationBasisEntry(nodeOfKey(inputKey), inputValueId));
            }
            if (!inputsReady) {
                continue;
            }
            sequence += 1;
            records.push(...materialize({
                writer,
                sequence: String(sequence),
                node,
                context: [],
                basis,
            }));
            valueIdOfNode.set(nodeKey, writer + ":" + String(sequence));
        }
        return { writer, records };
    });
}

/**
 * Fair-order convergence: repeatedly synchronize every ordered pair until no
 * synchronization changes any replica.
 *
 * @param {Array<{writer: string, records: Array<import("../src/generators/incremental_graph/journal").JournalRecord>}>} replicas
 * @param {() => number} nextInstant
 * @returns {{rounds: number, totalSyncs: number}}
 */
function convergeFair(replicas, nextInstant) {
    let rounds = 0;
    let totalSyncs = 0;
    let changed = true;
    while (changed) {
        changed = false;
        rounds += 1;
        for (let receiver = 0; receiver < replicas.length; receiver += 1) {
            for (let source = 0; source < replicas.length; source += 1) {
                if (receiver === source) {
                    continue;
                }
                totalSyncs += 1;
                const result = synchronize({
                    receiver: replicas[receiver].records,
                    source: replicas[source].records,
                    localWriter: replicas[receiver].writer,
                    authorityPhysical: 1000 + totalSyncs,
                    nextInstant,
                });
                const outcome = outcomeOf(result);
                if (outcome.stateAdvancing) {
                    replicas[receiver].records = [...replicas[receiver].records, ...outcome.records];
                    changed = true;
                }
            }
        }
    }
    return { rounds, totalSyncs };
}

/**
 * The host-count bounded settling construction: gather to one collector, then
 * broadcast from it.
 *
 * @param {Array<{writer: string, records: Array<import("../src/generators/incremental_graph/journal").JournalRecord>}>} replicas
 * @param {number} collectorIndex
 * @param {() => number} nextInstant
 * @returns {{stateAdvancingCount: number, totalSyncs: number}}
 */
function settlingSchedule(replicas, collectorIndex, nextInstant) {
    let stateAdvancingCount = 0;
    let totalSyncs = 0;
    const count = replicas.length;

    for (let i = 0; i < count; i += 1) {
        if (i === collectorIndex) {
            continue;
        }
        totalSyncs += 1;
        const result = synchronize({
            receiver: replicas[collectorIndex].records,
            source: replicas[i].records,
            localWriter: replicas[collectorIndex].writer,
            authorityPhysical: 2000 + totalSyncs,
            nextInstant,
        });
        const outcome = outcomeOf(result);
        if (outcome.stateAdvancing) {
            stateAdvancingCount += 1;
        }
        replicas[collectorIndex].records = [...replicas[collectorIndex].records, ...outcome.records];
    }

    for (let i = 0; i < count; i += 1) {
        if (i === collectorIndex) {
            continue;
        }
        totalSyncs += 1;
        const result = synchronize({
            receiver: replicas[i].records,
            source: replicas[collectorIndex].records,
            localWriter: replicas[i].writer,
            authorityPhysical: 3000 + totalSyncs,
            nextInstant,
        });
        const outcome = outcomeOf(result);
        if (outcome.stateAdvancing) {
            stateAdvancingCount += 1;
        }
        replicas[i].records = [...replicas[i].records, ...outcome.records];
    }

    return { stateAdvancingCount, totalSyncs };
}

/**
 * A seeded random source for deterministic test generation.
 *
 * @param {number} seed
 * @returns {() => number}
 */
function seededRandom(seed) {
    let state = seed;
    return () => {
        state = (state * 1103515245 + 12345) & 0x7fffffff;
        return state / 0x7fffffff;
    };
}

describe("synchronization convergence", () => {
    test("fair-order synchronization of 2 replicas converges to equivalent projections", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(2, seededRandom(42));
        const { rounds } = convergeFair(replicas, nextInstant);

        expect(rounds).toBeGreaterThan(0);
        const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
        for (let i = 1; i < projections.length; i += 1) {
            expect(projectionsEquivalent(projections[0], projections[i])).toBe(true);
        }
    });

    test("fair-order synchronization of 3 replicas converges to equivalent projections", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(3, seededRandom(1234));
        const { rounds } = convergeFair(replicas, nextInstant);

        expect(rounds).toBeGreaterThan(0);
        const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
        for (let i = 1; i < projections.length; i += 1) {
            expect(projectionsEquivalent(projections[0], projections[i])).toBe(true);
        }
    });

    test("fair-order synchronization of 4 replicas converges to equivalent projections", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(4, seededRandom(9876));
        const { rounds } = convergeFair(replicas, nextInstant);

        expect(rounds).toBeGreaterThan(0);
        const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
        for (let i = 1; i < projections.length; i += 1) {
            expect(projectionsEquivalent(projections[0], projections[i])).toBe(true);
        }
    });

    test("after convergence, every pairwise synchronization is a semantic no-op", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(3, seededRandom(555));
        convergeFair(replicas, nextInstant);

        for (let receiver = 0; receiver < replicas.length; receiver += 1) {
            for (let source = 0; source < replicas.length; source += 1) {
                if (receiver === source) {
                    continue;
                }
                const result = synchronize({
                    receiver: replicas[receiver].records,
                    source: replicas[source].records,
                    localWriter: replicas[receiver].writer,
                    authorityPhysical: 9000 + receiver * 10 + source,
                    nextInstant,
                });
                const outcome = outcomeOf(result);
                expect(outcome.stateAdvancing).toBe(false);
                expect(outcome.records).toEqual([]);
            }
        }
    });

    test("the settling schedule for H=2 settles within 2 state-advancing synchronizations", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(2, seededRandom(777));
        const { stateAdvancingCount } = settlingSchedule(replicas, 0, nextInstant);

        expect(stateAdvancingCount).toBeLessThanOrEqual(2);
        const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
        expect(projectionsEquivalent(projections[0], projections[1])).toBe(true);
    });

    test("the settling schedule for H=3 settles within 4 state-advancing synchronizations", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(3, seededRandom(888));
        const { stateAdvancingCount } = settlingSchedule(replicas, 0, nextInstant);

        expect(stateAdvancingCount).toBeLessThanOrEqual(4);
        const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
        for (let i = 1; i < projections.length; i += 1) {
            expect(projectionsEquivalent(projections[0], projections[i])).toBe(true);
        }
    });

    test("the settling schedule for H=4 settles within 6 state-advancing synchronizations", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(4, seededRandom(999));
        const { stateAdvancingCount } = settlingSchedule(replicas, 0, nextInstant);

        expect(stateAdvancingCount).toBeLessThanOrEqual(6);
        const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
        for (let i = 1; i < projections.length; i += 1) {
            expect(projectionsEquivalent(projections[0], projections[i])).toBe(true);
        }
    });

    test("the settling schedule reaches equivalent projections for every choice of collector", () => {
        for (let collector = 0; collector < 3; collector += 1) {
            const nextInstant = makePublicationClock();
            const replicas = generateQuiescentState(3, seededRandom(1000 + collector));
            settlingSchedule(replicas, collector, nextInstant);

            const projections = replicas.map((replica) => projectionOf(replica.records, replica.writer));
            for (let i = 1; i < projections.length; i += 1) {
                expect(projectionsEquivalent(projections[0], projections[i])).toBe(true);
            }
        }
    });

    test("after the settling schedule, another complete synchronization round is a semantic no-op", () => {
        const nextInstant = makePublicationClock();
        const replicas = generateQuiescentState(3, seededRandom(1111));
        settlingSchedule(replicas, 0, nextInstant);

        for (let receiver = 0; receiver < replicas.length; receiver += 1) {
            for (let source = 0; source < replicas.length; source += 1) {
                if (receiver === source) {
                    continue;
                }
                const result = synchronize({
                    receiver: replicas[receiver].records,
                    source: replicas[source].records,
                    localWriter: replicas[receiver].writer,
                    authorityPhysical: 20000 + receiver * 10 + source,
                    nextInstant,
                });
                const outcome = outcomeOf(result);
                expect(outcome.stateAdvancing).toBe(false);
                expect(outcome.records).toEqual([]);
            }
        }
    });
});
