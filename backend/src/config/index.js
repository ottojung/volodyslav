const {
    serialize,
    deserialize,
    tryDeserialize,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError
} = require("./structure");

/** @typedef {import('./structure').Config} Config */
/** @typedef {import('./structure').SerializedConfig} SerializedConfig */
/** @typedef {import('./structure').Shortcut} Shortcut */

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
    makeInvalidStructureError,
    isTryDeserializeError,
    isMissingFieldError,
    isInvalidTypeError,
    isInvalidValueError,
    isInvalidStructureError,
    isInvalidArrayElementError,
};
