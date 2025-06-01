const { serialize, deserialize, tryDeserialize } = require("./structure");

/** @typedef {import('./structure').Config} Config */
/** @typedef {import('./structure').SerializedConfig} SerializedConfig */
/** @typedef {import('./structure').Shortcut} Shortcut */

module.exports = {
    serialize,
    deserialize,
    tryDeserialize,
};
