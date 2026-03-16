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

// Matches a leading modifier bracket whose key starts with a letter:
//   [key]              - flag modifier (empty value)
//   [key value]        - key-value modifier
//   [key v1 v2 v3]     - key-value modifier with multi-word value
// Key: one letter followed by zero or more word characters.
// Value: any non-bracket text after the key and whitespace (may include multiple words).
// Anchored (^\s*) so it only matches at the start of the string, enabling safe
// iterative consumption without backtracking.
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
    // Step 1: Extract the type (first word starting with a letter)
    const typeMatch = input.match(/^\s*([A-Za-z][A-Za-z0-9]*)/);
    if (!typeMatch) {
        throw makeInputParseError("Bad structure of input", input);
    }
    const type = typeMatch[1];
    let remainder = input.slice(typeMatch[0].length);

    if (!type) {
        throw makeInputParseError("Type is required but not found in input", input);
    }

    // Step 2: Iteratively extract modifier tokens from the front to avoid ReDoS.
    // Modifier keys start with a letter and may contain word chars (letters, digits, underscores).
    // [key] is a flag modifier with an empty value; [key value] carries a value (may be multi-word).
    // Brackets starting with a digit (e.g. [123]) are not modifiers.
    /** @type {Record<string, string>} */
    const modifiers = {};
    let modifierMatch = LEADING_MODIFIER_PATTERN.exec(remainder);
    while (modifierMatch !== null) {
        const modifierContent = modifierMatch[0].trim().slice(1, -1); // strip brackets
        const parsed = parseModifier(modifierContent);
        modifiers[parsed.type] = parsed.description;
        remainder = remainder.slice(modifierMatch[0].length);
        modifierMatch = LEADING_MODIFIER_PATTERN.exec(remainder);
    }

    // Step 3: Everything remaining is the description
    const description = remainder.trim();

    // Step 4: All modifiers must appear before any description text.
    // Reject inputs where the description contains a modifier-like bracket
    // ([key] or [key value]), since modifiers must come before description.
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
