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
};
