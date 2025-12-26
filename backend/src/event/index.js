
const {
    serialize,
    deserialize,
    tryDeserialize,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isNestedFieldError
} = require('./structure');

const { extractHashtags } = require('./hashtags');
const { isContextEnhancing } = require('./known_types');

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
};
