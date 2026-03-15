/**
 * Functions that compute derived properties of an event from its input field.
 * These replace the stored type, description, and modifiers fields.
 */

const { parseStructuredInput } = require("./parsers");

/**
 * @typedef {import('./serialization').Event} Event
 */

/**
 * Computes the type of an event by parsing its input field.
 * @param {Event} event
 * @returns {string}
 */
function getType(event) {
    return parseStructuredInput(event.input).type;
}

/**
 * Computes the description of an event by parsing its input field.
 * @param {Event} event
 * @returns {string}
 */
function getDescription(event) {
    return parseStructuredInput(event.input).description;
}

/**
 * Computes the modifiers of an event by parsing its input field.
 * @param {Event} event
 * @returns {import('./parsers').ParsedInput['modifiers']}
 */
function getModifiers(event) {
    return parseStructuredInput(event.input).modifiers;
}

module.exports = {
    getType,
    getDescription,
    getModifiers,
};
