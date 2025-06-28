
const { 
    serialize, 
    deserialize, 
    tryDeserialize,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    NestedFieldError
} = require('./structure');

/** @typedef {import('./structure').Event} Event */
/** @typedef {import('./structure').SerializedEvent} SerializedEvent */
/** @typedef {import('./id').EventId} EventId */
/** @typedef {import('./asset').Asset} Asset */

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    NestedFieldError,
};
