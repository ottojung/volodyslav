/**
 * Coordinate arithmetic on a `JournalSequence`.
 *
 * A Journal coordinate is arbitrary-precision decimal text, so a coordinate's
 * predecessor and successor are decimal borrow and decimal carry on its canonical
 * digits. Both are exact at any width and neither is a `number` nor a `BigInt`: a
 * `number` loses precision above 2^53 and `BigInt` is not available at this module's
 * compilation target. Each result is rebuilt through `makeJournalSequence`, so a
 * result which is not canonical decimal is a validation failure rather than a
 * silently wrong coordinate.
 */

/** @typedef {import("./errors").AnyJournalError} JournalError */
/** @typedef {import("./types").JournalSequence} JournalSequence */

const { makeJournalRecordValidationError } = require("./errors");
const { isJournalSequence, journalSequenceToString, makeJournalSequence } = require("./types");

/**
 * The coordinate immediately before `sequence`.
 *
 * The decrement is decimal borrow on canonical digits, so the result is exact at
 * any width: `9 -> 8`, `10 -> 9`, `100 -> 99`, `1000 -> 999`. Zero has no
 * predecessor, so the predecessor of zero is a validation failure rather than a
 * silent wrap onto a negative or reordered representation.
 *
 * @param {JournalSequence} sequence
 * @returns {JournalSequence | JournalError}
 */
function predecessorJournalSequence(sequence) {
    const canonical = journalSequenceToString(sequence);
    if (canonical === "0") {
        return makeJournalRecordValidationError(
            "journal sequence zero has no predecessor",
            "unknown"
        );
    }
    const digits = canonical.split("");
    /** @type {number} */
    let index = digits.length - 1;
    while (index >= 0) {
        const borrowed = Number(digits[index]) - 1;
        if (borrowed >= 0) {
            digits[index] = String(borrowed);
            break;
        }
        digits[index] = "9";
        index--;
    }
    return makeJournalSequence(digits.join("").replace(/^0+(?=[0-9])/, ""));
}

/**
 * The canonical decimal successor of a coordinate: the decimal carry increment of
 * the canonical digits, which is canonical decimal because every zero the carry
 * produces becomes a leading one. Zero has a successor.
 *
 * @param {JournalSequence} sequence
 * @returns {JournalSequence | JournalError}
 */
function successorJournalSequence(sequence) {
    const digits = journalSequenceToString(sequence).split("");
    /** @type {number} */
    let index = digits.length - 1;
    while (index >= 0) {
        const nextDigit = Number(digits[index]) + 1;
        digits[index] = String(nextDigit % 10);
        if (nextDigit < 10) {
            break;
        }
        index--;
    }
    const incremented = index < 0 ? "1" + digits.join("") : digits.join("");
    return makeJournalSequence(incremented);
}

/**
 * The successor of a coordinate, which decimal carry on canonical digits always
 * produces in canonical decimal: the increment of a canonical positive decimal
 * string is one, and the increment of zero is one.
 *
 * This is the form emission's contiguous range allocation uses, where a rejection
 * would mean the carry arithmetic itself is defective rather than that the caller
 * supplied something malformed.
 *
 * @param {JournalSequence} sequence
 * @returns {JournalSequence}
 */
function requireSuccessorJournalSequence(sequence) {
    const successor = successorJournalSequence(sequence);
    if (isJournalSequence(successor)) {
        return successor;
    }
    throw new Error("decimal carry produced a coordinate the canonical pattern rejects");
}

module.exports = {
    predecessorJournalSequence,
    requireSuccessorJournalSequence,
    successorJournalSequence,
};
