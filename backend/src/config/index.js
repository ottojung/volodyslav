const { 
    serialize, 
    deserialize, 
    tryDeserialize,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    InvalidArrayElementError
} = require("./structure");

/** @typedef {import('./structure').Config} Config */
/** @typedef {import('./structure').SerializedConfig} SerializedConfig */
/** @typedef {import('./structure').Shortcut} Shortcut */

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    TryDeserializeError,
    MissingFieldError,
    InvalidTypeError,
    InvalidValueError,
    InvalidStructureError,
    InvalidArrayElementError,
};
