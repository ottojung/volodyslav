/**
 * A persisted timestamp is a physical instant, not merely a shaped string.
 *
 * `incremental-graph-journal-types.md` requires malformed or
 * non-exactly-representable timestamps to be rejected, and
 * `incremental-graph-journal-well-formedness.md` makes the record layer the
 * owner of that rule. These tests pin the external behaviour: the constructor
 * and the current-format codec boundary both reject a string whose shape is
 * canonical but which denotes no instant, and both still accept a real instant.
 */

const {
    currentFormatValidateRecord,
    encodeJournalRecord,
    isJournalRecordValidationError,
    makeAuthorityTime,
    makeJournalFrontierFromText,
    makeValueEvent,
} = require("../src/generators/incremental_graph/journal");

const NODE_K = { head: "event", args: [{ id: 1 }] };
const NODE_IDENTIFIER = "1-abcdefghi";
const GOOD = "2020-01-01T00:00:00.000Z";

/**
 * @param {unknown} createdAt
 * @param {unknown} modifiedAt
 * @returns {object}
 */
function build(createdAt, modifiedAt) {
    return makeValueEvent(
        {
            id: "aaaaaaaaa:1",
            context: makeJournalFrontierFromText([]),
            authorityTime: makeAuthorityTime(1000, "0"),
            node: NODE_K,
        },
        NODE_IDENTIFIER,
        { type: "entry_description", description: "x" },
        createdAt,
        modifiedAt,
        "compute"
    );
}

const MALFORMED = [
    "2020-13-45T99:99:99.999Z",
    "0000-00-00T00:00:00.000Z",
    "9999-99-99T99:99:99.999Z",
    "2020-02-30T00:00:00.000Z",
    "2020-01-01T24:00:00.000Z",
    "2016-12-31T23:59:60.000Z",
];

describe("a persisted timestamp must denote a real instant", () => {
    test.each(MALFORMED)("the constructor rejects createdAt %s", (value) => {
        expect(isJournalRecordValidationError(build(value, GOOD))).toBe(true);
    });

    test.each(MALFORMED)("the constructor rejects modifiedAt %s", (value) => {
        expect(isJournalRecordValidationError(build(GOOD, value))).toBe(true);
    });

    test.each(MALFORMED)(
        "the current-format boundary rejects a persisted body carrying %s",
        (value) => {
            const good = build(GOOD, GOOD);
            if (good instanceof Error) {
                throw new Error("the fixture rejected a canonical timestamp");
            }
            const body = JSON.parse(encodeJournalRecord(good));
            body.createdAt = value;
            expect(isJournalRecordValidationError(currentFormatValidateRecord(body))).toBe(true);
        }
    );

    test("a canonical instant is accepted and survives the codec", () => {
        const record = build(GOOD, GOOD);
        if (record instanceof Error) {
            throw new Error("the record layer rejected a canonical timestamp");
        }
        expect(currentFormatValidateRecord(JSON.parse(encodeJournalRecord(record)))).toBeUndefined();
    });

    test("a skewed but real instant is still accepted", () => {
        const record = build("2019-12-31T23:59:59.999Z", "2030-06-15T12:00:00.000Z");
        expect(isJournalRecordValidationError(record)).toBe(false);
    });
});
