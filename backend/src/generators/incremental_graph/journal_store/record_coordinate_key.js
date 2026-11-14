/**
 * Order-preserving storage keys for arbitrary-width JournalSequence coordinates.
 *
 * At most 30 digits retain their old, zero-padded key. Longer coordinates use
 * the marker "z" (after ASCII digits), then a unary decimal-length width, the
 * decimal length, and finally canonical digits. All delimiters are "0".
 * This orders by coordinate length then numeric digits without a fixed ceiling.
 */
const PADDED_WIDTH = 30;

/**
 * @param {string} digits - Canonical decimal JournalSequence text.
 * @returns {string}
 */
function encodeRecordCoordinate(digits) {
    if (digits.length <= PADDED_WIDTH) {
        return digits.padStart(PADDED_WIDTH, "0");
    }
    const widthText = String(digits.length);
    return "z" + "1".repeat(widthText.length) + "0" + widthText + "0" + digits;
}

/**
 * @param {string} encoded
 * @returns {string | undefined} - Canonical decimal or undefined for malformed keys.
 */
function decodeRecordCoordinate(encoded) {
    if (/^[0-9]{30}$/.test(encoded)) {
        return encoded.replace(/^0+(?=[0-9])/, "");
    }
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
    if (!/^[1-9][0-9]*$/.test(digits) || digits.length <= PADDED_WIDTH ||
        String(digits.length) !== lengthText) {
        return undefined;
    }
    return digits;
}

module.exports = { encodeRecordCoordinate, decodeRecordCoordinate };
