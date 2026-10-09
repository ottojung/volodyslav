
const {
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
} = require('./structure');

const { extractHashtags } = require('./hashtags');
const { isContextEnhancing } = require('./known_types');
const eventId = require('./id');
const asset = require('./asset');
const fromInput = require('./from_input');
const eventDate = require('./date');
const { getType, getDescription, getModifiers, getParsed } = require('./computed');

/** @typedef {import('./structure').Event} Event */
/** @typedef {import('./structure').SerializedEvent} SerializedEvent */
/** @typedef {import('./id').EventId} EventId */
/** @typedef {import('./asset').Asset} Asset */

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
    extractHashtags,
    isContextEnhancing,
    equal,
    getType,
    getDescription,
    getModifiers,
    getParsed,
    id: eventId,
    asset,
    fromInput,
    date: eventDate,
};
