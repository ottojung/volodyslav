const random = require("../random");

class EventIdClass {
    /**
     * @type {string}
     * @private
     */
    _identifier;

    get identifier() {
        return this._identifier;
    }

    /**
     * @param {Capabilities} capabilities
     */
    constructor(capabilities) {
        this._identifier = random.string(capabilities, 16);
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
