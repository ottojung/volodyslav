/**
 * Order-preserving storage keys for arbitrary-width JournalSequence coordinates.
 *
 * Every canonical coordinate uses the same format: "z" followed by unary
 * decimal-length width, the decimal length, a separator "0", then its digits.
 * The length prefix orders arbitrary-precision values numerically.
 */

/**
 * @param {string} digits - Canonical decimal JournalSequence text.
 * @returns {string}
 */
function encodeRecordCoordinate(digits) {
    const widthText = String(digits.length);
    return "z" + "1".repeat(widthText.length) + "0" + widthText + "0" + digits;
}

/**
 * @param {string} encoded
 * @returns {string | undefined} - Canonical decimal or undefined for malformed keys.
 */
function decodeRecordCoordinate(encoded) {
    const match = /^z(1+)0/.exec(encoded);
    const widthDigits = match?.[1]?.length;
    if (widthDigits === undefined) {
        return undefined;
    }
    const start = widthDigits + 2;
    const lengthText = encoded.slice(start, start + widthDigits);
    if (!/^[1-9][0-9]*$/.test(lengthText) || encoded[start + widthDigits] !== "0") {
        return undefined;
    }
    const digits = encoded.slice(start + widthDigits + 1);
    if (!/^(0|[1-9][0-9]*)$/.test(digits) ||
        String(digits.length) !== lengthText) {
        return undefined;
    }
    return digits;
}

module.exports = { encodeRecordCoordinate, decodeRecordCoordinate };
