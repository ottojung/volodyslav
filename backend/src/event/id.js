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
     * @param {string} identifier - The unique identifier for the event.
     */
    constructor(identifier) {
        this.identifier = identifier;
        if (this.__brand !== undefined) {
            throw new Error("EventId is a nominal type and should not be instantiated directly");
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
    const identifier = random.string(capabilities, 16);
    return new EventIdClass(identifier);
}

/**
 * @param {string} id
 * @returns {EventId}
 * @description Primary constructor for an EventId.
 */
function fromString(id) {
    return new EventIdClass(id);
}

/**
 * Converts an EventId to its string representation.
 * @param {EventId} eventId
 * @returns {string}
 */
function toString(eventId) {
    return eventId.identifier;
}

module.exports = {
    make,
    fromString,
    toString,
};
