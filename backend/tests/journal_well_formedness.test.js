const {
    authorityCompare,
    compareJournalSequence,
    currentFormatValidateRecord,
    encodeJournalRecord,
    frontierJoin,
    happenedBefore,
    isJournalCausalClosureError,
    isJournalForkError,
    isJournalGapError,
    isJournalRecordValidationError,
    isJournalReferenceCausalityError,
    isJournalReplica,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeDeleteEvent,
    makeInvalidateEvent,
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
    joinReplicaRecords,
    replicaFrontier,
    sortValidationBasis,
    tryDecodeJournalRecord,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const NODE_OTHER = { head: "event", args: [{ id: 9 }] };
const NODE_IDENTIFIER = "1-abcdefghi";
const FUTURE = "2030-01-01T00:00:00.000Z";
const NOW = "2020-01-01T00:00:00.000Z";

function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

function authorityOf(physical, logical) {
    return makeAuthorityTime(physical, logical);
}

function valueEvent() {
    return makeValueEvent(
        {
            id: "A:1",
            context: contextOf([]),
            authorityTime: authorityOf(1000, "0"),
            node: NODE_K,
        },
        NODE_IDENTIFIER,
        { kind: "EventEntry", text: "hello" },
        NOW,
        NOW,
        "compute"
    );
}

function valueAt(id, coordinates, node, physical) {
    return makeValueEvent(
        {
            id,
            context: contextOf(coordinates),
            authorityTime: authorityOf(physical, "0"),
            node,
        },
        NODE_IDENTIFIER,
        { kind: "EventEntry", text: id },
        NOW,
        NOW,
        "compute"
    );
}

/**
 * The current schema says K has exactly one direct input, D.
 * @returns {Array<string>}
 */
function currentInputsOfD() {
    return [nodeKeyToCanonicalString(NODE_D)];
}

function replicaOf(streams) {
    return makeJournalReplica(streams);
}

describe("Journal record identities", () => {
    test("a sequence coordinate is arbitrary precision, not a double", () => {
        const smaller = makeJournalSequence("9007199254740992");
        const larger = makeJournalSequence("9007199254740993");
        expect(journalSequenceToString(larger)).toBe("9007199254740993");
        expect(compareJournalSequence(larger, smaller)).toBeGreaterThan(0);
        expect(compareJournalSequence(smaller, larger)).toBeLessThan(0);
        expect(journalSequenceToString(smaller)).not.toBe(journalSequenceToString(larger));
    });

    test("a record id above the double range survives the codec unchanged", () => {
        const event = makeValueEvent(
            {
                id: "A:9007199254740993",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { kind: "EventEntry" },
            NOW,
            NOW,
            "compute"
        );
        expect(journalRecordIdToString(event.id)).toBe("A:9007199254740993");
        const decoded = tryDecodeJournalRecord(encodeJournalRecord(event));
        expect(journalRecordIdToString(decoded.id)).toBe("A:9007199254740993");
    });

    test("a non-canonical or zero sequence is rejected", () => {
        expect(isJournalRecordValidationError(makeJournalSequence("01"))).toBe(true);
        expect(isJournalRecordValidationError(makeJournalSequence("1.0"))).toBe(true);
        expect(isJournalRecordValidationError(makeJournalSequence(""))).toBe(true);
    });
});

describe("skewed value timestamps", () => {
    test("a value occurrence with createdAt after modifiedAt is accepted", () => {
        const event = makeValueEvent(
            {
                id: "A:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { kind: "EventEntry" },
            FUTURE,
            NOW,
            "compute"
        );
        expect(event.createdAt).toBe(FUTURE);
        expect(event.modifiedAt).toBe(NOW);
        expect(validateJournalReplica(replicaOf([["A", [event]]]))).toBeUndefined();
    });

    test("the acceptance is not trivial: a non-canonical instant is rejected", () => {
        const event = makeValueEvent(
            {
                id: "A:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { kind: "EventEntry" },
            "2020-01-01T00:00:00Z",
            NOW,
            "compute"
        );
        expect(isJournalRecordValidationError(event)).toBe(true);
    });

    test("both timestamps survive a codec round trip unnormalized", () => {
        const event = makeValueEvent(
            {
                id: "A:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { kind: "EventEntry" },
            FUTURE,
            NOW,
            "compute"
        );
        const decoded = tryDecodeJournalRecord(encodeJournalRecord(event));
        expect(decoded.createdAt).toBe(FUTURE);
        expect(decoded.modifiedAt).toBe(NOW);
    });
});

describe("causal context closure", () => {
    const a1 = valueAt("A:1", [], NODE_K, 1000);
    const b1 = valueAt("B:1", [["A", "1"]], NODE_K, 2000);
    const closedC = valueAt("C:1", [["B", "1"], ["A", "1"]], NODE_K, 3000);
    const nonTransitiveC = valueAt("C:1", [["B", "1"]], NODE_K, 3000);

    test("a transitively closed history is accepted", () => {
        const replica = replicaOf([["A", [a1]], ["B", [b1]], ["C", [closedC]]]);
        expect(validateJournalReplica(replica)).toBeUndefined();
    });

    test("a context which includes an event but omits what it observed is rejected", () => {
        const replica = replicaOf([["A", [a1]], ["B", [b1]], ["C", [nonTransitiveC]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("transitive closure");
    });

    test("a context claiming an unretained coordinate is rejected", () => {
        const unobservedX = valueAt("A:1", [["X", "1"]], NODE_K, 1000);
        const replica = replicaOf([["A", [unobservedX]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("retained-range coverage");
    });

    test("an incomplete own-writer prefix is rejected even when no reference exposes it", () => {
        const a1 = valueAt("A:1", [["X", "1"]], NODE_K, 1000);
        const x1 = valueAt("X:1", [], NODE_K, 500);
        const a2 = valueAt("A:2", [["A", "0"], ["X", "0"]], NODE_K, 2000);
        const replica = replicaOf([["A", [a1, a2]], ["X", [x1]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("complete local prefix");
    });

    test("a context whose authority does not extend an observed predecessor is rejected", () => {
        const early = valueAt("A:1", [], NODE_K, 5000);
        const regressed = valueAt("A:2", [["A", "1"]], NODE_K, 1000);
        const replica = replicaOf([["A", [early, regressed]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("authority consistency");
    });

    test("happenedBefore is transitive over a closed history", () => {
        expect(happenedBefore(a1, b1)).toBe(true);
        expect(happenedBefore(b1, closedC)).toBe(true);
        expect(happenedBefore(a1, closedC)).toBe(true);
        expect(happenedBefore(closedC, a1)).toBe(false);
    });

    test("events which observed nothing of each other are concurrent", () => {
        expect(happenedBefore(a1, b1)).toBe(true);
        const independent = valueAt("D:1", [], NODE_K, 1500);
        expect(happenedBefore(independent, a1)).toBe(false);
        expect(happenedBefore(a1, independent)).toBe(false);
    });
});

describe("authority order", () => {
    test("physical dominates logical", () => {
        const later = valueAt("A:1", [], NODE_K, 2000);
        const earlier = valueAt("A:2", [], NODE_K, 1000);
        expect(authorityCompare(earlier, later)).toBeLessThan(0);
    });

    test("logical breaks equal physical times", () => {
        const first = makeValueEvent(
            {
                id: "A:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "1"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { kind: "EventEntry" },
            NOW,
            NOW,
            "compute"
        );
        const second = makeValueEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(1000, "2"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { kind: "EventEntry" },
            NOW,
            NOW,
            "compute"
        );
        expect(authorityCompare(first, second)).toBeLessThan(0);
    });

    test("author breaks equal authority times, sequence breaks equal authors", () => {
        const fromB = valueAt("B:1", [], NODE_K, 1000);
        const fromA = valueAt("A:1", [], NODE_K, 1000);
        expect(authorityCompare(fromA, fromB)).toBeLessThan(0);
        const a1 = valueAt("A:1", [], NODE_K, 1000);
        const a2 = valueAt("A:2", [["A", "1"]], NODE_K, 1000);
        expect(authorityCompare(a1, a2)).toBeLessThan(0);
    });
});

describe("frontier join", () => {
    test("join takes the componentwise maximum", () => {
        const left = contextOf([["A", "3"], ["B", "1"]]);
        const right = contextOf([["A", "1"], ["C", "4"]]);
        const joined = frontierJoin(left, right);
        const shape = [...joined.entries()].map(
            (entry) => journalAuthorToString(entry[0]) + ":" + journalSequenceToString(entry[1])
        );
        expect(shape).toEqual(expect.arrayContaining(["A:3", "B:1", "C:4"]));
        expect(joined.size).toBe(3);
    });

    test("join is idempotent, commutative and associative", () => {
        const a = contextOf([["A", "3"], ["B", "1"]]);
        const b = contextOf([["A", "1"], ["C", "4"]]);
        const c = contextOf([["B", "7"]]);
        const shape = (frontier) =>
            [...frontier.entries()]
                .map((entry) => journalAuthorToString(entry[0]) + ":" + journalSequenceToString(entry[1]))
                .sort()
                .join(",");
        expect(shape(frontierJoin(a, a))).toBe(shape(a));
        expect(shape(frontierJoin(a, b))).toBe(shape(frontierJoin(b, a)));
        expect(shape(frontierJoin(frontierJoin(a, b), c))).toBe(
            shape(frontierJoin(a, frontierJoin(b, c)))
        );
    });
});

describe("invalidation scopes", () => {
    const a1 = valueAt("A:1", [], NODE_K, 1000);

    test("a node scope carries no value reference and needs no causality", () => {
        const concurrent = makeInvalidateEvent(
            {
                id: "B:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            makeNodeScope(),
            "explicit"
        );
        const replica = replicaOf([["A", [a1]], ["B", [concurrent]]]);
        expect(validateJournalReplica(replica)).toBeUndefined();
        expect(concurrent.scope.value).toBeUndefined();
    });

    test("a value scope naming a causally prior occurrence is accepted", () => {
        const scoped = makeInvalidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            makeValueScope("A:1"),
            "propagated"
        );
        expect(validateJournalReplica(replicaOf([["A", [a1, scoped]]]))).toBeUndefined();
    });

    test("a value scope naming a concurrent occurrence is rejected", () => {
        const scoped = makeInvalidateEvent(
            {
                id: "B:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            makeValueScope("A:1"),
            "propagated"
        );
        const failure = validateJournalReplica(replicaOf([["A", [a1]], ["B", [scoped]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("a value scope naming another node's occurrence is rejected", () => {
        const other = valueAt("A:2", [["A", "1"]], NODE_OTHER, 2000);
        const scoped = makeInvalidateEvent(
            {
                id: "A:3",
                context: contextOf([["A", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            makeValueScope("A:2"),
            "propagated"
        );
        const failure = validateJournalReplica(replicaOf([["A", [a1, other, scoped]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a value scope naming a non-value record is rejected", () => {
        const deletion = makeDeleteEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const scoped = makeInvalidateEvent(
            {
                id: "A:3",
                context: contextOf([["A", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            makeValueScope("A:2"),
            "propagated"
        );
        const failure = validateJournalReplica(replicaOf([["A", [a1, deletion, scoped]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("proof scope is accepted only for controlled maintenance reasons", () => {
        const maintenance = makeInvalidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            makeProofScope("A:1", NODE_D),
            "reset"
        );
        expect(validateJournalReplica(replicaOf([["A", [a1, maintenance]]]))).toBeUndefined();
        const explicit = makeInvalidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            makeProofScope("A:1", NODE_D),
            "explicit"
        );
        expect(isJournalRecordValidationError(explicit)).toBe(true);
    });
});

describe("validation target and basis", () => {
    const a1 = valueAt("A:1", [], NODE_K, 1000);

    test("a validation of a causally prior occurrence is accepted", () => {
        const validation = makeValidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "A:1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "bootstrap"
        );
        expect(validateJournalReplica(replicaOf([["A", [a1, validation]]]))).toBeUndefined();
    });

    test("a validation of a non-value record is rejected", () => {
        const deletion = makeDeleteEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const validation = makeValidateEvent(
            {
                id: "A:3",
                context: contextOf([["A", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "A:2",
            [],
            "compute"
        );
        const failure = validateJournalReplica(replicaOf([["A", [a1, deletion, validation]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a validation of a concurrent occurrence is rejected", () => {
        const value = valueAt("A:1", [], NODE_K, 1000);
        const validation = makeValidateEvent(
            {
                id: "B:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            "A:1",
            [],
            "compute"
        );
        const failure = validateJournalReplica(replicaOf([["A", [value]], ["B", [validation]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("a basis may not name one input twice", () => {
        const validation = makeValidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "A:1",
            [
                makeValidationBasisEntry(NODE_D, "unknown"),
                makeValidationBasisEntry(NODE_D, "unknown"),
            ],
            "bootstrap"
        );
        expect(isJournalRecordValidationError(validation)).toBe(true);
    });

    test("a basis must already be in canonical NodeKey order", () => {
        const validation = makeValidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "A:1",
            [
                makeValidationBasisEntry(NODE_D, "unknown"),
                makeValidationBasisEntry(NODE_K, "unknown"),
            ],
            "bootstrap"
        );
        expect(isJournalRecordValidationError(validation)).toBe(true);
    });

    test("the canonical order is the persisted NodeKeyString order", () => {
        const sorted = sortValidationBasis([
            makeValidationBasisEntry(NODE_D, "unknown"),
            makeValidationBasisEntry(NODE_K, "unknown"),
        ]);
        expect(sorted.map((entry) => entry.input)).toEqual([NODE_K, NODE_D]);
    });

    test("an ordinary validation may not use an unknown basis entry", () => {
        const validation = makeValidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "A:1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "compute"
        );
        const replica = replicaOf([["A", [a1, validation]]]);
        const failure = validateJournalReplica(replica, {
            currentInputKeysOfNode: () => ["x"],
        });
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("an ordinary validation must name exactly the current direct inputs", () => {
        const value = valueAt("A:1", [], NODE_K, 1000);
        const input = valueAt("A:2", [["A", "1"]], NODE_D, 2000);
        const validation = makeValidateEvent(
            {
                id: "A:3",
                context: contextOf([["A", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "A:1",
            [makeValidationBasisEntry(NODE_D, "A:2")],
            "compute"
        );
        const replica = replicaOf([["A", [value, input, validation]]]);
        expect(
            validateJournalReplica(replica, { currentInputKeysOfNode: currentInputsOfD })
        ).toBeUndefined();
        const stale = makeValidateEvent(
            {
                id: "A:3",
                context: contextOf([["A", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "A:2",
            [],
            "compute"
        );
        const incomplete = replicaOf([["A", [value, input, stale]]]);
        expect(
            isJournalRecordValidationError(
                validateJournalReplica(incomplete, { currentInputKeysOfNode: currentInputsOfD })
            )
        ).toBe(true);
    });

    test("a publication may not reference a coordinate its own writer allocates later", () => {
        const value = valueAt("A:1", [], NODE_K, 1000);
        const forward = makeValidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "A:3",
            [],
            "compute"
        );
        const later = valueAt("A:3", [["A", "2"]], NODE_K, 3000);
        const failure = validateJournalReplica(replicaOf([["A", [value, forward, later]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });
});

describe("stream contiguity", () => {
    test("a contiguous prefix is accepted", () => {
        const first = valueAt("A:1", [], NODE_K, 1000);
        const second = valueAt("A:2", [["A", "1"]], NODE_K, 2000);
        expect(validateJournalReplica(replicaOf([["A", [first, second]]]))).toBeUndefined();
    });

    test("a hole in a claimed prefix is a gap", () => {
        const first = valueAt("A:1", [], NODE_K, 1000);
        const third = valueAt("A:3", [["A", "1"]], NODE_K, 3000);
        const failure = validateJournalReplica(replicaOf([["A", [first, third]]]));
        expect(isJournalGapError(failure)).toBe(true);
        expect(failure.missingSequence).toBe("2");
    });

    test("a stream which does not start at one is a gap", () => {
        const second = valueAt("A:2", [], NODE_K, 2000);
        const failure = validateJournalReplica(replicaOf([["A", [second]]]));
        expect(isJournalGapError(failure)).toBe(true);
        expect(failure.missingSequence).toBe("1");
    });

    test("the retained frontier is the greatest retained coordinate per writer", () => {
        const a1 = valueAt("A:1", [], NODE_K, 1000);
        const a2 = valueAt("A:2", [["A", "1"]], NODE_K, 2000);
        const b1 = valueAt("B:1", [], NODE_K, 1000);
        const frontier = replicaFrontier(replicaOf([["A", [a1, a2]], ["B", [b1]]]));
        expect(frontier.size).toBe(2);
    });
});

describe("prefix union and forks", () => {
    test("agreeing prefixes union to the longer one", () => {
        const a1 = valueAt("A:1", [], NODE_K, 1000);
        const a2 = valueAt("A:2", [["A", "1"]], NODE_K, 2000);
        const left = replicaOf([["A", [a1]]]);
        const right = replicaOf([["A", [a1, a2]]]);
        const joined = joinReplicaRecords(left, right);
        expect(isJournalReplica(joined)).toBe(true);
        expect([...joined.get([...right.keys()][0])].length).toBe(2);
    });

    test("a same-identity disagreement is a fork, not a graph conflict", () => {
        const first = valueAt("A:1", [], NODE_K, 1000);
        const diverged = makeValueEvent(
            {
                id: "A:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            "2-abcdefghi",
            { kind: "EventEntry", text: "different" },
            NOW,
            NOW,
            "compute"
        );
        const failure = joinReplicaRecords(
            replicaOf([["A", [first]]]),
            replicaOf([["A", [diverged]]])
        );
        expect(isJournalForkError(failure)).toBe(true);
        expect(failure.recordId).toBe("A:1");
        expect(failure.firstMeaning).not.toBe(failure.secondMeaning);
    });

    test("union is idempotent, commutative and associative", () => {
        const a1 = valueAt("A:1", [], NODE_K, 1000);
        const a2 = valueAt("A:2", [["A", "1"]], NODE_K, 2000);
        const a3 = valueAt("A:3", [["A", "2"]], NODE_K, 3000);
        const b1 = valueAt("B:1", [], NODE_K, 1000);
        const one = replicaOf([["A", [a1]], ["B", [b1]]]);
        const two = replicaOf([["A", [a1, a2]]]);
        const three = replicaOf([["A", [a1, a2, a3]]]);
        const shape = (replica) =>
            [...replica.entries()]
                .map((entry) => journalRecordIdToString(entry[1][entry[1].length - 1].id))
                .sort()
                .join(",");
        expect(shape(joinReplicaRecords(one, one))).toBe(shape(one));
        expect(shape(joinReplicaRecords(one, two))).toBe(shape(joinReplicaRecords(two, one)));
        expect(shape(joinReplicaRecords(joinReplicaRecords(one, two), three))).toBe(
            shape(joinReplicaRecords(one, joinReplicaRecords(two, three)))
        );
    });

    test("a writer state record is not a semantic event", () => {
        const record = makeWriterStateRecord("A:2", 4);
        expect(record.kind).toBe("writer-state");
        expect(record.context).toBeUndefined();
    });
});

describe("writer state monotonicity", () => {
    test("an increasing watermark is accepted", () => {
        const first = makeWriterStateRecord("A:1", 1);
        const second = makeWriterStateRecord("A:2", 7);
        expect(validateJournalReplica(replicaOf([["A", [first, second]]]))).toBeUndefined();
    });

    test("a repeated watermark is accepted", () => {
        const first = makeWriterStateRecord("A:1", 4);
        const second = makeWriterStateRecord("A:2", 4);
        expect(validateJournalReplica(replicaOf([["A", [first, second]]]))).toBeUndefined();
    });

    test("a decreasing watermark is rejected", () => {
        const first = makeWriterStateRecord("A:1", 7);
        const second = makeWriterStateRecord("A:2", 3);
        const failure = validateJournalReplica(replicaOf([["A", [first, second]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a negative or fractional watermark is not a current-format record", () => {
        expect(isJournalRecordValidationError(makeWriterStateRecord("A:1", -1))).toBe(true);
        expect(isJournalRecordValidationError(makeWriterStateRecord("A:1", 1.5))).toBe(true);
    });
});

describe("current-format codec", () => {
    test("every core record kind round trips", () => {
        const value = valueAt("A:1", [], NODE_K, 1000);
        const deletion = makeDeleteEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const validation = makeValidateEvent(
            {
                id: "A:3",
                context: contextOf([["A", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "A:1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "bootstrap"
        );
        const invalidation = makeInvalidateEvent(
            {
                id: "A:4",
                context: contextOf([["A", "3"]]),
                authorityTime: authorityOf(4000, "0"),
                node: NODE_K,
            },
            makeValueScope("A:1"),
            "propagated"
        );
        const state = makeWriterStateRecord("A:5", 12);
        for (const record of [value, deletion, validation, invalidation, state]) {
            const text = encodeJournalRecord(record);
            const decoded = tryDecodeJournalRecord(text);
            expect(encodeJournalRecord(decoded)).toBe(text);
        }
    });

    test("an unknown record kind is rejected rather than upcast", () => {
        const failure = currentFormatValidateRecord({
            id: "A:1",
            kind: "trace-span",
            payload: {},
        });
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a per-record version discriminator is rejected", () => {
        const body = JSON.parse(encodeJournalRecord(valueEvent()));
        body.version = 2;
        const failure = currentFormatValidateRecord(body);
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("an unknown field is rejected", () => {
        const body = JSON.parse(encodeJournalRecord(valueEvent({})));
        body.extra = true;
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("a non-canonical persisted basis order is rejected", () => {
        const validation = makeValidateEvent(
            {
                id: "A:2",
                context: contextOf([["A", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "A:1",
            [
                makeValidationBasisEntry(NODE_K, "unknown"),
                makeValidationBasisEntry(NODE_D, "unknown"),
            ],
            "bootstrap"
        );
        const body = JSON.parse(encodeJournalRecord(validation));
        body.basis.reverse();
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("text which is not JSON is rejected", () => {
        expect(isJournalRecordValidationError(tryDecodeJournalRecord("{"))).toBe(true);
        expect(isJournalRecordValidationError(tryDecodeJournalRecord(7))).toBe(true);
    });
});
