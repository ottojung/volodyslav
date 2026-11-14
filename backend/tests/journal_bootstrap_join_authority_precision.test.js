"use strict";

/**
 * `incremental-graph-journal-types.md` declares `AuthorityLogicalTime` a
 * non-negative arbitrary-precision integer, and
 * `incremental-graph-journal-well-formedness.md` §Authority consistency
 * requires every happened-before predecessor to compare strictly less.
 * The joining bootstrap cursor must therefore order and succeed large logical
 * values exactly, including values above 2^53 where a `Number` conversion
 * loses precision.
 */

const {
    compareAuthorityAscending,
    JoiningCursorClass,
} = require("../src/generators/incremental_graph/journal/bootstrap/joining_support");
const {
    journalSequenceToString,
    makeAuthorityTime,
    makeJournalAuthor,
    makeJournalSequence,
} = require("../src/generators/incremental_graph/journal/types");

describe("joining bootstrap authority precision", () => {
    test("orders logical values above 2^53 exactly", () => {
        const below = makeAuthorityTime(100, "9007199254740992");
        const above = makeAuthorityTime(100, "9007199254740993");
        if (below instanceof Error || above instanceof Error) {
            throw new Error("test fixture authority construction failed");
        }
        expect(compareAuthorityAscending(above, below)).toBeGreaterThan(0);
        expect(compareAuthorityAscending(below, above)).toBeLessThan(0);
        expect(compareAuthorityAscending(above, above)).toBe(0);
    });

    test("allocates the exact decimal successor above 2^53", () => {
        const joiningWriter = makeJournalAuthor("bbbbbbbbb");
        const creatorWriter = makeJournalAuthor("aaaaaaaaa");
        const creatorFrontierSequence = makeJournalSequence("1");
        const highWater = makeAuthorityTime(100, "9007199254740993");
        if (
            joiningWriter instanceof Error ||
            creatorWriter instanceof Error ||
            creatorFrontierSequence instanceof Error ||
            highWater instanceof Error
        ) {
            throw new Error("test fixture construction failed");
        }
        const cursor = new JoiningCursorClass(
            joiningWriter,
            creatorWriter,
            creatorFrontierSequence,
            highWater
        );
        const allocated = cursor.allocate(false, undefined);
        if ("error" in allocated) {
            throw allocated.error;
        }
        expect(journalSequenceToString(allocated.fields.authorityTime.logical)).toBe(
            "9007199254740994"
        );
    });
});
