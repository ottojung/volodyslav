/**
 * Parsing helpers for user input.
 */

const { makeInputParseError } = require("./input_errors");

/**
 * @typedef {object} ParsedInput
 * @property {string} type - The type of the event
 * @property {string} description - The description of the event
 * @property {Record<string, string>} modifiers - The modifiers for the event
 */

/**
 * Normalizes input by collapsing whitespace.
 * @param {string} input - The input string to normalize
 * @returns {string} - The normalized input
 */
function normalizeInput(input) {
    return input.split(/\s+/).join(" ").trim();
}

/**
 * Parses a modifier string like "certainty 9" into {type: "certainty", description: "9"}
 * @param {string} modifier - The modifier string to parse
 * @returns {{type: string, description: string}} - The parsed modifier
 */
function parseModifier(modifier) {
    const pattern = /^\s*(\w+)(\s+(.+))?\s*$/;
    const match = modifier.match(pattern);

    if (!match) {
        throw makeInputParseError(
            `Not a valid modifier: ${JSON.stringify(modifier)}`,
            modifier
        );
    }

    const type = match[1];
    const description = (match[3] || "").trim();

    if (!type) {
        throw makeInputParseError(
            `Type is required but not found in modifier: ${JSON.stringify(modifier)}`,
            modifier
        );
    }

    // Reject modifiers that contain square brackets (invalid format)
    if (description.includes("[") || description.includes("]")) {
        throw makeInputParseError(
            `Not a valid modifier: ${JSON.stringify(modifier)}`,
            modifier
        );
    }

    return { type, description };
}

// Matches a single modifier bracket whose key starts with a letter:
//   [key]        - flag modifier (empty value)
//   [key value]  - key-value modifier
// Key: one letter followed by zero or more word characters.
// Value: any non-bracket text after the key and whitespace.
// The pattern is intentionally anchored (^\s*) so it only matches at the start
// of a string, enabling safe iterative consumption without backtracking.
const LEADING_MODIFIER_PATTERN = /^\s*\[([A-Za-z]\w*)(?:\s+([^\]]*))?\]/;

// Same shape as LEADING_MODIFIER_PATTERN but unanchored, used to detect
// modifier-like brackets anywhere inside a description string.
const MODIFIER_IN_DESCRIPTION_PATTERN = /\[[A-Za-z]\w*(?:\s+[^\]]+)?\]/;

/**
 * Parses structured input in the format: TYPE [MODIFIERS...] DESCRIPTION
 * Uses an iterative approach to avoid ReDoS vulnerabilities.
 * @param {string} input - The input string to parse
 * @returns {ParsedInput} - The parsed input structure
 */
function parseStructuredInput(input) {
    // Step 1: Extract the type (first word starting with a letter).
    const typeMatch = input.match(/^\s*([A-Za-z][A-Za-z0-9]*)/);
    if (!typeMatch) {
        throw makeInputParseError("Bad structure of input", input);
    }
    const type = typeMatch[1];
    let remainder = input.slice(typeMatch[0].length);

    // Step 2: Iteratively consume leading modifier brackets from the remainder.
    // Modifier keys start with a letter; [key] is a flag modifier (empty value),
    // [key value] is a key-value modifier.
    /** @type {Record<string, string>} */
    const modifiers = {};
    let modifierMatch = LEADING_MODIFIER_PATTERN.exec(remainder);
    while (modifierMatch !== null) {
        const modifierContent = modifierMatch[0].trim().slice(1, -1);
        const parsed = parseModifier(modifierContent);
        modifiers[parsed.type] = parsed.description;
        remainder = remainder.slice(modifierMatch[0].length);
        modifierMatch = LEADING_MODIFIER_PATTERN.exec(remainder);
    }

    // Step 3: Everything remaining is the description.
    const description = remainder.trim();

    // Step 4: All modifiers must appear before any description text.
    // Reject inputs where the description contains a modifier-like bracket.
    if (MODIFIER_IN_DESCRIPTION_PATTERN.test(description)) {
        throw makeInputParseError(
            "Modifiers must appear immediately after the type, before any description text",
            input
        );
    }

    return {
        type,
        description,
        modifiers,
    };
}

module.exports = {
    normalizeInput,
    parseModifier,
    parseStructuredInput,
};
