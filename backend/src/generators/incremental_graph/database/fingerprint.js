/**
 * Persisted allocation fingerprints contain only lowercase ASCII letters and
 * are at least nine characters long.
 */
const FINGERPRINT_PATTERN = /^[a-z]{9,}$/;

/**
 * Thrown when persisted replica or snapshot metadata does not contain a valid
 * allocation fingerprint.
 */
class InvalidFingerprintError extends Error {
    /**
     * @param {string} context
     * @param {unknown} value
     */
    constructor(context, value) {
        super(
            `Invalid fingerprint in ${context}: expected a string matching ` +
            `/^[a-z]{9,}$/, got ${JSON.stringify(value)}`
        );
        this.name = 'InvalidFingerprintError';
        this.context = context;
        this.value = value;
    }
}

/**
 * Check whether a persisted value is a valid allocation fingerprint.
 * @param {unknown} value
 * @returns {value is string}
 */
function isValidFingerprint(value) {
    return typeof value === 'string' && FINGERPRINT_PATTERN.test(value);
}

/**
 * Validate and return a persisted allocation fingerprint.
 * @param {unknown} value
 * @param {string} context
 * @returns {string}
 * @throws {InvalidFingerprintError}
 */
function requireValidFingerprint(value, context) {
    if (!isValidFingerprint(value)) {
        throw new InvalidFingerprintError(context, value);
    }
    return value;
}

/**
 * @param {unknown} object
 * @returns {object is InvalidFingerprintError}
 */
function isInvalidFingerprintError(object) {
    return object instanceof InvalidFingerprintError;
}

module.exports = {
    FINGERPRINT_PATTERN,
    isInvalidFingerprintError,
    isValidFingerprint,
    requireValidFingerprint,
};
