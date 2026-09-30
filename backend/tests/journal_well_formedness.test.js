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
            id: "aaaaaaaaa:1",
            context: contextOf([]),
            authorityTime: authorityOf(1000, "0"),
            node: NODE_K,
        },
        NODE_IDENTIFIER,
        { type: "entry_description", description: "hello" },
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
        { type: "entry_description", description: id },
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
                id: "aaaaaaaaa:9007199254740993",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { type: "entry_description" },
            NOW,
            NOW,
            "compute"
        );
        expect(journalRecordIdToString(event.id)).toBe("aaaaaaaaa:9007199254740993");
        const decoded = tryDecodeJournalRecord(encodeJournalRecord(event));
        expect(journalRecordIdToString(decoded.id)).toBe("aaaaaaaaa:9007199254740993");
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
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { type: "entry_description" },
            FUTURE,
            NOW,
            "compute"
        );
        expect(event.createdAt).toBe(FUTURE);
        expect(event.modifiedAt).toBe(NOW);
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [event]]]))).toBeUndefined();
    });

    test("the acceptance is not trivial: a non-canonical instant is rejected", () => {
        const event = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { type: "entry_description" },
            "2020-01-01T00:00:00Z",
            NOW,
            "compute"
        );
        expect(isJournalRecordValidationError(event)).toBe(true);
    });

    test("both timestamps survive a codec round trip unnormalized", () => {
        const event = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { type: "entry_description" },
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
    const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
    const b1 = valueAt("bbbbbbbbb:1", [["aaaaaaaaa", "1"]], NODE_K, 2000);
    const closedC = valueAt("ccccccccc:1", [["bbbbbbbbb", "1"], ["aaaaaaaaa", "1"]], NODE_K, 3000);
    const nonTransitiveC = valueAt("ccccccccc:1", [["bbbbbbbbb", "1"]], NODE_K, 3000);

    test("a transitively closed history is accepted", () => {
        const replica = replicaOf([["aaaaaaaaa", [a1]], ["bbbbbbbbb", [b1]], ["ccccccccc", [closedC]]]);
        expect(validateJournalReplica(replica)).toBeUndefined();
    });

    test("a context which includes an event but omits what it observed is rejected", () => {
        const replica = replicaOf([["aaaaaaaaa", [a1]], ["bbbbbbbbb", [b1]], ["ccccccccc", [nonTransitiveC]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("transitive closure");
    });

    test("a context claiming an unretained coordinate is rejected", () => {
        const unobservedX = valueAt("aaaaaaaaa:1", [["xxxxxxxxx", "1"]], NODE_K, 1000);
        const replica = replicaOf([["aaaaaaaaa", [unobservedX]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("retained-range coverage");
    });

    test("an incomplete own-writer prefix is rejected even when no reference exposes it", () => {
        const a1 = valueAt("aaaaaaaaa:1", [["xxxxxxxxx", "1"]], NODE_K, 1000);
        const x1 = valueAt("xxxxxxxxx:1", [], NODE_K, 500);
        const a2 = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "0"], ["xxxxxxxxx", "0"]], NODE_K, 2000);
        const replica = replicaOf([["aaaaaaaaa", [a1, a2]], ["xxxxxxxxx", [x1]]]);
        const failure = validateJournalReplica(replica);
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("complete local prefix");
    });

    test("a context whose authority does not extend an observed predecessor is rejected", () => {
        const early = valueAt("aaaaaaaaa:1", [], NODE_K, 5000);
        const regressed = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_K, 1000);
        const replica = replicaOf([["aaaaaaaaa", [early, regressed]]]);
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
        const independent = valueAt("ddddddddd:1", [], NODE_K, 1500);
        expect(happenedBefore(independent, a1)).toBe(false);
        expect(happenedBefore(a1, independent)).toBe(false);
    });
});

describe("authority order", () => {
    test("physical dominates logical", () => {
        const later = valueAt("aaaaaaaaa:1", [], NODE_K, 2000);
        const earlier = valueAt("aaaaaaaaa:2", [], NODE_K, 1000);
        expect(authorityCompare(earlier, later)).toBeLessThan(0);
    });

    test("logical breaks equal physical times", () => {
        const first = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "1"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { type: "entry_description" },
            NOW,
            NOW,
            "compute"
        );
        const second = makeValueEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(1000, "2"),
                node: NODE_K,
            },
            NODE_IDENTIFIER,
            { type: "entry_description" },
            NOW,
            NOW,
            "compute"
        );
        expect(authorityCompare(first, second)).toBeLessThan(0);
    });

    test("author breaks equal authority times, sequence breaks equal authors", () => {
        const fromB = valueAt("bbbbbbbbb:1", [], NODE_K, 1000);
        const fromA = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        expect(authorityCompare(fromA, fromB)).toBeLessThan(0);
        const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const a2 = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_K, 1000);
        expect(authorityCompare(a1, a2)).toBeLessThan(0);
    });
});

describe("frontier join", () => {
    test("join takes the componentwise maximum", () => {
        const left = contextOf([["aaaaaaaaa", "3"], ["bbbbbbbbb", "1"]]);
        const right = contextOf([["aaaaaaaaa", "1"], ["ccccccccc", "4"]]);
        const joined = frontierJoin(left, right);
        const shape = [...joined.entries()].map(
            (entry) => journalAuthorToString(entry[0]) + ":" + journalSequenceToString(entry[1])
        );
        expect(shape).toEqual(expect.arrayContaining(["aaaaaaaaa:3", "bbbbbbbbb:1", "ccccccccc:4"]));
        expect(joined.size).toBe(3);
    });

    test("join is idempotent, commutative and associative", () => {
        const a = contextOf([["aaaaaaaaa", "3"], ["bbbbbbbbb", "1"]]);
        const b = contextOf([["aaaaaaaaa", "1"], ["ccccccccc", "4"]]);
        const c = contextOf([["bbbbbbbbb", "7"]]);
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
    const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);

    test("a node scope carries no value reference and needs no causality", () => {
        const concurrent = makeInvalidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            makeNodeScope(),
            "explicit"
        );
        const replica = replicaOf([["aaaaaaaaa", [a1]], ["bbbbbbbbb", [concurrent]]]);
        expect(validateJournalReplica(replica)).toBeUndefined();
        expect(concurrent.scope.value).toBeUndefined();
    });

    test("a value scope naming a causally prior occurrence is accepted", () => {
        const scoped = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            makeValueScope("aaaaaaaaa:1"),
            "propagated"
        );
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [a1, scoped]]]))).toBeUndefined();
    });

    test("a value scope naming a concurrent occurrence is rejected", () => {
        const scoped = makeInvalidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            makeValueScope("aaaaaaaaa:1"),
            "propagated"
        );
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [a1]], ["bbbbbbbbb", [scoped]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("a value scope naming another node's occurrence is rejected", () => {
        const other = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_OTHER, 2000);
        const scoped = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            makeValueScope("aaaaaaaaa:2"),
            "propagated"
        );
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [a1, other, scoped]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a value scope naming a non-value record is rejected", () => {
        const deletion = makeDeleteEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const scoped = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            makeValueScope("aaaaaaaaa:2"),
            "propagated"
        );
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [a1, deletion, scoped]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("proof scope is accepted only for controlled maintenance reasons", () => {
        const maintenance = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            makeProofScope("aaaaaaaaa:1", NODE_D),
            "reset"
        );
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [a1, maintenance]]]))).toBeUndefined();
        const explicit = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            makeProofScope("aaaaaaaaa:1", NODE_D),
            "explicit"
        );
        expect(isJournalRecordValidationError(explicit)).toBe(true);
    });
});

describe("validation target and basis", () => {
    const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);

    test("a validation of a causally prior occurrence is accepted", () => {
        const validation = makeValidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "bootstrap"
        );
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [a1, validation]]]))).toBeUndefined();
    });

    test("a validation of a non-value record is rejected", () => {
        const deletion = makeDeleteEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const validation = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:2",
            [],
            "compute"
        );
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [a1, deletion, validation]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a validation of a concurrent occurrence is rejected", () => {
        const value = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const validation = makeValidateEvent(
            {
                id: "bbbbbbbbb:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
            [],
            "compute"
        );
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [value]], ["bbbbbbbbb", [validation]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("a basis may not name one input twice", () => {
        const validation = makeValidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
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
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
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
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "compute"
        );
        const replica = replicaOf([["aaaaaaaaa", [a1, validation]]]);
        const failure = validateJournalReplica(replica, {
            currentInputKeysOfNode: () => ["x"],
        });
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("an ordinary validation must name exactly the current direct inputs", () => {
        const value = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const input = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_D, 2000);
        const validation = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
            [makeValidationBasisEntry(NODE_D, "aaaaaaaaa:2")],
            "compute"
        );
        const replica = replicaOf([["aaaaaaaaa", [value, input, validation]]]);
        expect(
            validateJournalReplica(replica, { currentInputKeysOfNode: currentInputsOfD })
        ).toBeUndefined();
        const stale = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:2",
            [],
            "compute"
        );
        const incomplete = replicaOf([["aaaaaaaaa", [value, input, stale]]]);
        expect(
            isJournalRecordValidationError(
                validateJournalReplica(incomplete, { currentInputKeysOfNode: currentInputsOfD })
            )
        ).toBe(true);
    });

    test("a publication may not reference a coordinate its own writer allocates later", () => {
        const value = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const forward = makeValidateEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:3",
            [],
            "compute"
        );
        const later = valueAt("aaaaaaaaa:3", [["aaaaaaaaa", "2"]], NODE_K, 3000);
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [value, forward, later]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });
});

describe("stream contiguity", () => {
    test("a contiguous prefix is accepted", () => {
        const first = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const second = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_K, 2000);
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [first, second]]]))).toBeUndefined();
    });

    test("a hole in a claimed prefix is a gap", () => {
        const first = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const third = valueAt("aaaaaaaaa:3", [["aaaaaaaaa", "1"]], NODE_K, 3000);
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [first, third]]]));
        expect(isJournalGapError(failure)).toBe(true);
        expect(failure.missingSequence).toBe("2");
    });

    test("a stream which does not start at one is a gap", () => {
        const second = valueAt("aaaaaaaaa:2", [], NODE_K, 2000);
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [second]]]));
        expect(isJournalGapError(failure)).toBe(true);
        expect(failure.missingSequence).toBe("1");
    });

    // Per-case attribution of the digit-width cases below. Each bullet names the
    // property its case is the primary holder of, and the mapping is not one-to-one
    // in either direction: the cascading decimal borrow is held jointly by three of
    // these cases, and one case's expected coordinate is also pinned by another
    // case's assertion. A reader changing any one of them must therefore expect to
    // move more than a single assertion, and must not read one bullet as the whole
    // of what a case checks:
    //
    // - "a single-writer stream past the digit-width boundary is one contiguous
    //   prefix" holds the decimal borrow across the width boundary: its record at
    //   coordinate 100 claims the coordinate 99, and the replica is accepted.
    // - "a hole past the digit-width boundary is a gap at the coordinate it removed"
    //   is the only holder of the gap report at coordinate 100: the stream removes
    //   that coordinate and the failure reports it as the missing one.
    // - "a record past the digit-width boundary must claim its whole own-writer
    //   prefix" holds that the record on the boundary is rejected against the
    //   borrowed coordinate 99, asserted in the whole error object so the claim
    //   cannot be met by a prefix hole at any other coordinate or width.
    // - "the same own-writer prefix hole away from the width boundary names its own
    //   borrow" holds that the reported expected coordinate is the borrow's own and
    //   not the hole's position: the hole is at coordinate 20 and the report names
    //   19, so the boundary arm's 99 is a borrowed coordinate rather than the
    //   coordinate the hole falls on.
    test("a single-writer stream past the digit-width boundary is one contiguous prefix", () => {
        const stream = [];
        for (let index = 1; index <= 150; index++) {
            stream.push(
                valueAt(
                    "aaaaaaaaa:" + index,
                    index === 1 ? [] : [["aaaaaaaaa", String(index - 1)]],
                    NODE_K,
                    1000 + index
                )
            );
        }
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", stream]]))).toBeUndefined();
    });

    test("a hole past the digit-width boundary is a gap at the coordinate it removed", () => {
        const stream = [];
        for (let index = 1; index <= 150; index++) {
            if (index === 100) {
                continue;
            }
            stream.push(
                valueAt(
                    "aaaaaaaaa:" + index,
                    index === 1 ? [] : [["aaaaaaaaa", String(index - 1)]],
                    NODE_K,
                    1000 + index
                )
            );
        }
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", stream]]));
        expect(isJournalGapError(failure)).toBe(true);
        expect(failure.missingSequence).toBe("100");
    });

    /**
     * @param {number} index
     * @param {string} observed
     * @returns {ReturnType<typeof valueAt>}
     */
    function streamRecord(index, observed) {
        return valueAt(
            "aaaaaaaaa:" + index,
            index === 1 ? [] : [["aaaaaaaaa", observed]],
            NODE_K,
            1000 + index
        );
    }

    /**
     * A 150-record single-writer stream whose own-writer prefix is complete up to
     * `skippedAt`, and which omits coordinate `skippedAt - 1` there.
     * @param {number} skippedAt
     * @returns {Array<ReturnType<typeof valueAt>>}
     */
    function streamWithWrongOwnWriterPrefixAt(skippedAt) {
        const stream = [];
        for (let index = 1; index <= 150; index++) {
            stream.push(streamRecord(index, index === skippedAt ? String(skippedAt - 2) : String(index - 1)));
        }
        return stream;
    }

    test("a record past the digit-width boundary must claim its whole own-writer prefix", () => {
        // Record 100 sits exactly on the width boundary, so the own-writer prefix
        // the record must claim is the decimal borrow from 100, which is 99. The
        // record claims 98 instead. The error the borrow produces is asserted in
        // full, because a bare causal-closure assertion is satisfied by a prefix
        // hole at any coordinate and any width, and would then hold nothing about
        // the borrow.
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", streamWithWrongOwnWriterPrefixAt(100)]]));
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("complete local prefix");
        expect(failure.message).toContain("aaaaaaaaa:100");
        expect(failure.message).toContain("own-writer context is 98 but must be exactly 99");
    });

    test("the same own-writer prefix hole away from the width boundary names its own borrow", () => {
        // The control arm of the boundary test: the same hole one order of
        // magnitude lower, where the expected prefix is 19 and no borrow crosses a
        // width boundary. It is reported with its own expected coordinate at width
        // two. The boundary arm's expected coordinate of 99 is already pinned by
        // that arm's own "must be exactly 99" assertion, so this case is not the
        // only witness of the distinction; what it adds is the same distinction
        // observed away from the width boundary, where no borrow crosses it.
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", streamWithWrongOwnWriterPrefixAt(20)]]));
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("complete local prefix");
        expect(failure.message).toContain("aaaaaaaaa:20");
        expect(failure.message).toContain("own-writer context is 18 but must be exactly 19");
    });

    test("the retained frontier is the greatest retained coordinate per writer", () => {
        const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const a2 = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_K, 2000);
        const b1 = valueAt("bbbbbbbbb:1", [], NODE_K, 1000);
        const frontier = replicaFrontier(replicaOf([["aaaaaaaaa", [a1, a2]], ["bbbbbbbbb", [b1]]]));
        expect(frontier.size).toBe(2);
    });
});

describe("prefix union and forks", () => {
    test("agreeing prefixes union to the longer one", () => {
        const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const a2 = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_K, 2000);
        const left = replicaOf([["aaaaaaaaa", [a1]]]);
        const right = replicaOf([["aaaaaaaaa", [a1, a2]]]);
        const joined = joinReplicaRecords(left, right);
        expect(isJournalReplica(joined)).toBe(true);
        expect([...joined.get([...right.keys()][0])].length).toBe(2);
    });

    test("a same-identity disagreement is a fork, not a graph conflict", () => {
        const first = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const diverged = makeValueEvent(
            {
                id: "aaaaaaaaa:1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            "2-abcdefghi",
            { type: "entry_description", description: "different" },
            NOW,
            NOW,
            "compute"
        );
        const failure = joinReplicaRecords(
            replicaOf([["aaaaaaaaa", [first]]]),
            replicaOf([["aaaaaaaaa", [diverged]]])
        );
        expect(isJournalForkError(failure)).toBe(true);
        expect(failure.recordId).toBe("aaaaaaaaa:1");
        expect(failure.firstMeaning).not.toBe(failure.secondMeaning);
    });

    test("union is idempotent, commutative and associative", () => {
        const a1 = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const a2 = valueAt("aaaaaaaaa:2", [["aaaaaaaaa", "1"]], NODE_K, 2000);
        const a3 = valueAt("aaaaaaaaa:3", [["aaaaaaaaa", "2"]], NODE_K, 3000);
        const b1 = valueAt("bbbbbbbbb:1", [], NODE_K, 1000);
        const one = replicaOf([["aaaaaaaaa", [a1]], ["bbbbbbbbb", [b1]]]);
        const two = replicaOf([["aaaaaaaaa", [a1, a2]]]);
        const three = replicaOf([["aaaaaaaaa", [a1, a2, a3]]]);
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
        const record = makeWriterStateRecord("aaaaaaaaa:2", 4);
        expect(record.kind).toBe("writer-state");
        expect(record.context).toBeUndefined();
    });
});

describe("writer state monotonicity", () => {
    test("an increasing watermark is accepted", () => {
        const first = makeWriterStateRecord("aaaaaaaaa:1", 1);
        const second = makeWriterStateRecord("aaaaaaaaa:2", 7);
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [first, second]]]))).toBeUndefined();
    });

    test("a repeated watermark is accepted", () => {
        const first = makeWriterStateRecord("aaaaaaaaa:1", 4);
        const second = makeWriterStateRecord("aaaaaaaaa:2", 4);
        expect(validateJournalReplica(replicaOf([["aaaaaaaaa", [first, second]]]))).toBeUndefined();
    });

    test("a decreasing watermark is rejected", () => {
        const first = makeWriterStateRecord("aaaaaaaaa:1", 7);
        const second = makeWriterStateRecord("aaaaaaaaa:2", 3);
        const failure = validateJournalReplica(replicaOf([["aaaaaaaaa", [first, second]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("a negative or fractional watermark is not a current-format record", () => {
        expect(isJournalRecordValidationError(makeWriterStateRecord("aaaaaaaaa:1", -1))).toBe(true);
        expect(isJournalRecordValidationError(makeWriterStateRecord("aaaaaaaaa:1", 1.5))).toBe(true);
    });
});

describe("current-format codec", () => {
    test("every core record kind round trips", () => {
        const value = valueAt("aaaaaaaaa:1", [], NODE_K, 1000);
        const deletion = makeDeleteEvent(
            {
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const validation = makeValidateEvent(
            {
                id: "aaaaaaaaa:3",
                context: contextOf([["aaaaaaaaa", "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "bootstrap"
        );
        const invalidation = makeInvalidateEvent(
            {
                id: "aaaaaaaaa:4",
                context: contextOf([["aaaaaaaaa", "3"]]),
                authorityTime: authorityOf(4000, "0"),
                node: NODE_K,
            },
            makeValueScope("aaaaaaaaa:1"),
            "propagated"
        );
        const state = makeWriterStateRecord("aaaaaaaaa:5", 12);
        for (const record of [value, deletion, validation, invalidation, state]) {
            const text = encodeJournalRecord(record);
            const decoded = tryDecodeJournalRecord(text);
            expect(encodeJournalRecord(decoded)).toBe(text);
        }
    });

    test("an unknown record kind is rejected rather than upcast", () => {
        const failure = currentFormatValidateRecord({
            id: "aaaaaaaaa:1",
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
                id: "aaaaaaaaa:2",
                context: contextOf([["aaaaaaaaa", "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "aaaaaaaaa:1",
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
