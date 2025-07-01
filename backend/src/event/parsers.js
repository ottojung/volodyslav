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

/**
 * Parses structured input in the format: TYPE [MODIFIERS...] DESCRIPTION
 * @param {string} input - The input string to parse
 * @returns {ParsedInput} - The parsed input structure
 */
function parseStructuredInput(input) {
    // Match: TYPE [modifiers...] description
    // TYPE must be a single word (letters and digits only, starting with a letter)
    // modifiers are optional, description is optional
    // Only capture brackets that contain spaces (valid modifiers) immediately after type
    const pattern = /^\s*([A-Za-z][A-Za-z0-9]*)\s*((?:\[[^\]]*\s+[^\]]*\]\s*)*)\s*(.*)$/;
    const match = input.match(pattern);

    if (!match) {
        throw makeInputParseError("Bad structure of input", input);
    }

    const type = match[1];
    const modifiersStr = (match[2] || "").trim();
    const description = (match[3] || "").trim();

    if (!type) {
        throw makeInputParseError("Type is required but not found in input", input);
    }

    // Check if description contains patterns that look like modifiers (e.g., [key value])
    // This prevents modifiers from appearing after the description has started
    const modifierLikePattern = /\[[^\]]*\s+[^\]]*\]/;
    if (modifierLikePattern.test(description)) {
        throw makeInputParseError(
            "Modifiers must appear immediately after the type, before any description text",
            input
        );
    }

    // Parse modifiers - only match those with spaces (valid modifier format)
    const modifierMatches = modifiersStr.match(/\[[^\]]*\s+[^\]]*\]/g) || [];
    /** @type {Record<string, string>} */
    const modifiers = {};

    for (const modifierMatch of modifierMatches) {
        // Remove brackets
        const modifierContent = modifierMatch.slice(1, -1);
        const parsed = parseModifier(modifierContent);
        modifiers[parsed.type] = parsed.description;
    }

    return {
        type: type,
        description,
        modifiers,
    };
}

module.exports = {
    normalizeInput,
    parseModifier,
    parseStructuredInput,
};
