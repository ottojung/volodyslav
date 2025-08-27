// @ts-check
/**
 * @typedef {string & {__brand:'RunId'}} RunId
 */

/**
 * Run identifier for logging correlation (nominal type).
 */
class RunIdClass {
    /** @type {string} */
    value;

    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * Creates a new RunId instance.
     * @param {string} value - Run identifier string
     */
    constructor(value) {
        if (this.__brand !== undefined) {
            throw new Error("RunId is a nominal type");
        }

        if (typeof value !== 'string' || value.length === 0) {
            throw new Error("RunId must be a non-empty string");
        }

        this.value = value;
    }

    /**
     * Get the string value.
     * @returns {string}
     */
    toString() {
        return this.value;
    }
}

/**
 * Generate a new random RunId.
 * @returns {RunId}
 */
function newRunId() {
    // Generate a random 8-character hex string
    const randomValue = Math.random().toString(16).substring(2, 10);
    return /** @type {RunId} */ (new RunIdClass(randomValue));
}

/**
 * Type guard for RunId.
 * @param {any} object
 * @returns {object is RunId}
 */
function isRunId(object) {
    return object instanceof RunIdClass;
}

module.exports = {
    newRunId,
    isRunId,
};