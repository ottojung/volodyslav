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
        if (this.__brand !== undefined) {
            throw new Error();
        }
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

/**
 * Creates an EventId from an existing string identifier.
 * Used for deserialization from JSON.
 * @param {string} identifier - The string identifier to create EventId from.
 * @returns {EventId}
 * @description Creates an EventId from an existing identifier.
 */
function fromString(identifier) {
    const eventId = Object.create(EventIdClass.prototype);
    eventId.identifier = identifier;
    return eventId;
}

module.exports = {
    make,
    fromString,
};
