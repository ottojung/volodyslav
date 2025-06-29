/**
 * Event Input Processing Module
 * 
 * This module provides functionality to transform raw user input into structured Event objects.
 * It implements a pipeline approach with separate functions for each transformation step.
 * 
 * CAPABILITY REQUIREMENTS:
 * - normalizeInput(): No capabilities needed (pure function)
 * - parseModifier(): No capabilities needed (pure function)  
 * - parseStructuredInput(): No capabilities needed (pure function)
 * - applyShortcuts(): Requires ShortcutCapabilities (for config file access)
 * - processUserInput(): Requires ShortcutCapabilities (calls applyShortcuts)
 * 
 * USAGE EXAMPLES:
 * 
 * Basic parsing (no shortcuts):
 *   const input = "work [loc office] Fixed the parser bug";
 *   const normalized = normalizeInput(input);
 *   const parsed = parseStructuredInput(normalized);
 *   // Result: { type: "work", description: "Fixed the parser bug", modifiers: { loc: "office" } }
 * 
 * Full pipeline with shortcuts (requires capabilities object):
 *   const result = processUserInput(capabilities, "w [loc office] Fixed bug");
 *   // If shortcuts config has "w": "work", this will expand to the same as above
 * 
 * Supported input format: TYPE [MODIFIERS...] DESCRIPTION
 * - TYPE is required and must be a single word (letters and digits only, starting with a letter)
 * - MODIFIERS are optional, format: [key value] (multiple allowed)  
 * - DESCRIPTION is optional, can contain any text (including dashes, brackets, special chars)
 * - Multi-word descriptions don't require punctuation when used without modifiers
 * 
 * Examples of valid inputs:
 * - "work" (minimal)
 * - "meal Had breakfast" (with description - no punctuation required)
 * - "exercise [loc gym] Weightlifting session" (with modifier and description)
 * - "social [with John] [loc cafe] Coffee meeting" (multiple modifiers)
 * - "task Important project details" (multi-word description without modifiers)
 */

/**
 * Minimal capabilities needed for shortcut application and config reading
 * @typedef {object} ShortcutCapabilities
 * @property {import('../environment').Environment} environment - Environment to get repository path
 * @property {import('../filesystem/checker').FileChecker} checker - File checker for instantiating config files
 * @property {import('../filesystem/reader').FileReader} reader - File reader for reading config files
 * @property {import('../filesystem/writer').FileWriter} writer - File writer (required by event log storage)
 * @property {import('../filesystem/creator').FileCreator} creator - File creator (required by event log storage)
 * @property {import('../filesystem/deleter').FileDeleter} deleter - File deleter (required by event log storage)
 * @property {import('../filesystem/copier').FileCopier} copier - File copier (required by event log storage)
 * @property {import('../filesystem/appender').FileAppender} appender - File appender (required by event log storage)
 * @property {import('../subprocess/command').Command} git - Git command (required by event log storage)
 * @property {import('../random/seed').NonDeterministicSeed} seed - Random seed (required by config API)
 * @property {import('../datetime').Datetime} datetime - Datetime utilities (required by config API)
 * @property {import('../logger').Logger} logger - Logger for error reporting
 */

/**
 * @typedef {object} ParsedInput
 * @property {string} type - The type of the event
 * @property {string} description - The description of the event
 * @property {Record<string, string>} modifiers - The modifiers for the event
 */

/**
 * Error thrown when input cannot be parsed according to the expected structure.
 */
class InputParseErrorClass extends Error {
    /** @type {string} */
    input;

    /**
     * @param {string} message
     * @param {string} input
     */
    constructor(message, input) {
        super(message);
        this.name = "InputParseError";
        this.input = input;
    }
}

/**
 * Error thrown when shortcut application fails.
 */
class ShortcutApplicationErrorClass extends Error {
    /** @type {string} */
    input;
    /** @type {string} */
    pattern;

    /**
     * @param {string} message
     * @param {string} input
     * @param {string} pattern
     */
    constructor(message, input, pattern) {
        super(message);
        this.name = "ShortcutApplicationError";
        this.input = input;
        this.pattern = pattern;
    }
}

/**
 * Factory for InputParseError.
 * @param {string} message
 * @param {string} input
 * @returns {Error}
 */
function makeInputParseError(message, input) {
    return new InputParseErrorClass(message, input);
}

/**
 * Type guard for InputParseError.
 * @param {unknown} object
 * @returns {object is Error}
 */
function isInputParseError(object) {
    return object instanceof InputParseErrorClass;
}

/**
 * Factory for ShortcutApplicationError.
 * @param {string} message
 * @param {string} input
 * @param {string} pattern
 * @returns {Error}
 */
function makeShortcutApplicationError(message, input, pattern) {
    return new ShortcutApplicationErrorClass(message, input, pattern);
}

/**
 * Type guard for ShortcutApplicationError.
 * @param {unknown} object
 * @returns {object is Error}
 */
function isShortcutApplicationError(object) {
    return object instanceof ShortcutApplicationErrorClass;
}

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
    if (description.includes('[') || description.includes(']')) {
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
        modifiers
    };
}

/**
 * Applies shortcuts recursively to transform the input.
 * @param {ShortcutCapabilities} capabilities - The capabilities object
 * @param {string} input - The input string to transform
 * @returns {Promise<string>} - The transformed input
 */
async function applyShortcuts(capabilities, input) {
    const { getConfig } = require("../config_api");

    const configObj = await getConfig(capabilities);
    
    if (!configObj || !configObj.shortcuts) {
        return input;
    }

    /**
     * Recursive replacement function matching Python script logic
     * @param {string} currentInput
     * @returns {string}
     */
    function replaceLoop(currentInput) {
        if (!configObj) {
            return currentInput;
        }

        for (const shortcut of configObj.shortcuts) {
            try {
                const regex = new RegExp(shortcut.pattern, 'g');
                const newInput = currentInput.replace(regex, shortcut.replacement);

                if (newInput !== currentInput) {
                    // Changed, so recursively apply again
                    return replaceLoop(newInput);
                }
            } catch (error) {
                throw makeShortcutApplicationError(
                    `Invalid regex pattern in shortcut: ${error instanceof Error ? error.message : String(error)}`,
                    currentInput,
                    shortcut.pattern
                );
            }
        }

        return currentInput;
    }

    // TODO: Add infinite loop detection
    return replaceLoop(input);
}

/**
 * Processes user input through the complete pipeline: normalize → shortcuts → parse
 * @param {ShortcutCapabilities} capabilities - The capabilities object
 * @param {string} rawInput - The raw user input
 * @returns {Promise<{original: string, input: string, parsed: ParsedInput}>} - The processing result
 */
async function processUserInput(capabilities, rawInput) {
    const original = rawInput; // Keep the original raw input
    const normalized = normalizeInput(rawInput);
    const input = await applyShortcuts(capabilities, normalized);
    const parsed = parseStructuredInput(input);

    return {
        original,
        input,
        parsed
    };
}

module.exports = {
    makeInputParseError,
    isInputParseError,
    makeShortcutApplicationError,
    isShortcutApplicationError,
    normalizeInput,
    parseModifier,
    parseStructuredInput,
    applyShortcuts,
    processUserInput
};
