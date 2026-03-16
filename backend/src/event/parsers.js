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
    // [key] is a flag modifier with an empty value; [key value] carries a value.
    // Brackets starting with a digit (e.g. [123]) are not modifiers.
    /** @type {Record<string, string>} */
    const modifiers = {};
    const modifierPattern = /^\s*\[([A-Za-z]\w*)(?:\s+([^\]]*))?]/;
    let modifierMatch = modifierPattern.exec(remainder);
    while (modifierMatch !== null) {
        const modifierContent = modifierMatch[0].trim().slice(1, -1); // strip brackets
        const parsed = parseModifier(modifierContent);
        modifiers[parsed.type] = parsed.description;
        remainder = remainder.slice(modifierMatch[0].length);
        modifierMatch = modifierPattern.exec(remainder);
    }

    // Step 3: Everything remaining is the description
    const description = remainder.trim();

    // Check if description contains patterns that look like modifiers (e.g., [key value])
    // This prevents modifiers from appearing after the description has started
    const modifierLikePattern = /\[[^\]]*\s+[^\]]*\]/;
    if (modifierLikePattern.test(description)) {
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
