/**
 * Regression tests for the two correctness blockers raised by the independent
 * review of the Journal record layer at 4f249032.
 *
 * - Blocker 1: `ComputedValue` was discriminated on its `type` tag alone, so a
 *   persisted payload whose members did not match the union member it named was
 *   accepted by the record layer, survived the canonical codec and was then
 *   consumed as the value it claimed to be.
 * - Blocker 2: `validateCurrentShapeBasis` and `isEligibleCertificate` were two
 *   implementations of the same current-shape rule which disagreed, in both
 *   directions, on concrete inputs, and the journal suite could not tell which
 *   answer the oracle used.
 *
 * Each test below is named for the behaviour it pins.
 *
 * One of the review's decisive mutations is pinned by name of behaviour. The
 * review calls the deletion of `isEligibleCertificate`'s own current-shape block
 * decisive at `docs/reviews/BOARD92-INDEPENDENT-REVIEW.md:158` ("Mutation 3 (the
 * decisive one)"), lists the same mutation as M5 at `:314`, and calls M5 the
 * sharpest of the mutations that stayed green at `:324`. The test named "the two
 * predicates agree on every reason and every input set" pins the agreement of
 * the two predicates, which is exactly what that mutation removed. The review
 * also calls M1 and M2 decisive at `:324` without describing either mutation
 * anywhere in the document, so no test here names them.
 */

const {
    currentFormatValidateRecord,
    encodeJournalRecord,
    isJournalError,
    isJournalRecordValidationError,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalFrontierFromText,
    makeJournalReplica,
    makeValidationBasisEntry,
    makeValidateEvent,
    makeValueEvent,
    nodeKeyToCanonicalString,
    parseJournalRecordId,
    validateCurrentShapeBasis,
    validateJournalReplica,
} = require("../src/generators/incremental_graph/journal");

const {
    isEligibleCertificate,
    makeReplicaSource,
    projectRetainedJournal,
} = require("../src/generators/incremental_graph/journal/oracle");

const {
    COMPUTED_VALUE_TYPE_TAGS,
    computedValueViolation,
} = require("../src/generators/incremental_graph/database");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_D = { head: "event", args: [{ id: 2 }] };
const NODE_RETIRED_INPUT = { head: "event", args: [{ id: 9 }] };
const NODE_REMOVED_FAMILY = { head: "retiredHead", args: [{ id: 7 }] };
const NOW = "2020-01-01T00:00:00.000Z";
const WRITER_A = "aaaaaaaaa";
const KEY_K = nodeKeyToCanonicalString(NODE_K);
const KEY_D = nodeKeyToCanonicalString(NODE_D);

const CREATOR = {
    name: "tester",
    uuid: "0f6c1a1e-0000-4000-8000-000000000000",
    version: "1.0.0",
    hostname: "host.example",
};

const SERIALIZED_EVENT = {
    id: "aaaaaaaaa:1",
    date: "2020-01-01T00:00:00.000Z",
    original: "original",
    input: "input",
    creator: CREATOR,
};

const EVENT = {
    id: { identifier: "aaaaaaaaa:1" },
    date: { _luxonDateTime: "2020-01-01T00:00:00.000Z" },
    original: "original",
    input: "input",
    creator: CREATOR,
};

const TRANSCRIPTION = {
    text: "transcribed",
    transcriber: { name: "whisper", creator: "someone" },
    creator: CREATOR,
};

const CONFIG = { help: "help", shortcuts: [{ pattern: "a", replacement: "b" }] };

const ONTOLOGY = {
    types: [{ name: "food", description: "something eaten" }],
    modifiers: [{ name: "spicy", description: "hot", only_for_type: "food" }],
};

/**
 * One canonical, valid payload per member of the `ComputedValue` union. A member
 * added to the union without an entry here, or an entry here whose member is no
 * longer in the union, is what the correspondence tests below catch.
 * @type {ReadonlyArray<{tag: string, payload: object}>}
 */
const VALID_MEMBERS = [
    { tag: "all_events", payload: { type: "all_events", events: [SERIALIZED_EVENT] } },
    { tag: "config", payload: { type: "config", config: CONFIG } },
    { tag: "meta_events", payload: { type: "meta_events", meta_events: [{ action: "add", event: EVENT }] } },
    { tag: "event_context", payload: { type: "event_context", contexts: [{ eventId: "aaaaaaaaa:1", context: [EVENT] }] } },
    { tag: "event", payload: { type: "event", value: SERIALIZED_EVENT } },
    { tag: "basic_context", payload: { type: "basic_context", eventId: "aaaaaaaaa:1", events: [SERIALIZED_EVENT] } },
    { tag: "calories", payload: { type: "calories", value: 42 } },
    { tag: "transcription", payload: { type: "transcription", value: TRANSCRIPTION } },
    { tag: "event_transcription", payload: { type: "event_transcription", event: EVENT, transcription: TRANSCRIPTION } },
    { tag: "sorted_events_descending", payload: { type: "sorted_events_descending", events: [SERIALIZED_EVENT] } },
    { tag: "sorted_events_ascending", payload: { type: "sorted_events_ascending", events: [SERIALIZED_EVENT] } },
    { tag: "last_entries", payload: { type: "last_entries", n: 10, events: [SERIALIZED_EVENT] } },
    { tag: "first_entries", payload: { type: "first_entries", n: 10, events: [SERIALIZED_EVENT] } },
    { tag: "events_count", payload: { type: "events_count", count: 1 } },
    { tag: "event_audios_list", payload: { type: "event_audios_list", event: SERIALIZED_EVENT, audioPaths: ["a.wav"] } },
    { tag: "entry_description", payload: { type: "entry_description", description: "typed text" } },
    { tag: "diary_most_important_info_summary", payload: { type: "diary_most_important_info_summary", markdown: "#", summaryDate: "2020-01-01", processedEntries: { "aaaaaaaaa:1": "2020-01-01" }, updatedAt: "2020-01-01T00:00:00.000Z", model: "m", version: "1" } },
    { tag: "ontology", payload: { type: "ontology", ontology: ONTOLOGY } },
];

function contextOf(coordinates) {
    return makeJournalFrontierFromText(coordinates);
}

function authorityOf(physical) {
    return makeAuthorityTime(physical, "0");
}

/**
 * A distinct physical identifier per node, so a history which presents two
 * distinct nodes does not present them under one identifier. Two present nodes
 * which do select one identifier is unsupported current state and has its own
 * rule, so a fixture which needs two nodes needs two identifiers.
 * @param {object} node
 * @returns {import("../src/generators/incremental_graph/database/types").NodeIdentifier}
 */
function identifierOfNode(node) {
    return node.args[0].id + "-abcdefghi";
}

function valueAt(id, coordinates, node, payload, physical) {
    return makeValueEvent(
        {
            id,
            context: contextOf(coordinates),
            authorityTime: authorityOf(physical === undefined ? 1000 : physical),
            node,
        },
        identifierOfNode(node),
        payload,
        NOW,
        NOW,
        "compute"
    );
}

/**
 * The canonical persisted text of a value record whose payload is `payload`.
 * The body is built from a known-good payload and the payload is then replaced,
 * so a payload the record layer rejects can still be handed to the persisted-text
 * boundary reader, which is where the acceptance in question happens.
 * @param {string} id
 * @param {unknown} payload
 * @returns {object}
 */
function valueBodyWithPayload(id, payload) {
    const record = valueAt(id, [], NODE_K, { type: "events_count", count: 0 });
    if (record instanceof Error) {
        throw new Error("the fixture could not build a value record: " + record.message);
    }
    const body = JSON.parse(encodeJournalRecord(record));
    body.payload = payload;
    return body;
}

function certificateOf(id, node, valueId, basis, reason, coordinates, physical) {
    return makeValidateEvent(
        {
            id,
            context: contextOf(coordinates === undefined ? [[WRITER_A, "1"]] : coordinates),
            authorityTime: authorityOf(physical === undefined ? 2000 : physical),
            node,
        },
        valueId,
        basis,
        reason
    );
}

function replicaOf(records) {
    return makeJournalReplica([[WRITER_A, records]]);
}

/**
 * A whole-history-valid history in which `K`'s certificate names either the one
 * node the current schema says is its input, or a node it has since retired.
 * Every reason is accepted as a valid record either way, because the reason
 * rules say nothing about the current schema, so the only thing the reason
 * changes here is whether the certificate is current proof.
 * @param {string} reason
 * @param {boolean} stale - Whether the certificate names a retired input.
 * @returns {Array<object>}
 */
function historyWithCertificate(reason, stale) {
    const value = valueAt(WRITER_A + ":1", [], NODE_K, { type: "events_count", count: 1 }, 1010);
    const input = valueAt(WRITER_A + ":2", [[WRITER_A, "1"]], NODE_D, { type: "events_count", count: 1 }, 1020);
    const inputProof = certificateOf(
        WRITER_A + ":3",
        NODE_D,
        WRITER_A + ":2",
        [],
        "compute",
        [[WRITER_A, "2"]],
        1030
    );
    const retired = valueAt(WRITER_A + ":4", [[WRITER_A, "3"]], NODE_RETIRED_INPUT, { type: "events_count", count: 1 }, 1040);
    return [
        value,
        input,
        inputProof,
        retired,
        certificateOf(
            WRITER_A + ":5",
            NODE_K,
            WRITER_A + ":1",
            [
                makeValidationBasisEntry(
                    stale ? NODE_RETIRED_INPUT : NODE_D,
                    stale ? WRITER_A + ":4" : WRITER_A + ":2"
                ),
            ],
            reason,
            [[WRITER_A, "4"]],
            1050
        ),
    ];
}

function valueIdOf(id) {
    const parsed = parseJournalRecordId(id);
    if (parsed instanceof Error) {
        throw new Error("the fixture could not parse the value id " + id);
    }
    return parsed;
}

/**
 * The current schema: `K` has exactly one direct input `D`, and no other node
 * family appears in it at all. A node the schema does not mention therefore has
 * no entry, which is what a removed node family looks like from here.
 * @param {string} nodeKeyString
 * @returns {Array<string> | undefined}
 */
function currentInputsOfK(nodeKeyString) {
    if (nodeKeyString !== KEY_K) {
        return undefined;
    }
    return [KEY_D];
}

/**
 * The selection context the oracle hands to `isEligibleCertificate`: the node's
 * current occurrence, and no invalidation at all.
 * @param {string} nodeKeyString
 * @returns {{valueIdOf: (nodeKeyString: string) => object, authorOf: (name: string) => object}}
 */
function occurrencesOf(nodeKeyString) {
    return {
        valueIdOf: (asked) => (asked === nodeKeyString ? valueIdOf(WRITER_A + ":1") : undefined),
        authorOf: () => undefined,
    };
}

const NO_SUMMARIES = new Map();

describe("blocker 1: the payload is validated against the union member it names", () => {
    test("every member of the union has exactly one canonical valid payload", () => {
        // The union declares eighteen members. A nineteenth variant added to the
        // union without a shape here has no canonical payload and is caught by
        // this count.
        expect(VALID_MEMBERS).toHaveLength(18);
    });

    test("the discriminant set is exactly the union's members, in both directions", () => {
        // Catches both drift directions the review named: a tag added to the set
        // with no union member behind it, and a real member's tag removed from
        // the set, which would make the layer reject a valid value.
        expect(new Set(VALID_MEMBERS.map((member) => member.tag))).toEqual(
            new Set(COMPUTED_VALUE_TYPE_TAGS)
        );
        expect(COMPUTED_VALUE_TYPE_TAGS.size).toBe(18);
    });

    test.each(VALID_MEMBERS)("$tag: a canonical payload is accepted end to end", ({ payload }) => {
        expect(currentFormatValidateRecord(valueBodyWithPayload(WRITER_A + ":1", payload))).toBeUndefined();
        expect(computedValueViolation(payload)).toBeUndefined();
    });

    test.each([
        ["a member of the wrong declared type", { type: "events_count", count: "not a number" }],
        ["a missing declared member", { type: "events_count" }],
        ["a member no union member declares", { type: "events_count", count: 3, injected: true }],
        ["a nested member of the wrong type", { type: "ontology", ontology: "a string" }],
        ["a union member value of the wrong type", { type: "calories", value: {} }],
        ["a config member of the wrong type", { type: "config", config: 7 }],
        ["an entry description which is not text", { type: "entry_description", description: 42 }],
        ["an array where a member is declared", { type: "all_events", events: "nope" }],
        ["an array element of the wrong shape", { type: "all_events", events: [{ id: "a" }] }],
        ["a live event whose identifier is a bare string", { type: "event_transcription", event: { ...EVENT, id: "aaaaaaaaa:1" }, transcription: TRANSCRIPTION }],
        ["a summary whose processed-entry map is not a map of text", { type: "diary_most_important_info_summary", markdown: "#", summaryDate: "2020-01-01", processedEntries: { a: 1 }, updatedAt: "", model: "m", version: "1" }],
        ["a transcription error result with the wrong member type", { type: "transcription", value: { message: 5 } }],
        ["a meta event with an action no meta event declares", { type: "meta_events", meta_events: [{ action: "injected", event: EVENT }] }],
        ["a context entry whose context is not an array of events", { type: "event_context", contexts: [{ eventId: "a", context: [SERIALIZED_EVENT] }] }],
        ["a last-entries binding which is not a number", { type: "last_entries", n: "10", events: [] }],
    ])("a payload with %s is rejected end to end", (_label, payload) => {
        // Each of these names a current union member and is therefore accepted by a
        // predicate which reads only the discriminant.
        const built = valueAt(WRITER_A + ":1", [], NODE_K, payload);
        expect(isJournalRecordValidationError(built)).toBe(true);
        expect(computedValueViolation(payload)).toBeDefined();
        expect(
            isJournalRecordValidationError(
                currentFormatValidateRecord(valueBodyWithPayload(WRITER_A + ":1", payload))
            )
        ).toBe(true);
    });

    test("a payload which is not an object at all is rejected", () => {
        for (const payload of [7, "events_count", null, ["a"], undefined]) {
            expect(computedValueViolation(payload)).toBeDefined();
        }
    });

    test("a payload naming no current union member is rejected", () => {
        for (const payload of [
            { garbage: true },
            { type: "a_nineteenth_variant_with_no_typedef_member_check" },
            { type: 7 },
        ]) {
            expect(computedValueViolation(payload)).toBeDefined();
        }
    });

    test("the rejection says which member of which union member was wrong", () => {
        expect(computedValueViolation({ type: "events_count", count: "not a number" })).toContain("count");
        expect(computedValueViolation({ type: "events_count" })).toContain("count");
        expect(computedValueViolation({ type: "events_count", count: 3, injected: true })).toContain("injected");
    });

    test("an entry description with no description is a valid member", () => {
        // The computor leaves the description `undefined` for an event which is not
        // a diary entry, and `JSON.stringify` writes no member for that, so the
        // canonical persisted form of the member is an absent one.
        expect(
            currentFormatValidateRecord(
                valueBodyWithPayload(WRITER_A + ":1", { type: "entry_description" })
            )
        ).toBeUndefined();
    });

    test("a null config is a valid member", () => {
        expect(
            currentFormatValidateRecord(
                valueBodyWithPayload(WRITER_A + ":1", { type: "config", config: null })
            )
        ).toBeUndefined();
    });

    test("a calories reading of 'N/A' is a valid member", () => {
        expect(
            currentFormatValidateRecord(
                valueBodyWithPayload(WRITER_A + ":1", { type: "calories", value: "N/A" })
            )
        ).toBeUndefined();
    });
});

describe("blocker 2: the current-shape rule is one rule, not two", () => {
    test("a baseline-reason certificate naming a retired input set is not current-shape-compatible", () => {
        // The specification defines current-shape compatibility as
        // `certificateInputs(C) == currentInputs(K)` with no reason exemption. The
        // baseline-reason exemption belongs to the reason rule, which is about
        // what the record says and is enforced for the whole of history.
        for (const reason of ["bootstrap", "reset", "migration"]) {
            const certificate = certificateOf(
                WRITER_A + ":3",
                NODE_K,
                WRITER_A + ":1",
                [makeValidationBasisEntry(NODE_RETIRED_INPUT, WRITER_A + ":2")],
                reason
            );
            expect(isJournalRecordValidationError(validateCurrentShapeBasis(certificate, currentInputsOfK))).toBe(true);
            expect(
                isEligibleCertificate(
                    certificate,
                    NO_SUMMARIES,
                    occurrencesOf(KEY_K),
                    currentInputsOfK
                )
            ).toBe(false);
        }
    });

    test("an ordinary-reason certificate naming a retired input set is not current-shape-compatible", () => {
        for (const reason of ["compute", "unchanged", "cache-revalidate"]) {
            const certificate = certificateOf(
                WRITER_A + ":3",
                NODE_K,
                WRITER_A + ":1",
                [makeValidationBasisEntry(NODE_RETIRED_INPUT, WRITER_A + ":2")],
                reason
            );
            expect(isJournalRecordValidationError(validateCurrentShapeBasis(certificate, currentInputsOfK))).toBe(true);
            expect(
                isEligibleCertificate(
                    certificate,
                    NO_SUMMARIES,
                    occurrencesOf(KEY_K),
                    currentInputsOfK
                )
            ).toBe(false);
        }
    });

    test("a zero-basis certificate on a removed node family is current-shape-compatible", () => {
        // `currentInputs(K)` is empty for a node the current schema does not
        // contain, so a certificate naming no inputs is current-shape-compatible
        // whatever its reason, and one which still names inputs is not.
        for (const reason of ["compute", "bootstrap", "reset", "migration"]) {
            const zeroBasis = certificateOf(WRITER_A + ":3", NODE_REMOVED_FAMILY, WRITER_A + ":1", [], reason);
            expect(validateCurrentShapeBasis(zeroBasis, currentInputsOfK)).toBeUndefined();
            expect(
                isEligibleCertificate(
                    zeroBasis,
                    NO_SUMMARIES,
                    occurrencesOf(nodeKeyToCanonicalString(NODE_REMOVED_FAMILY)),
                    currentInputsOfK
                )
            ).toBe(true);

            const withInput = certificateOf(
                WRITER_A + ":4",
                NODE_REMOVED_FAMILY,
                WRITER_A + ":1",
                [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")],
                reason
            );
            expect(isJournalRecordValidationError(validateCurrentShapeBasis(withInput, currentInputsOfK))).toBe(true);
            expect(
                isEligibleCertificate(
                    withInput,
                    NO_SUMMARIES,
                    occurrencesOf(nodeKeyToCanonicalString(NODE_REMOVED_FAMILY)),
                    currentInputsOfK
                )
            ).toBe(false);
        }
    });

    test("a certificate naming exactly the current input set is current-shape-compatible", () => {
        for (const reason of ["compute", "unchanged", "cache-revalidate", "bootstrap", "reset", "migration"]) {
            const certificate = certificateOf(
                WRITER_A + ":3",
                NODE_K,
                WRITER_A + ":1",
                [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")],
                reason
            );
            expect(validateCurrentShapeBasis(certificate, currentInputsOfK)).toBeUndefined();
            expect(
                isEligibleCertificate(
                    certificate,
                    NO_SUMMARIES,
                    occurrencesOf(KEY_K),
                    currentInputsOfK
                )
            ).toBe(true);
        }
    });

    test("the two predicates agree on every reason and every input set", () => {
        // The mutation the review named as decisive: swapping one implementation
        // of the current-shape rule for the other changed nothing any journal
        // test could see. So the two verdicts are gathered over the whole cross
        // product the divergence lives on and compared, which makes a divergence
        // name the exact input that produced it.
        const schemas = [
            ["K has one current input", currentInputsOfK],
            ["K has two current inputs", (nodeKeyString) =>
                (nodeKeyString === KEY_K
                    ? [KEY_D, nodeKeyToCanonicalString(NODE_RETIRED_INPUT)]
                    : undefined)],
            ["K has no current inputs", (nodeKeyString) =>
                (nodeKeyString === KEY_K ? [] : undefined)],
        ];
        const bases = [
            ["no inputs", []],
            ["the one current input", [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")]],
            ["a retired input", [makeValidationBasisEntry(NODE_RETIRED_INPUT, WRITER_A + ":2")]],
            [
                "both",
                [
                    makeValidationBasisEntry(NODE_D, WRITER_A + ":2"),
                    makeValidationBasisEntry(NODE_RETIRED_INPUT, WRITER_A + ":3"),
                ],
            ],
        ];
        const reasons = ["compute", "unchanged", "cache-revalidate", "bootstrap", "reset", "migration"];
        const subjects = [
            ["K", NODE_K, KEY_K],
            ["a removed node family", NODE_REMOVED_FAMILY, nodeKeyToCanonicalString(NODE_REMOVED_FAMILY)],
        ];
        /** @type {Array<string>} */
        const disagreements = [];
        for (const [schemaLabel, schema] of schemas) {
            for (const [subjectLabel, subjectNode, subjectKey] of subjects) {
                for (const [basisLabel, basis] of bases) {
                    for (const reason of reasons) {
                        const certificate = certificateOf(
                            WRITER_A + ":3",
                            subjectNode,
                            WRITER_A + ":1",
                            basis,
                            reason
                        );
                        const currentShapeAccepts =
                            validateCurrentShapeBasis(certificate, schema) === undefined;
                        const oracleAccepts = isEligibleCertificate(
                            certificate,
                            NO_SUMMARIES,
                            occurrencesOf(subjectKey),
                            schema
                        );
                        if (currentShapeAccepts !== oracleAccepts) {
                            disagreements.push(
                                `${schemaLabel} / ${subjectLabel} / ${basisLabel} / ${reason}: current-shape ${
                                    currentShapeAccepts ? "accept" : "reject"
                                }, eligible ${oracleAccepts ? "accept" : "reject"}`
                            );
                        }
                    }
                }
            }
        }
        expect(disagreements).toEqual([]);
    });

    test("a certificate which does not name the selected occurrence is ineligible whatever its input set", () => {
        const certificate = certificateOf(
            WRITER_A + ":3",
            NODE_K,
            WRITER_A + ":1",
            [makeValidationBasisEntry(NODE_D, WRITER_A + ":2")],
            "compute"
        );
        expect(
            isEligibleCertificate(
                certificate,
                NO_SUMMARIES,
                { valueIdOf: () => valueIdOf(WRITER_A + ":9"), authorOf: () => undefined },
                currentInputsOfK
            )
        ).toBe(false);
    });

    test("replay does not select a certificate which names a retired input, whatever its reason", () => {
        // The consequence the review described: if the baseline-reason exemption
        // survives anywhere, a `reset` certificate naming a retired input set is
        // admissible proof about a graph it was not computed from, and replay
        // projects a node as fresh on the strength of it. Here the whole
        // projection is asked, for every reason, and `K` stays out of its own
        // proof-ready set.
        for (const reason of ["compute", "unchanged", "cache-revalidate", "bootstrap", "reset", "migration"]) {
            const replica = replicaOf(historyWithCertificate(reason, true));
            expect(validateJournalReplica(replica)).toBeUndefined();
            const projection = projectRetainedJournal({
                source: makeReplicaSource(replica),
                localWriter: makeJournalAuthor(WRITER_A),
                currentInputKeysOfNode: currentInputsOfK,
            });
            expect(isJournalError(projection)).toBe(false);
            if (isJournalError(projection)) {
                throw new Error("the projection reported an error the fixture did not cause");
            }
            expect(projection.selfProofReadyNodes.has(KEY_K)).toBe(false);
            expect(projection.freshness.get(KEY_K)?.fresh).toBe(false);
        }
    });

    test("replay does select a certificate which names the current input, whatever its reason", () => {
        // The rejection above has to be about the shape of the certificate and not
        // about the projection refusing to look at `K` at all, so the same history
        // with the current input named must come out fresh for every reason.
        for (const reason of ["compute", "unchanged", "cache-revalidate", "bootstrap", "reset", "migration"]) {
            const replica = replicaOf(historyWithCertificate(reason, false));
            expect(validateJournalReplica(replica)).toBeUndefined();
            const projection = projectRetainedJournal({
                source: makeReplicaSource(replica),
                localWriter: makeJournalAuthor(WRITER_A),
                currentInputKeysOfNode: currentInputsOfK,
            });
            expect(isJournalError(projection)).toBe(false);
            if (isJournalError(projection)) {
                throw new Error("the projection reported an error the fixture did not cause");
            }
            expect(projection.selfProofReadyNodes.has(KEY_K)).toBe(true);
            expect(projection.freshness.get(KEY_K)?.fresh).toBe(true);
        }
    });
});
