/**
 * Expression parsing and canonicalization for dependency graph node names.
 *
 * Grammar:
 *   expression := constant | call
 *   constant   := \w+
 *   call       := constant "(" args ")"
 *   args       := constant | constant "," args
 *
 * Canonical form:
 *   - constants: "name"
 *   - calls: "name(arg1,arg2)" (no spaces)
 */

/**
 * @typedef {Object} ConstantExpression
 * @property {"constant"} kind
 * @property {string} name
 */

/**
 * @typedef {Object} CallExpression
 * @property {"call"} kind
 * @property {string} name
 * @property {string[]} args
 */

/**
 * @typedef {ConstantExpression | CallExpression} Expression
 */

/**
 * Parse a node name expression.
 *
 * @param {string} str - The expression string to parse
 * @returns {Expression} Parsed expression
 * @throws {Error} If the expression is invalid
 */
function parseExpr(str) {
    const trimmed = str.trim();

    if (!trimmed) {
        throw new Error("Expression cannot be empty");
    }

    // Check if it's a call expression (contains parentheses)
    const parenIndex = trimmed.indexOf("(");

    if (parenIndex === -1) {
        // Constant expression
        if (!/^\w+$/.test(trimmed)) {
            throw new Error(
                `Invalid constant expression: "${str}". Must match \\w+`
            );
        }
        return {
            kind: "constant",
            name: trimmed,
        };
    }

    // Call expression
    const name = trimmed.slice(0, parenIndex).trim();
    if (!/^\w+$/.test(name)) {
        throw new Error(
            `Invalid function name in call expression: "${name}". Must match \\w+`
        );
    }

    if (!trimmed.endsWith(")")) {
        throw new Error(
            `Invalid call expression: "${str}". Missing closing parenthesis`
        );
    }

    const argsStr = trimmed.slice(parenIndex + 1, -1).trim();

    // Empty args - f()
    if (argsStr === "") {
        throw new Error(
            `Invalid call expression: "${str}". Empty argument list not allowed`
        );
    }

    // Split by comma and trim each arg
    const args = argsStr.split(",").map((arg) => arg.trim());

    // Validate each arg is a valid identifier
    for (const arg of args) {
        if (!/^\w+$/.test(arg)) {
            throw new Error(
                `Invalid argument in call expression: "${arg}". Must match \\w+`
            );
        }
    }

    return {
        kind: "call",
        name,
        args,
    };
}

/**
 * Convert an expression to canonical form.
 *
 * @param {string} str - The expression string
 * @returns {string} Canonical form (no spaces)
 */
function canonicalize(str) {
    const expr = parseExpr(str);

    if (expr.kind === "constant") {
        return expr.name;
    }

    // Call: name(arg1,arg2)
    return `${expr.name}(${expr.args.join(",")})`;
}

/**
 * Check if an expression is a constant (no parameters).
 *
 * @param {Expression} expr
 * @returns {expr is ConstantExpression}
 */
function isConstantExpr(expr) {
    return expr.kind === "constant";
}

/**
 * Check if an expression is a call (has parameters).
 *
 * @param {Expression} expr
 * @returns {expr is CallExpression}
 */
function isCallExpr(expr) {
    return expr.kind === "call";
}

module.exports = {
    parseExpr,
    canonicalize,
    isConstantExpr,
    isCallExpr,
};
