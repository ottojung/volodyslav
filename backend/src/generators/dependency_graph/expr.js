/**
 * Expression parsing and canonicalization for parameterized node schemas.
 */

/**
 * Parsed expression - either a constant or a function call.
 * @typedef {Object} ParsedExpr
 * @property {'const' | 'call'} kind - The kind of expression
 * @property {string} name - The name/head of the expression
 * @property {string[]} args - Arguments (empty for constants)
 */

/**
 * Parses an expression string into a structured form.
 * Supports:
 * - constants: "name"
 * - calls: "name(arg1,arg2,...)"
 *
 * @param {string} str - The expression string to parse
 * @returns {ParsedExpr}
 * @throws {Error} If the expression is malformed
 */
function parseExpr(str) {
    // Remove all whitespace
    const cleaned = str.replace(/\s+/g, "");

    if (cleaned.length === 0) {
        throw new Error("Expression cannot be empty");
    }

    // Check if it's a function call
    const parenIndex = cleaned.indexOf("(");

    if (parenIndex === -1) {
        // No parentheses - it's a constant
        if (!isValidIdentifier(cleaned)) {
            throw new Error(`Invalid identifier: ${cleaned}`);
        }
        return {
            kind: "const",
            name: cleaned,
            args: [],
        };
    }

    // It's a function call
    const name = cleaned.substring(0, parenIndex);
    if (!isValidIdentifier(name)) {
        throw new Error(`Invalid function name: ${name}`);
    }

    if (!cleaned.endsWith(")")) {
        throw new Error(`Missing closing parenthesis in: ${cleaned}`);
    }

    const argsStr = cleaned.substring(parenIndex + 1, cleaned.length - 1);

    // Handle empty args
    if (argsStr.length === 0) {
        return {
            kind: "call",
            name,
            args: [],
        };
    }

    // Split by comma
    const args = argsStr.split(",");

    // Validate each argument
    for (const arg of args) {
        if (!isValidIdentifier(arg)) {
            throw new Error(`Invalid argument: ${arg}`);
        }
    }

    return {
        kind: "call",
        name,
        args,
    };
}

/**
 * Checks if a string is a valid identifier.
 * Valid identifiers contain only alphanumeric characters and underscores,
 * and do not start with a digit.
 *
 * @param {string} str
 * @returns {boolean}
 */
function isValidIdentifier(str) {
    if (str.length === 0) {
        return false;
    }
    // Must start with letter or underscore
    if (!/^[a-zA-Z_]/.test(str)) {
        return false;
    }
    // Rest can be alphanumeric or underscore
    return /^[a-zA-Z_][a-zA-Z0-9_]*$/.test(str);
}

/**
 * Canonicalizes an expression string.
 * Removes all whitespace and returns a standardized form.
 *
 * @param {string} str - The expression string to canonicalize
 * @returns {string} The canonical form
 * @throws {Error} If the expression is malformed
 */
function canonicalize(str) {
    const parsed = parseExpr(str);
    if (parsed.kind === "const") {
        return parsed.name;
    } else {
        return `${parsed.name}(${parsed.args.join(",")})`;
    }
}

module.exports = {
    parseExpr,
    canonicalize,
};
