/**
 * Regression tests for the six correctness findings in the review of the Journal
 * record layer at head a0d37f15.
 *
 * The first six blocks below pin one finding each; the seventh pins the record
 * layer's standing invariants after those fixes. The behaviour asserted is the
 * external one:
 * what a validator returns, what a reader delivers, what a constructor rejects,
 * and what a record's canonical encoding is after a caller has finished with the
 * objects it passed in.
 */

const {
    compareJournalSequence,
    currentFormatValidateRecord,
    encodeJournalRecord,
    isJournalAuthor,
    isJournalCausalClosureError,
    isJournalError,
    isJournalRecordValidationError,
    isJournalReferenceCausalityError,
    isJournalReplica,
    isSameJournalAuthor,
    journalAuthorToString,
    journalRecordIdToString,
    journalSequenceToString,
    makeAuthorityTime,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalAuthor,
    makeJournalFrontier,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeJournalSequence,
    makeNodeScope,
    makeValueEvent,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueScope,
    makeWriterStateRecord,
    nodeKeyToCanonicalString,
    parseJournalRecordId,
    predecessorJournalSequence,
    validateCurrentShapeBasis,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");

const {
    readerOverIterable,
} = require("../src/generators/incremental_graph/journal/oracle");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const NODE_OLD_INPUT = { head: "event", args: [{ id: 9 }] };
const NODE_REMOVED_FAMILY = { head: "retiredHead", args: [{ id: 7 }] };
const NODE_IDENTIFIER = "1-abcdefghi";
const NOW = "2020-01-01T00:00:00.000Z";
const WRITER_A = "aaaaaaaaa";
const WRITER_B = "bbbbbbbbb";

function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

function authorityOf(physical, logical) {
    return makeAuthorityTime(physical, logical);
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
        { type: "entry_description", description: "payload of " + id },
        NOW,
        NOW,
        "compute"
    );
}

function replicaOf(streams) {
    return makeJournalReplica(streams);
}

function valueBody(id) {
    return JSON.parse(encodeJournalRecord(valueAt(id, [], NODE_K, 1000)));
}

describe("finding 1: a multi-digit sequence has a real predecessor", () => {
    /**
     * @param {string} digits
     * @returns {string}
     */
    function predecessorOf(digits) {
        const predecessor = predecessorJournalSequence(makeJournalSequence(digits));
        if (predecessor instanceof Error) {
            throw new Error("the record layer reported no predecessor for " + digits);
        }
        return journalSequenceToString(predecessor);
    }

    test("the borrow boundaries are exact, not digit-local", () => {
        // A borrow crosses the whole tail of the number, so `10` is `9` and not
        // `09`, and `100` is `99` and not `099`.
        expect(predecessorOf("1")).toBe("0");
        expect(predecessorOf("9")).toBe("8");
        expect(predecessorOf("10")).toBe("9");
        expect(predecessorOf("11")).toBe("10");
        expect(predecessorOf("13")).toBe("12");
        expect(predecessorOf("19")).toBe("18");
        expect(predecessorOf("20")).toBe("19");
        expect(predecessorOf("99")).toBe("98");
        expect(predecessorOf("100")).toBe("99");
        expect(predecessorOf("101")).toBe("100");
        expect(predecessorOf("123")).toBe("122");
        expect(predecessorOf("1000")).toBe("999");
    });

    test("the result is canonical at any width, including above the double range", () => {
        expect(predecessorOf("9007199254740993")).toBe("9007199254740992");
        expect(predecessorOf("1000000000000000000000")).toBe("999999999999999999999");
        expect(predecessorOf("9007199254740992")).toBe("9007199254740991");
    });

    test("every coordinate in a wide range decrements to the one below it", () => {
        // The specific cases above pin the borrow boundaries; this pins the whole
        // function, so a regression which happens to satisfy `10 -> 9` but not,
        // say, `137 -> 136` still goes red.
        for (let digits = 1n; digits <= 5000n; digits++) {
            expect(predecessorOf(String(digits))).toBe(String(digits - 1n));
        }
    });

    test("zero has no predecessor", () => {
        expect(
            isJournalRecordValidationError(predecessorJournalSequence(makeJournalSequence("0")))
        ).toBe(true);
    });

    test("a writer's own context coordinate is its exact predecessor, past one digit", () => {
        // The rule `predecessorJournalSequence` feeds: a record at `A:10` observes
        // its own writer through `A:9` and nothing else.
        const stream = [];
        for (let sequence = 1; sequence <= 12; sequence++) {
            stream.push(
                valueAt(
                    WRITER_A + ":" + String(sequence),
                    sequence === 1 ? [] : [[WRITER_A, String(sequence - 1)]],
                    NODE_K,
                    1000 + sequence
                )
            );
        }
        expect(validateJournalReplica(replicaOf([[WRITER_A, stream]]))).toBeUndefined();
    });

    test("a wrong own-writer context coordinate is still rejected past one digit", () => {
        // The acceptance above is not trivial: a record at `A:11` which claims to
        // have observed `A:9` rather than `A:10` is a hole in its own prefix.
        const stream = [];
        for (let sequence = 1; sequence <= 11; sequence++) {
            const coordinates = sequence === 11 ? [[WRITER_A, "9"]] : sequence === 1 ? [] : [[WRITER_A, String(sequence - 1)]];
            stream.push(
                valueAt(WRITER_A + ":" + String(sequence), coordinates, NODE_K, 1000 + sequence)
            );
        }
        const failure = validateJournalReplica(replicaOf([[WRITER_A, stream]]));
        expect(isJournalCausalClosureError(failure)).toBe(true);
        expect(failure.rule).toBe("complete local prefix");
    });
});

describe("finding 2: a record and its replica are deeply immutable", () => {
    test("a record's canonical meaning cannot be changed through the object it was built from", () => {
        const node = { head: "event", args: [{ id: 1 }] };
        const payload = { type: "entry_description", description: "original" };
        const context = contextOf([]);
        const authorityTime = authorityOf(1000, "0");
        const record = makeValueEvent(
            { id: WRITER_A + ":1", context, authorityTime, node },
            NODE_IDENTIFIER,
            payload,
            NOW,
            NOW,
            "compute"
        );
        if (record instanceof Error) {
            throw new Error("the record layer rejected a valid value event");
        }
        const meaning = encodeJournalRecord(record);

        // The caller's own objects are still the caller's to change.
        node.args[0].id = 99;
        payload.description = "rewritten";
        expect(encodeJournalRecord(record)).toBe(meaning);
    });

    test("a nested nominal value cannot be reassigned or edited", () => {
        // A frozen property is unwritable, so an assignment in non-strict code
        // fails silently. The claim under test is therefore that the record still
        // reads as the record which was validated, not that a particular mode
        // threw.
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        if (record instanceof Error) {
            throw new Error("the record layer rejected a valid value event");
        }
        const meaning = encodeJournalRecord(record);
        record.id.sequence = makeJournalSequence("7");
        record.authorityTime.physical = 999999;
        record.node.args[0].id = 42;
        record.payload.description = "rewritten";
        expect(journalRecordIdToString(record.id)).toBe(WRITER_A + ":1");
        expect(record.authorityTime.physical).toBe(1000);
        expect(record.node.args[0].id).toBe(1);
        expect(record.payload.description).toBe("payload of " + WRITER_A + ":1");
        expect(encodeJournalRecord(record)).toBe(meaning);
        expect(Object.isFrozen(record.id)).toBe(true);
        expect(Object.isFrozen(record.authorityTime)).toBe(true);
        expect(Object.isFrozen(record.id.sequence)).toBe(true);
        expect(Object.isFrozen(record.node)).toBe(true);
        expect(Object.isFrozen(record.node.args)).toBe(true);
        expect(Object.isFrozen(record.payload)).toBe(true);
    });

    test("a validate event's basis cannot be edited through the array passed in", () => {
        const basis = [makeValidationBasisEntry(NODE_D, "unknown")];
        const target = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        if (target instanceof Error) {
            throw new Error("the record layer rejected a valid value event");
        }
        const validation = makeValidateEvent(
            {
                id: WRITER_A + ":2",
                context: contextOf([[WRITER_A, "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            target.id,
            basis,
            "bootstrap"
        );
        if (validation instanceof Error) {
            throw new Error("the record layer rejected a valid validation");
        }
        const meaning = encodeJournalRecord(validation);
        basis.push(makeValidationBasisEntry(NODE_K, "unknown"));
        expect(encodeJournalRecord(validation)).toBe(meaning);
        expect(Object.isFrozen(validation.basis)).toBe(true);
        expect(validation.basis).toHaveLength(1);
        expect(encodeJournalRecord(validation)).toBe(meaning);
    });

    test("an invalidation scope cannot be edited after the record is built", () => {
        const scope = makeValueScope(WRITER_A + ":1");
        const invalidation = makeInvalidateEvent(
            {
                id: WRITER_A + ":2",
                context: contextOf([[WRITER_A, "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            scope,
            "propagated"
        );
        if (invalidation instanceof Error) {
            throw new Error("the record layer rejected a valid invalidation");
        }
        const meaning = encodeJournalRecord(invalidation);
        scope.value = makeJournalSequence("4");
        expect(encodeJournalRecord(invalidation)).toBe(meaning);
        expect(Object.isFrozen(invalidation.scope)).toBe(true);
    });

    test("a replica's own stream arrays are frozen", () => {
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const replica = replicaOf([[WRITER_A, [record]]]);
        const stream = replica.get(makeJournalAuthor(WRITER_A));
        if (stream === undefined) {
            throw new Error("the replica does not hold the stream it was given");
        }
        expect(Object.isFrozen(stream)).toBe(true);
        expect(() => {
            stream.push(record);
        }).toThrow();
    });

    test("the record layer owns the value it was given, and the caller keeps theirs", () => {
        // Immutability by freezing the caller's object would make the caller's own
        // state depend on whether a record had been built from it, so the record
        // must hold a copy and leave the caller's object writable.
        const node = { head: "event", args: [{ id: 1 }] };
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        if (record instanceof Error) {
            throw new Error("the record layer rejected a valid value event");
        }
        expect(record.node).not.toBe(node);
        expect(Object.isFrozen(node)).toBe(false);
        expect(node.args[0].id).toBe(1);
    });
});

describe("finding 3: a historical certificate is history, not corruption", () => {
    /**
     * The current schema says `K` has exactly one direct input, `D`, and says
     * nothing at all about any other node family. A node the schema does not
     * mention therefore has no entry here, which is what a removed node family
     * looks like from the current schema.
     * @param {string} nodeKeyString
     * @returns {Array<string> | undefined}
     */
    function currentInputsOfK(nodeKeyString) {
        if (nodeKeyString !== nodeKeyToCanonicalString(NODE_K)) {
            return undefined;
        }
        return [nodeKeyToCanonicalString(NODE_D)];
    }

    /**
     * A current-schema certificate of `A:1` for `K`, followed by a value of the
     * input it names, followed by a certificate which names a *retired* input.
     * @returns {Array<object>}
     */
    function historyWithRetiredInput() {
        const value = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const currentInput = valueAt(WRITER_A + ":2", [[WRITER_A, "1"]], NODE_D, 1100);
        const currentCertificate = makeValidateEvent(
            {
                id: WRITER_A + ":3",
                context: contextOf([[WRITER_A, "2"]]),
                authorityTime: authorityOf(1200, "0"),
                node: NODE_K,
            },
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")],
            "compute"
        );
        const retiredInput = valueAt(WRITER_A + ":4", [[WRITER_A, "3"]], NODE_OLD_INPUT, 1300);
        const historicalCertificate = makeValidateEvent(
            {
                id: WRITER_A + ":5",
                context: contextOf([[WRITER_A, "4"]]),
                authorityTime: authorityOf(1400, "0"),
                node: NODE_K,
            },
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_OLD_INPUT, WRITER_A + ":4")],
            "compute"
        );
        return [value, currentInput, currentCertificate, retiredInput, historicalCertificate];
    }

    test("whole-history validation accepts a certificate which no longer names the current input set", () => {
        expect(validateJournalReplica(replicaOf([[WRITER_A, historyWithRetiredInput()]]))).toBeUndefined();
    });

    test("whole-history validation does not take a current schema at all", () => {
        // The finding was that supplying the current schema turned intelligible
        // history into corruption, so the fix has to hold for a caller who offers
        // one. A validator which still accepted a schema argument would pass the
        // acceptance above and still corrupt history, so the argument itself is
        // asserted gone.
        const replica = replicaOf([[WRITER_A, historyWithRetiredInput()]]);
        expect(validateJournalReplica.length).toBe(1);
        expect(
            validateJournalReplica(replica, { currentInputKeysOfNode: currentInputsOfK })
        ).toBeUndefined();
    });

    test("whole-history validation accepts a certificate on a node family the current schema has removed", () => {
        const value = valueAt(WRITER_A + ":1", [], NODE_REMOVED_FAMILY, 1000);
        const input = valueAt(WRITER_A + ":2", [[WRITER_A, "1"]], NODE_D, 1100);
        const certificate = makeValidateEvent(
            {
                id: WRITER_A + ":3",
                context: contextOf([[WRITER_A, "2"]]),
                authorityTime: authorityOf(1200, "0"),
                node: NODE_REMOVED_FAMILY,
            },
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")],
            "compute"
        );
        expect(validateJournalReplica(replicaOf([[WRITER_A, [value, input, certificate]]]))).toBeUndefined();
        expect(
            validateJournalReplica(replicaOf([[WRITER_A, [value, input, certificate]]]), {
                currentInputKeysOfNode: currentInputsOfK,
            })
        ).toBeUndefined();
    });

    test("a current-schema certificate is still accepted", () => {
        const value = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const input = valueAt(WRITER_A + ":2", [[WRITER_A, "1"]], NODE_D, 1100);
        const certificate = makeValidateEvent(
            {
                id: WRITER_A + ":3",
                context: contextOf([[WRITER_A, "2"]]),
                authorityTime: authorityOf(1200, "0"),
                node: NODE_K,
            },
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")],
            "compute"
        );
        expect(
            validateJournalReplica(replicaOf([[WRITER_A, [value, input, certificate]]]))
        ).toBeUndefined();
    });

    test("the acceptance is not trivial: the reference rules still reject an ordinary unknown basis entry", () => {
        // The reason rule belongs to the certificate itself, so it is a whole-history
        // rule and stays enforced. What moved out is only the current-shape
        // equality, and this is the test which says so.
        const value = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const certificate = makeValidateEvent(
            {
                id: WRITER_A + ":2",
                context: contextOf([[WRITER_A, "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_D, "unknown")],
            "compute"
        );
        expect(isJournalRecordValidationError(certificate)).toBe(false);
        const failure = validateJournalReplica(replicaOf([[WRITER_A, [value, certificate]]]));
        expect(isJournalRecordValidationError(failure)).toBe(true);
        expect(failure.message).toContain('"unknown"');
    });

    test("the reference rules still reject a validation of an unobserved occurrence", () => {
        const value = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const concurrent = makeValidateEvent(
            {
                id: WRITER_B + ":1",
                context: contextOf([]),
                authorityTime: authorityOf(1000, "0"),
                node: NODE_K,
            },
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_D, WRITER_A + ":1")],
            "compute"
        );
        const failure = validateJournalReplica(replicaOf([[WRITER_A, [value]], [WRITER_B, [concurrent]]]));
        expect(isJournalReferenceCausalityError(failure)).toBe(true);
    });

    test("current-input equality is a current-shape question, decided outside whole-history validation", () => {
        const history = historyWithRetiredInput();
        const historicalCertificate = history[4];
        if (historicalCertificate === undefined) {
            throw new Error("the fixture did not build a historical certificate");
        }
        // The current-shape rule still exists, and still rejects the historical
        // certificate as *proof*. It simply is not a corruption verdict.
        expect(
            isJournalRecordValidationError(
                validateCurrentShapeBasis(historicalCertificate, currentInputsOfK)
            )
        ).toBe(true);
    });
});

describe("finding 4: the current-format boundary rejects what it does not define", () => {
    test("a textual physical time is not coerced into a number", () => {
        const body = valueBody(WRITER_A + ":1");
        body.authorityTime = { physical: "0", logical: "0" };
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("a numeric context coordinate is not coerced into text", () => {
        const body = valueBody(WRITER_A + ":1");
        body.context = [[WRITER_A, 1]];
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("a node key text which is merely parseable is rejected, not reserialized", () => {
        const canonical = valueBody(WRITER_A + ":1").node;
        for (const noncanonical of [
            '{"head": "event", "args": [{"id": 1}]}',
            '{"args":[{"id":1}],"head":"event"}',
            '{"head":"event","args":[{"id":1}],"extra":true}',
            canonical + " ",
        ]) {
            const body = valueBody(WRITER_A + ":1");
            body.node = noncanonical;
            expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
        }
    });

    test("an arbitrary object is not a current-version ComputedValue", () => {
        const body = valueBody(WRITER_A + ":1");
        body.payload = { garbage: true };
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("a payload which names a current ComputedValue variant is accepted", () => {
        const body = valueBody(WRITER_A + ":1");
        body.payload = { type: "events_count", count: 3 };
        expect(currentFormatValidateRecord(body)).toBeUndefined();
    });

    test("an arbitrary non-empty string is not a NodeIdentifier", () => {
        for (const identifier of ["", "  ", "not-an-identifier", "1-", "-abcdefghi", "1-ABCDEFGHI"]) {
            const body = valueBody(WRITER_A + ":1");
            body.nodeIdentifier = identifier;
            expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
        }
    });

    test("an identifier of the allocation form is accepted", () => {
        const body = valueBody(WRITER_A + ":1");
        body.nodeIdentifier = "1z-abcdefghi";
        expect(currentFormatValidateRecord(body)).toBeUndefined();
    });

    test("a record id whose author is not a database fingerprint is rejected", () => {
        for (const author of ["hostname.example", "not-a-fingerprint", "A", "short"]) {
            const body = valueBody(WRITER_A + ":1");
            body.id = author + ":1";
            expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
        }
    });

    test("a writer identity is a database fingerprint, so an encoded id can be parsed again", () => {
        expect(isJournalRecordValidationError(makeJournalAuthor("a:b"))).toBe(true);
        expect(isJournalRecordValidationError(makeJournalAuthor("hostname.example"))).toBe(true);
        expect(isJournalAuthor(makeJournalAuthor("aaaaaaaaa"))).toBe(true);
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        if (record instanceof Error) {
            throw new Error("the record layer rejected a valid value event");
        }
        const parsed = parseJournalRecordId(journalRecordIdToString(record.id));
        expect(parsed instanceof Error).toBe(false);
        if (parsed instanceof Error) {
            throw new Error("the record layer could not parse an id it wrote");
        }
        expect(journalRecordIdToString(parsed)).toBe(WRITER_A + ":1");
    });

    test("an authority time with an unknown member is rejected", () => {
        const body = valueBody(WRITER_A + ":1");
        body.authorityTime = { physical: 1000, logical: "0", extra: true };
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("a context which is not in canonical order is rejected rather than re-sorted", () => {
        const body = valueBody(WRITER_A + ":1");
        body.context = [
            [WRITER_B, "1"],
            [WRITER_A, "1"],
        ];
        expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
    });

    test("the acceptance is not trivial: a canonical record still decodes", () => {
        expect(currentFormatValidateRecord(valueBody(WRITER_A + ":1"))).toBeUndefined();
    });
});

describe("finding 5: a reader is bounded by the retained length it declares", () => {
    test("a record beyond the declared retained length is a failure, not a delivery", () => {
        const first = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const second = valueAt(WRITER_A + ":2", [[WRITER_A, "1"]], NODE_K, 2000);
        const third = valueAt(WRITER_A + ":3", [[WRITER_A, "2"]], NODE_K, 3000);
        const reader = readerOverIterable(WRITER_A, [first, second, third], makeJournalSequence("2"));
        const delivered = [];
        for (;;) {
            const record = reader.nextRecord();
            if (record === undefined) {
                break;
            }
            delivered.push(journalRecordIdToString(record.id));
        }
        expect(delivered).toEqual([WRITER_A + ":1", WRITER_A + ":2"]);
        expect(reader.failure()).toBeDefined();
        expect(isJournalRecordValidationError(reader.failure())).toBe(true);
    });

    test("a prefix which ends before the length it claims is still a gap", () => {
        const first = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const reader = readerOverIterable(WRITER_A, [first], makeJournalSequence("2"));
        expect(reader.nextRecord()).toBeDefined();
        expect(reader.nextRecord()).toBeUndefined();
        expect(reader.failure()).toBeDefined();
        expect(isJournalCausalClosureError(reader.failure())).toBe(false);
    });

    test("a reader over a prefix which matches its declared length delivers the whole prefix", () => {
        const first = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const second = valueAt(WRITER_A + ":2", [[WRITER_A, "1"]], NODE_K, 2000);
        const reader = readerOverIterable(WRITER_A, [first, second], makeJournalSequence("2"));
        const delivered = [];
        for (;;) {
            const record = reader.nextRecord();
            if (record === undefined) {
                break;
            }
            delivered.push(journalRecordIdToString(record.id));
        }
        expect(delivered).toEqual([WRITER_A + ":1", WRITER_A + ":2"]);
        expect(reader.failure()).toBeUndefined();
    });

    test("the boundary holds past one digit, where the length itself has several digits", () => {
        const stream = [];
        for (let sequence = 1; sequence <= 12; sequence++) {
            stream.push(
                valueAt(
                    WRITER_A + ":" + String(sequence),
                    sequence === 1 ? [] : [[WRITER_A, String(sequence - 1)]],
                    NODE_K,
                    1000 + sequence
                )
            );
        }
        const reader = readerOverIterable(WRITER_A, stream, makeJournalSequence("10"));
        let delivered = 0;
        for (;;) {
            if (reader.nextRecord() === undefined) {
                break;
            }
            delivered++;
        }
        expect(delivered).toBe(10);
        expect(reader.failure()).toBeDefined();
    });
});

describe("finding 6: a replica names each writer once", () => {
    test("two authors with the same name are one writer, and a replica may not hold both", () => {
        const first = makeJournalAuthor(WRITER_A);
        const second = makeJournalAuthor(WRITER_A);
        expect(isSameJournalAuthor(first, second)).toBe(true);
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const failure = makeJournalReplica([
            [first, [record]],
            [second, [record]],
        ]);
        expect(isJournalRecordValidationError(failure)).toBe(true);
        expect(failure.message).toContain(WRITER_A);
    });

    test("the rejection is an error value, so a caller never has to catch a throw", () => {
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        let failure;
        try {
            failure = makeJournalReplica([
                [makeJournalAuthor(WRITER_A), [record]],
                [makeJournalAuthor(WRITER_A), [record]],
            ]);
        } catch (thrown) {
            throw new Error("the replica constructor threw instead of returning an error: " + String(thrown));
        }
        expect(isJournalRecordValidationError(failure)).toBe(true);
    });

    test("the mechanism the duplicate writer used to reach: a frontier cannot name one writer twice", () => {
        // The defect behind the throw. `replicaFrontier` built a frontier from
        // the replica keys, and a frontier with two keys for one writer is not
        // buildable, so validation threw a plain `Error` from inside a validator
        // whose contract is to return a Journal error. The replica constructor
        // rejects the duplicate before a frontier can ever be built from it, and
        // the frontier rule itself is unchanged and still rejects the duplicate.
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const first = makeJournalAuthor(WRITER_A);
        const second = makeJournalAuthor(WRITER_A);
        expect(
            isJournalRecordValidationError(
                makeJournalFrontier([
                    [first, record.id.sequence],
                    [second, record.id.sequence],
                ])
            )
        ).toBe(true);
        expect(
            isJournalRecordValidationError(
                makeJournalReplica([
                    [first, [record]],
                    [second, [record]],
                ])
            )
        ).toBe(true);
    });

    test("a rejected duplicate arrives as a Journal error, not as a thrown Error", () => {
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const failure = makeJournalReplica([
            [makeJournalAuthor(WRITER_A), [record]],
            [makeJournalAuthor(WRITER_A), [record]],
        ]);
        expect(isJournalError(failure)).toBe(true);
    });

    test("a replica of one stream per writer is accepted and holds one entry for it", () => {
        const first = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const second = valueAt(WRITER_B + ":1", [], NODE_K, 1500);
        const replica = replicaOf([
            [WRITER_A, [first]],
            [WRITER_B, [second]],
        ]);
        expect(isJournalReplica(replica)).toBe(true);
        expect(replica.size).toBe(2);
        expect(validateJournalReplica(replica)).toBeUndefined();
    });

    test("lookup is by writer identity, not by object identity", () => {
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const replica = replicaOf([[makeJournalAuthor(WRITER_A), [record]]]);
        const equivalentAuthor = makeJournalAuthor(WRITER_A);
        expect(journalAuthorToString(equivalentAuthor)).toBe(WRITER_A);
        expect(replica.get(equivalentAuthor)).toHaveLength(1);
    });

    test("an ordinary value stream and a writer-state stream are both accepted", () => {
        const record = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const state = makeWriterStateRecord(WRITER_A + ":2", 4);
        expect(validateJournalReplica(replicaOf([[WRITER_A, [record, state]]]))).toBeUndefined();
    });
});

describe("the record layer's own invariants after these fixes", () => {
    test("a record id's author is the writer's fingerprint and its sequence is canonical", () => {
        const record = valueAt(WRITER_A + ":9007199254740993", [], NODE_K, 1000);
        if (record instanceof Error) {
            throw new Error("the record layer rejected a valid value event");
        }
        expect(journalSequenceToString(record.id.sequence)).toBe("9007199254740993");
        expect(compareJournalSequence(record.id.sequence, makeJournalSequence("9007199254740992"))).toBeGreaterThan(0);
    });

    test("a delete event and a node-scoped invalidation still round trip", () => {
        const first = valueAt(WRITER_A + ":1", [], NODE_K, 1000);
        const deletion = makeDeleteEvent(
            {
                id: WRITER_A + ":2",
                context: contextOf([[WRITER_A, "1"]]),
                authorityTime: authorityOf(2000, "0"),
                node: NODE_K,
            },
            "operation"
        );
        const invalidation = makeInvalidateEvent(
            {
                id: WRITER_A + ":3",
                context: contextOf([[WRITER_A, "2"]]),
                authorityTime: authorityOf(3000, "0"),
                node: NODE_K,
            },
            makeNodeScope(),
            "explicit"
        );
        expect(validateJournalReplica(replicaOf([[WRITER_A, [first, deletion, invalidation]]]))).toBeUndefined();
    });
});
