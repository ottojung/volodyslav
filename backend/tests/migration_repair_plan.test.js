/**
 * The Pass M2 proof-barrier planning of a Journal-aware migration.
 *
 * `incremental-graph-journal-migrations.md` §16.2 requires a barrier for every edge
 * any eligible retained certificate could expose which the target does not want,
 * not merely the edges of the initially selected certificate. This unit test pins
 * that set-difference against a union which is strictly larger than the target's
 * edge set, because a proof weakening whose barrier set were computed from the
 * selected certificate alone would pass an integration test where the two agree.
 */

const { planProofBarriers } = require("../src/generators/incremental_graph/migration_repair_plan");
const { finalizeMigrationRepair } = require("../src/generators/incremental_graph/journal/migration_emission");
const { makeInitialCommittedWriterState } = require("../src/generators/incremental_graph/journal_store");
const {
    deserializeNodeKey,
} = require("../src/generators/incremental_graph/database");
const {
    isInvalidateEvent,
    makeJournalAuthor,
    makeJournalRecordId,
    makeJournalSequence,
    journalRecordIdToString,
    nodeKeyToCanonicalString,
} = require("../src/generators/incremental_graph/journal");

const KEY_A = '{"head":"A","args":[]}';
const KEY_C = '{"head":"C","args":[]}';
const KEY_B = '{"head":"B","args":[]}';

function valueId() {
    const author = makeJournalAuthor("testtarvalfp");
    if (author instanceof Error) {
        throw author;
    }
    const sequence = makeJournalSequence("1");
    if (sequence instanceof Error) {
        throw sequence;
    }
    const id = makeJournalRecordId(author, sequence);
    if (id instanceof Error) {
        throw id;
    }
    return id;
}

test("a target that keeps A but not C barriers exactly the C edge", () => {
    const occurrence = {
        nodeKeyString: KEY_B,
        nodeKey: deserializeNodeKey(KEY_B),
        valueId: valueId(),
        validInputs: new Set([KEY_A]),
        fresh: false,
    };
    const unions = new Map([[KEY_B, new Set([KEY_A, KEY_C])]]);
    const nodeKeyOf = (nodeKeyString) => deserializeNodeKey(nodeKeyString);

    const barriers = planProofBarriers({
        targetOccurrences: [occurrence],
        unions,
        nodeKeyOf,
    });

    if (!Array.isArray(barriers)) {
        throw new Error("the barrier plan was rejected: " + barriers.error.message);
    }
    expect(barriers).toHaveLength(1);
    expect(barriers[0].kind).toBe("migrate-proof-barrier");
    expect(nodeKeyToCanonicalString(barriers[0].node)).toBe(KEY_B);
    expect(nodeKeyToCanonicalString(barriers[0].input)).toBe(KEY_C);
});

test("a target whose wanted edges cover the union plans no barrier", () => {
    const occurrence = {
        nodeKeyString: KEY_B,
        nodeKey: deserializeNodeKey(KEY_B),
        valueId: valueId(),
        validInputs: new Set([KEY_A, KEY_C]),
        fresh: false,
    };
    const unions = new Map([[KEY_B, new Set([KEY_A, KEY_C])]]);
    const nodeKeyOf = (nodeKeyString) => deserializeNodeKey(nodeKeyString);

    const barriers = planProofBarriers({
        targetOccurrences: [occurrence],
        unions,
        nodeKeyOf,
    });

    if (!Array.isArray(barriers)) {
        throw new Error("the barrier plan was rejected: " + barriers.error.message);
    }
    expect(barriers).toHaveLength(0);
});

test("an emitted proof-weakening barrier retires exactly the unwanted edge", () => {
    const preserved = valueId();
    const occurrence = {
        nodeKeyString: KEY_B,
        nodeKey: deserializeNodeKey(KEY_B),
        valueId: preserved,
        validInputs: new Set([KEY_A]),
        fresh: false,
    };
    const unions = new Map([[KEY_B, new Set([KEY_A, KEY_C])]]);
    const nodeKeyOf = (nodeKeyString) => deserializeNodeKey(nodeKeyString);

    const barriers = planProofBarriers({
        targetOccurrences: [occurrence],
        unions,
        nodeKeyOf,
    });
    if (!Array.isArray(barriers)) {
        throw new Error("the barrier plan was rejected: " + barriers.error.message);
    }
    expect(barriers).toHaveLength(1);

    const author = makeJournalAuthor("testtarvalfp");
    if (author instanceof Error) {
        throw author;
    }
    const state = makeInitialCommittedWriterState(author);
    if (state instanceof Error) {
        throw state;
    }
    const emission = finalizeMigrationRepair({
        state,
        requests: barriers,
        publicationInstant: 1700000000000,
    });
    if (emission instanceof Error) {
        throw new Error("the barrier emission was rejected: " + emission.message);
    }
    expect(emission.records).toHaveLength(1);
    const record = emission.records[0];
    expect(isInvalidateEvent(record)).toBe(true);
    expect(record.scope.kind).toBe("proof");
    expect(journalRecordIdToString(record.scope.value)).toBe(journalRecordIdToString(preserved));
    expect(nodeKeyToCanonicalString(record.scope.input)).toBe(KEY_C);
});
