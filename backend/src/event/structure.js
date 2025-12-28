const { serialize, deserialize, tryDeserialize } = require('./serialization');
const {
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isNestedFieldError,
} = require('./errors');

/**
 * @typedef Modifiers
 * @type {Record<string, string>}
 */

/** @typedef {import('../creator').Creator} Creator */

/**
 * @typedef Event
 * @type {Object}
 * @property {import('./id').EventId} id - Unique identifier for the event.
 * @property {import('../datetime').DateTime} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Modifiers} modifiers - Modifiers applied to the event.
 * @property {string} type - The type of the event.
 * @property {string} description - A description of the event (required).
 * @property {Creator} creator - Who created the event.
 */

/**
 * @typedef SerializedEvent
 * @type {Object}
 * @property {string} id - Unique identifier for the event.
 * @property {string} date - The date of the event.
 * @property {string} original - The original input of the event.
 * @property {string} input - The processed input of the event.
 * @property {Modifiers} modifiers - Modifiers applied to the event.
 * @property {string} type - The type of the event.
 * @property {string} description - A description of the event (required).
 * @property {Creator} creator - Who created the event.
 */

/**
 * Checks if two events are equal by comparing all their properties.
 * @param {Event} event1 - First event
 * @param {Event} event2 - Second event
 * @returns {boolean} True if events are equal
 */
function equal(event1, event2) {
   return (
        event1.id.identifier === event2.id.identifier &&
        event1.date === event2.date &&
        event1.original === event2.original &&
        event1.input === event2.input &&
        event1.type === event2.type &&
        event1.description === event2.description &&
        JSON.stringify(event1.modifiers) === JSON.stringify(event2.modifiers) &&
        JSON.stringify(event1.creator) === JSON.stringify(event2.creator)
    );
}

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isNestedFieldError,
    equal,
};
