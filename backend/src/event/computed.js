/**
 * Functions that compute derived properties of an event from its input field.
 * These replace the stored type, description, and modifiers fields.
 */

const { parseStructuredInput } = require("./parsers");

/**
 * @typedef {import('./serialization').Event} Event
 */

/**
 * Computes the type, description, and modifiers of an event by parsing its input field.
 * Prefer this over calling getType/getDescription/getModifiers individually when multiple
 * derived fields are needed, to avoid parsing the same string multiple times.
 * @param {Event} event
 * @returns {import('./parsers').ParsedInput}
 */
function getParsed(event) {
    return parseStructuredInput(event.input);
}

/**
 * Computes the type of an event by parsing its input field.
 * @param {Event} event
 * @returns {string}
 */
function getType(event) {
    return getParsed(event).type;
}

/**
 * Computes the description of an event by parsing its input field.
 * @param {Event} event
 * @returns {string}
 */
function getDescription(event) {
    return getParsed(event).description;
}

/**
 * Computes the modifiers of an event by parsing its input field.
 * @param {Event} event
 * @returns {import('./parsers').ParsedInput['modifiers']}
 */
function getModifiers(event) {
    return getParsed(event).modifiers;
}

module.exports = {
    getParsed,
    getType,
    getDescription,
    getModifiers,
};
