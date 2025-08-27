// @ts-check
/**
 * @typedef {InstantClass} InstantMs
 */

/**
 * Instant in time as epoch milliseconds (nominal type).
 */
class InstantClass {
    /** @type {number} */
    epochMs;

    /**
     * Creates a new Instant instance.
     * @param {number} epochMs - Milliseconds since epoch
     */
    constructor(epochMs) {
        if (!Number.isFinite(epochMs)) {
            throw new Error("Instant must be a finite number");
        }

        this.epochMs = epochMs;
    }

    /**
     * Get the epoch milliseconds value.
     * @returns {number}
     */
    toEpochMs() {
        return this.epochMs;
    }
}

/**
 * Create an Instant from epoch milliseconds.
 * @param {number} epochMs - Milliseconds since epoch
 * @returns {InstantMs}
 */
function fromEpochMs(epochMs) {
    return new InstantClass(epochMs);
}

/**
 * Compare two instants (less than or equal).
 * @param {InstantMs} a
 * @param {InstantMs} b
 * @returns {boolean}
 */
function lte(a, b) {
    return a.epochMs <= b.epochMs;
}

/**
 * Compare two instants (greater than or equal).
 * @param {InstantMs} a
 * @param {InstantMs} b
 * @returns {boolean}
 */
function gte(a, b) {
    return a.epochMs >= b.epochMs;
}

/**
 * Get the minimum of two instants.
 * @param {InstantMs} a
 * @param {InstantMs} b
 * @returns {InstantMs}
 */
function min(a, b) {
    return a.epochMs <= b.epochMs ? a : b;
}

/**
 * Type guard for Instant.
 * @param {any} object
 * @returns {object is InstantMs}
 */
function isInstant(object) {
    return object instanceof InstantClass;
}

module.exports = {
    fromEpochMs,
    lte,
    gte,
    min,
    isInstant,
};