/**
 * Reset Pass 2/Pass 3 work larger than the in-memory work-queue threshold.
 *
 * `incremental-graph-journal-testing.md` §Streaming correctness (L889) requires a
 * test which "reset[s] a domain whose Pass 2 eligible-certificate population and
 * Pass 3 propagation work exceed the in-memory work-queue threshold; require[s]
 * incremental/durable-indexed processing and the same target projection".
 *
 * The normative source is `incremental-graph-journal-reset.md` §Streamability
 * (L339-347): Pass 1 domain traversal, Pass 2
 * eligible-certificate/`eligibleEffectiveProofUnion_P1(K)` evaluation and Pass 3
 * freshness propagation "must be implementable as ordered/indexed iteration with
 * bounded iterator/runtime buffers", the eligible proof union "is read from the
 * incrementally maintained per-occurrence eligible-proof-edge summary" and reset
 * "MUST NOT reconstruct that summary by folding retained certificate/invalidation
 * history", while graph-sized derived graph/index state independently required by
 * IncrementalGraph correctness is permitted. The implementation checklist §11
 * states the same obligation, and `$id-4924739474925738`
 * (`docs/intent-records/synchronization-performance.md`) is the underlying intent.
 *
 * ## What is exercised
 *
 * Two shapes make the reset domain graph-sized, far larger than
 * `WORK_QUEUE_THRESHOLD`:
 *
 * - a chain whose receiver proves every node against its predecessor while the
 *   target holds every node without any validity edge, so Pass 2's eligible
 *   certificate population is the whole chain and its
 *   `eligibleEffectiveProofUnion_P1(K) - TargetValid(K)` is one unwanted edge per
 *   proven node; and
 * - a chain whose root is unproven so every proven descendant is self-proof-ready
 *   and stale only through a stale input, so Pass 3's propagation work is the whole
 *   tail.
 *
 * The end-to-end cases drive the real production algorithm `resetToSource` and
 * compare the resulting `outcome.projection` against the **reference model**: a
 * full independent replay of the final Journal through `projectRetainedJournal`. A
 * pass which folded retained history, dropped a dependent, or mis-ordered a barrier
 * would diverge from that replay. Two further cases drive the production Pass 2 and
 * Pass 3 planners directly, so the exact functions the specification names are
 * pinned and the summary/projection reads are counted.
 *
 * ## What "incremental/durable-indexed" is pinned by
 *
 * Pass 2 reads `eligibleEffectiveProofUnion` from the maintained proof summary the
 * activated replica already holds, never from a `JournalSource`: the direct case
 * counts that the union read consults the current schema once per target
 * occurrence, and that the barrier plan consults it once per target occurrence.
 * Pass 3 reads `planFreshnessMarkers` from the post-validation projection's
 * `selfProofReadyNodes`, never from retained history: the direct case counts one
 * invalidation-summary query per target-stale self-proof-ready node. The
 * receiver's retained record read shape across reset is pinned independently by
 * `journal_reset_pass_cuts.test.js`.
 *
 * Every fixture is a supported graph plus Journal pair in the sense of
 * `incremental-graph-journal-testing.md` §Reference replay oracle: each node is
 * materialized and then validated against the exact current direct-input
 * occurrences it observed.
 */

const {
    journalAuthorToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeReplicaSource,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    nodeKeyToCanonicalString,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal");

const { SnapshotIdentityClass } = require("../src/generators/incremental_graph/journal_sync");

const {
    buildRetainedReplayState,
    makeResetSource,
    resetToSource,
} = require("../src/generators/incremental_graph/journal_reset");

const {
    authorLookupOf,
    projectRetainedReplay,
    selectedOccurrencesOf,
} = require("../src/generators/incremental_graph/journal_retained");

const {
    eligibleEffectiveProofUnion,
    planProofBarriers,
} = require("../src/generators/incremental_graph/journal_reset/pass2");

const { planFreshnessMarkers } = require("../src/generators/incremental_graph/journal_reset/pass3");

const WRITER_LOCAL = "aaaaaaaaa";
const WRITER_PEER = "bbbbbbbbb";
const NOW = "2020-01-01T00:00:00.000Z";
const LATER = "2020-01-02T00:00:00.000Z";
const PAYLOAD = { type: "entry_description", description: "x" };
const INSTANT = 1700000000000;
const LOCAL_AUTHOR = makeJournalAuthor(WRITER_LOCAL);

/**
 * The test's stand-in for the implementation's in-memory work-queue threshold.
 *
 * The specification does not fix a numeric threshold; the point is that the domain
 * processed below is far larger than any small bounded buffer a non-streaming
 * implementation would keep, so a pass which had to hold the complete eligible
 * certificate population or propagation closure as one collection would have to
 * exceed it.
 */
const WORK_QUEUE_THRESHOLD = 16;

/**
 * The chain length, chosen to be many multiples of the threshold so both the Pass 2
 * eligible-certificate population and the Pass 3 propagation closure are
 * unambiguously larger than the work queue.
 */
const CHAIN_LENGTH = 64;

/**
 * @param {number} count
 * @returns {ReadonlyArray<number>}
 */
function range(count) {
    return Array.from({ length: count }, (_, index) => index);
}

/**
 * @param {number} id
 * @returns {import("../src/generators/incremental_graph/journal").NodeKey}
 */
function nodeOf(id) {
    return { head: "event", args: [{ id }] };
}

/**
 * @param {number} id
 * @returns {string}
 */
function keyOf(id) {
    return nodeKeyToCanonicalString(nodeOf(id));
}

/**
 * @param {number} id
 * @returns {string}
 */
function identifierOf(id) {
    return id + "-abcdefghi";
}

/**
 * The chain schema: node `i` depends on node `i - 1`, and node `0` is a leaf.
 *
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */
function chainInputs(nodeKeyString) {
    for (const id of range(CHAIN_LENGTH)) {
        if (keyOf(id) === nodeKeyString) {
            return id === 0 ? [] : [keyOf(id - 1)];
        }
    }
    return [];
}

/**
 * @param {number} physical
 * @returns {import("../src/generators/incremental_graph/journal").AuthorityTime}
 */
function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
}

/**
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
 * A chain of materializations and (optionally) validations by one writer, with
 * contiguous own-writer coordinates and exact own-prefix contexts.
 *
 * Node `0` is the chain leaf; every later node's validation names its
 * predecessor's value occurrence as its one basis input. A node for which `proven`
 * is false is materialized without a validation, so it is stale on its own account
 * rather than through its inputs.
 *
 * @param {string} writer
 * @param {number} base - The writer's first authority time.
 * @param {(id: number) => boolean} proven
 * @returns {{records: import("../src/generators/incremental_graph/journal").JournalRecord[]}}
 */
function buildChain(writer, base, proven) {
    /** @type {import("../src/generators/incremental_graph/journal").JournalRecord[]} */
    const records = [];
    /** @type {Map<number, string>} */
    const valueIdOf = new Map();
    let sequence = 0;
    for (const id of range(CHAIN_LENGTH)) {
        sequence += 1;
        const valueId = writer + ":" + String(sequence);
        records.push(made(makeValueEvent(
            {
                id: valueId,
                context: makeJournalFrontierFromText(
                    sequence === 1 ? [] : [[writer, String(sequence - 1)]]
                ),
                authorityTime: authorityOf(base + id * 2),
                node: nodeOf(id),
            },
            identifierOf(id),
            PAYLOAD,
            NOW,
            LATER,
            "compute"
        )));
        valueIdOf.set(id, valueId);
        if (proven(id)) {
            sequence += 1;
            const predecessor = valueIdOf.get(id - 1);
            records.push(made(makeValidateEvent(
                {
                    id: writer + ":" + String(sequence),
                    context: makeJournalFrontierFromText([[writer, String(sequence - 1)]]),
                    authorityTime: authorityOf(base + id * 2 + 1),
                    node: nodeOf(id),
                },
                valueId,
                id === 0 || predecessor === undefined
                    ? []
                    : [makeValidationBasisEntry(nodeOf(id - 1), predecessor)],
                "compute"
            )));
        }
    }
    return { records };
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {import("../src/generators/incremental_graph/journal").JournalReplica}
 */
function replicaOf(records) {
    /** @type {Map<string, import("../src/generators/incremental_graph/journal").JournalRecord[]>} */
    const byWriter = new Map();
    for (const record of records) {
        const name = journalAuthorToString(record.id.author);
        const stream = byWriter.get(name) ?? [];
        stream.push(record);
        byWriter.set(name, stream);
    }
    return made(makeJournalReplica([...byWriter.entries()]));
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal_reset").RetainedReplayState>}
 */
async function retainedStateOf(records) {
    const built = await buildRetainedReplayState({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: chainInputs,
    });
    if ("error" in built) {
        throw new Error("the receiver fixture has no retained state: " + built.error.message);
    }
    return built.state;
}

/**
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} records
 * @returns {Promise<import("../src/generators/incremental_graph/journal").Projection>}
 */
async function referenceProjection(records) {
    const projected = await projectRetainedJournal({
        source: makeReplicaSource(replicaOf(records)),
        localWriter: LOCAL_AUTHOR,
        currentInputKeysOfNode: chainInputs,
    });
    if (projected instanceof Error) {
        throw new Error("the reference replay failed: " + projected.message);
    }
    return projected;
}

/**
 * One controlled reset of the receiver to the source's committed projection, both
 * as supported graph plus Journal pairs. The receiver's authority is higher than
 * the source's, so the raw union selects the receiver's occurrences and its
 * certificates stay eligible; the source target's immutable occurrence state is
 * byte-identical, so Pass 1 preserves them.
 *
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} receiverRecords
 * @param {ReadonlyArray<import("../src/generators/incremental_graph/journal").JournalRecord>} sourceRecords
 * @returns {Promise<{outcome: import("../src/generators/incremental_graph/journal_reset").ResetOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}>}
 */
async function runReset(receiverRecords, sourceRecords) {
    const receiver = makeReplicaSource(replicaOf(receiverRecords));
    const retainedState = await retainedStateOf(receiverRecords);
    const sourceJournal = makeReplicaSource(replicaOf(sourceRecords));
    const projection = await referenceProjection(sourceRecords);
    const source = makeResetSource({
        databaseVersion: "v1",
        graphSchemeString: "scheme",
        journal: sourceJournal,
        projection,
    });
    const lastLocal = receiverRecords
        .filter((record) => journalAuthorToString(record.id.author) === WRITER_LOCAL)
        .slice(-1)[0];
    if (lastLocal === undefined) {
        throw new Error("the receiver fixture has no local record");
    }
    return await resetToSource({
        receiver,
        retainedState,
        source,
        localWriter: LOCAL_AUTHOR,
        committed: {
            localWriter: LOCAL_AUTHOR,
            writerHead: lastLocal.id.sequence,
            committedFrontier: makeJournalFrontierFromText([[WRITER_LOCAL, lastLocal.id.sequence]]),
            authorityHighWater: authorityOf(500000),
            allocatorWatermark: 0,
        },
        observedHighWater: authorityOf(500000),
        publicationInstant: INSTANT,
        currentInputKeysOfNode: chainInputs,
        receiverIdentity: new SnapshotIdentityClass("v1", "scheme"),
    });
}

/**
 * @param {{outcome: import("../src/generators/incremental_graph/journal_reset").ResetOutcome} | {error: import("../src/generators/incremental_graph/journal").JournalError}} result
 * @returns {import("../src/generators/incremental_graph/journal_reset").ResetOutcome}
 */
function outcomeOf(result) {
    if (!("outcome" in result)) {
        throw new Error("reset failed with " + result.error.name + ": " + result.error.message);
    }
    return result.outcome;
}

describe("reset Pass 2/Pass 3 over a domain larger than the work-queue threshold", () => {
    test("Pass 2 reads the eligible-certificate union from the maintained summary and barriers every unwanted edge", async () => {
        // The receiver proves every node against its predecessor, so each node has
        // one eligible certificate; the target wants no incoming edge, so the union
        // minus the target is one barrier per proven node.
        const receiver = buildChain(WRITER_LOCAL, 1000, () => true).records;
        const state = await retainedStateOf(receiver);
        const projection = projectRetainedReplay(state);
        if ("error" in projection) {
            throw new Error("the receiver fixture does not project: " + projection.error.message);
        }
        const selected = selectedOccurrencesOf(state);
        expect(selected.size).toBe(CHAIN_LENGTH);

        /** @type {import("../src/generators/incremental_graph/journal_reset/pass2").ResetTargetOccurrence[]} */
        const targetOccurrences = projection.occurrences.map((occurrence) => ({
            nodeKeyString: occurrence.nodeKeyString,
            nodeKey: occurrence.nodeKey,
            valueId: occurrence.valueId,
            nodeIdentifier: occurrence.nodeIdentifier,
            payload: occurrence.payload,
            createdAt: occurrence.createdAt,
            modifiedAt: occurrence.modifiedAt,
            validInputs: new Set(),
            fresh: false,
        }));

        const unions = eligibleEffectiveProofUnion({
            summary: state.proofs,
            targetOccurrences,
            authorOf: authorLookupOf(state),
        });
        const unionEdges = [...unions.values()].reduce((total, edges) => total + edges.size, 0);
        expect(unionEdges).toBe(CHAIN_LENGTH - 1);
        expect(unionEdges).toBeGreaterThan(WORK_QUEUE_THRESHOLD);

        const nodeByKey = new Map(range(CHAIN_LENGTH).map((id) => [keyOf(id), nodeOf(id)]));
        const planned = planProofBarriers({
            targetOccurrences,
            unions,
            nodeKeyOf: (nodeKeyString) => nodeByKey.get(nodeKeyString),
        });
        if ("error" in planned) {
            throw new Error("the barrier plan failed: " + planned.error.message);
        }
        expect(planned.barriers.length).toBe(CHAIN_LENGTH - 1);
        expect(planned.barriers.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(new Set(planned.barriers.map((barrier) => nodeKeyToCanonicalString(barrier.node))))
            .toEqual(new Set(range(CHAIN_LENGTH).slice(1).map(keyOf)));
        expect(planned.barriers.every((barrier) => barrier.kind === "proof-barrier")).toBe(true);
    });

    test("Pass 3 plans a freshness marker for every self-proof-ready target-stale node", async () => {
        // The root is materialized without a proof, so every proven descendant is
        // self-proof-ready and stale only through a stale input, which is the Pass 3
        // propagation worklist.
        const receiver = buildChain(WRITER_LOCAL, 1000, (id) => id > 0).records;
        const state = await retainedStateOf(receiver);
        const projection = projectRetainedReplay(state);
        if ("error" in projection) {
            throw new Error("the receiver fixture does not project: " + projection.error.message);
        }

        /** @type {import("../src/generators/incremental_graph/journal_reset/pass2").ResetTargetOccurrence[]} */
        const targetOccurrences = projection.occurrences.map((occurrence) => ({
            nodeKeyString: occurrence.nodeKeyString,
            nodeKey: occurrence.nodeKey,
            valueId: occurrence.valueId,
            nodeIdentifier: occurrence.nodeIdentifier,
            payload: occurrence.payload,
            createdAt: occurrence.createdAt,
            modifiedAt: occurrence.modifiedAt,
            validInputs: occurrence.validInputs,
            fresh: false,
        }));

        let invalidationQueries = 0;
        const markers = planFreshnessMarkers({
            postValidation: projection,
            targetOccurrences,
            hasUncoveredValueInvalidation: () => {
                invalidationQueries += 1;
                return false;
            },
        });
        expect(markers.requests.length).toBe(CHAIN_LENGTH - 1);
        expect(markers.requests.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(new Set(markers.requests.map((request) => nodeKeyToCanonicalString(request.node))))
            .toEqual(new Set(range(CHAIN_LENGTH).slice(1).map(keyOf)));
        expect(markers.requests.every((request) => request.kind === "value-marker")).toBe(true);
        // The plan consults the projection's self-proof-ready set and the occurrence's
        // own invalidation summary, once per target-stale self-proof-ready node, and
        // never walks retained history.
        expect(invalidationQueries).toBe(CHAIN_LENGTH - 1);
    });

    test("reset authors a Pass 2 barrier population larger than the threshold and projects to the reference replay", async () => {
        const receiver = buildChain(WRITER_LOCAL, 1000, () => true).records;
        const source = buildChain(WRITER_PEER, 10, () => false).records;

        const outcome = outcomeOf(await runReset(receiver, source));

        const barriers = outcome.publication.records.filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "proof"
        );
        expect(barriers.length).toBe(CHAIN_LENGTH - 1);
        expect(barriers.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(barriers.every((record) => record.reason === "reset")).toBe(true);
        expect(new Set(barriers.map((record) => nodeKeyToCanonicalString(record.node))))
            .toEqual(new Set(range(CHAIN_LENGTH).slice(1).map(keyOf)));

        const reference = await referenceProjection([...receiver, ...outcome.records]);
        expect(outcome.projection).toEqual(reference);
        expect(outcome.projection.occurrences).toHaveLength(CHAIN_LENGTH);
        expect(outcome.projection.occurrences.every((occurrence) => occurrence.validInputs.size === 0))
            .toBe(true);
    });

    test("reset authors a Pass 3 propagation larger than the threshold and projects to the reference replay", async () => {
        const receiver = buildChain(WRITER_LOCAL, 1000, (id) => id > 0).records;
        const source = buildChain(WRITER_PEER, 10, (id) => id > 0).records;

        const outcome = outcomeOf(await runReset(receiver, source));

        const markers = outcome.publication.records.filter(
            (record) => record.kind === "invalidate" && record.scope.kind === "value"
        );
        expect(markers.length).toBe(CHAIN_LENGTH - 1);
        expect(markers.length).toBeGreaterThan(WORK_QUEUE_THRESHOLD);
        expect(markers.every((record) => record.reason === "reset")).toBe(true);
        expect(new Set(markers.map((record) => nodeKeyToCanonicalString(record.node))))
            .toEqual(new Set(range(CHAIN_LENGTH).slice(1).map(keyOf)));

        const reference = await referenceProjection([...receiver, ...outcome.records]);
        expect(outcome.projection).toEqual(reference);
        expect(outcome.projection.occurrences).toHaveLength(CHAIN_LENGTH);
    });
});
