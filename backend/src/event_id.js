const random = require("./random");

/**
 * @class
 */
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
     * @param {import('./random').RNG} rng
     */
    constructor(rng) {
        this.identifier = random.string(16, rng);
    }
}

/** @typedef {EventIdClass} EventId */

/**
 * @param {import('./random').RNG} rng
 * @returns {EventId}
 * @description Primary constructor for an EventId.
 */
function make(rng) {
    return new EventIdClass(rng);
}

module.exports = {
    make,
};
