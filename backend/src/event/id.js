const random = require("../random");

class EventIdClass {
    /** @type {string} */
    identifier;

    /**
     * This is a value that is never actually assigned.
     * Its purpose is to make `EventId` a nominal type.
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {Capabilities} capabilities
     */
    constructor(capabilities) {
        this.identifier = random.string(capabilities, 16);
    }
}

/** @typedef {EventIdClass} EventId */

/** @typedef {import('../random/seed').NonDeterministicSeed} NonDeterministicSeed */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 */

/**
 * @param {Capabilities} capabilities
 * @returns {EventId}
 * @description Primary constructor for an EventId.
 */
function make(capabilities) {
    return new EventIdClass(capabilities);
}

module.exports = {
    make,
};
