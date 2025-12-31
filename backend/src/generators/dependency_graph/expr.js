/**
 * Expression parsing and canonicalization for unified node representation.
 * Supports: identifiers (variables), quoted strings (constants), natural numbers (constants).
 */

/**
 * A typed constant value.
 * @typedef {Object} ConstValue
 * @property {'string' | 'nat'} kind - The kind of constant
 * @property {string | number} value - The constant value
 */

/**
 * A term in an expression - either a variable (identifier) or a constant (string/nat).
 * @typedef {Object} Term
 * @property {'var' | 'const'} kind - Whether this is a variable or constant
 * @property {string} name - For variables, the variable name
 * @property {ConstValue} [value] - For constants, the typed value
 */

/**
 * Parsed expression - either a head-only constant or a function call.
 * @typedef {Object} ParsedExpr
 * @property {'const' | 'call'} kind - The kind of expression
 * @property {string} name - The name/head of the expression
 * @property {Term[]} args - Arguments (empty for head-only constants)
 */

/**
 * Tokenizes the input string.
 * @param {string} str
 * @returns {Array<{type: string, value: string, pos: number}>}
 */
function tokenize(str) {
    const tokens = [];
    let i = 0;

    while (i < str.length) {
        // Skip whitespace
        if (/\s/.test(str[i])) {
            i++;
            continue;
        }

        // String literal
        if (str[i] === '"') {
            const start = i;
            i++; // skip opening quote
            let value = "";
            let escaped = false;

            while (i < str.length) {
                if (escaped) {
                    // Handle escape sequences
                    if (str[i] === '"' || str[i] === "\\") {
                        value += str[i];
                    } else {
                        throw new Error(
                            `Invalid escape sequence \\${str[i]} at position ${i}`
                        );
                    }
                    escaped = false;
                    i++;
                } else if (str[i] === "\\") {
                    escaped = true;
                    i++;
                } else if (str[i] === '"') {
                    i++; // skip closing quote
                    tokens.push({ type: "STRING", value, pos: start });
                    break;
                } else {
                    value += str[i];
                    i++;
                }
            }

            if (i >= str.length && str[i - 1] !== '"') {
                throw new Error(`Unclosed string literal starting at position ${start}`);
            }
            continue;
        }

        // Natural number
        if (/\d/.test(str[i])) {
            const start = i;
            let value = "";

            // Collect digits
            while (i < str.length && /\d/.test(str[i])) {
                value += str[i];
                i++;
            }

            // Validate natural number format
            if (value.length > 1 && value[0] === "0") {
                throw new Error(
                    `Invalid number format: leading zeros not allowed (except '0') at position ${start}`
                );
            }

            // Check for invalid numeric suffixes (decimal, exponent, etc.)
            if (i < str.length && /[.eE]/.test(str[i])) {
                throw new Error(
                    `Invalid number format: only natural numbers allowed (found '${value}${str[i]}' at position ${start})`
                );
            }

            tokens.push({ type: "NAT", value, pos: start });
            continue;
        }

        // Identifier
        if (/[a-zA-Z_]/.test(str[i])) {
            const start = i;
            let value = "";

            while (i < str.length && /[a-zA-Z0-9_]/.test(str[i])) {
                value += str[i];
                i++;
            }

            tokens.push({ type: "IDENT", value, pos: start });
            continue;
        }

        // Single-character tokens
        if (str[i] === "(") {
            tokens.push({ type: "LPAREN", value: "(", pos: i });
            i++;
            continue;
        }

        if (str[i] === ")") {
            tokens.push({ type: "RPAREN", value: ")", pos: i });
            i++;
            continue;
        }

        if (str[i] === ",") {
            tokens.push({ type: "COMMA", value: ",", pos: i });
            i++;
            continue;
        }

        // Check for invalid characters that look like they might be numbers
        if (str[i] === "+" || str[i] === "-") {
            throw new Error(
                `Invalid character '${str[i]}' at position ${i}: signed numbers not allowed`
            );
        }

        throw new Error(`Unexpected character '${str[i]}' at position ${i}`);
    }

    return tokens;
}

/**
 * Parses a term from tokens.
 * @param {Array<{type: string, value: string, pos: number}>} tokens
 * @param {number} index
 * @returns {{term: Term, nextIndex: number}}
 */
function parseTerm(tokens, index) {
    if (index >= tokens.length) {
        throw new Error("Unexpected end of expression");
    }

    const token = tokens[index];

    if (token.type === "STRING") {
        return {
            term: {
                kind: "const",
                value: { kind: "string", value: token.value },
            },
            nextIndex: index + 1,
        };
    }

    if (token.type === "NAT") {
        return {
            term: {
                kind: "const",
                value: { kind: "nat", value: parseInt(token.value, 10) },
            },
            nextIndex: index + 1,
        };
    }

    if (token.type === "IDENT") {
        return {
            term: {
                kind: "var",
                name: token.value,
            },
            nextIndex: index + 1,
        };
    }

    throw new Error(`Expected term but found ${token.type} at position ${token.pos}`);
}

/**
 * Parses an expression string into a structured form.
 * Grammar:
 * - expr := head | head "(" args? ")"
 * - head := IDENT
 * - args := term ("," term)*
 * - term := IDENT | NAT | STRING
 *
 * @param {string} str - The expression string to parse
 * @returns {ParsedExpr}
 * @throws {Error} If the expression is malformed
 */
function parseExpr(str) {
    if (str.trim().length === 0) {
        throw new Error("Expression cannot be empty");
    }

    const tokens = tokenize(str);

    if (tokens.length === 0) {
        throw new Error("Expression cannot be empty");
    }

    // First token must be an identifier (the head)
    if (tokens[0].type !== "IDENT") {
        throw new Error(
            `Expression must start with an identifier, found ${tokens[0].type} at position ${tokens[0].pos}`
        );
    }

    const head = tokens[0].value;

    // If only one token, it's a head-only constant
    if (tokens.length === 1) {
        return {
            kind: "const",
            name: head,
            args: [],
        };
    }

    // Must have opening paren for a call
    if (tokens[1].type !== "LPAREN") {
        throw new Error(
            `Expected '(' after head '${head}', found ${tokens[1].type} at position ${tokens[1].pos}`
        );
    }

    // Parse arguments
    const args = [];
    let i = 2;

    // Check for empty args
    if (i < tokens.length && tokens[i].type === "RPAREN") {
        i++; // skip closing paren
        
        // Must be at end
        if (i < tokens.length) {
            throw new Error(
                `Unexpected token ${tokens[i].type} after expression at position ${tokens[i].pos}`
            );
        }
        
        return {
            kind: "call",
            name: head,
            args: [],
        };
    }

    // Parse first argument
    const firstArg = parseTerm(tokens, i);
    args.push(firstArg.term);
    i = firstArg.nextIndex;

    // Parse remaining arguments
    while (i < tokens.length && tokens[i].type === "COMMA") {
        i++; // skip comma
        const arg = parseTerm(tokens, i);
        args.push(arg.term);
        i = arg.nextIndex;
    }

    // Must end with closing paren
    if (i >= tokens.length) {
        throw new Error("Expected ')' at end of expression");
    }

    if (tokens[i].type !== "RPAREN") {
        throw new Error(
            `Expected ')' or ',' but found ${tokens[i].type} at position ${tokens[i].pos}`
        );
    }

    i++; // skip closing paren

    // Must be at end
    if (i < tokens.length) {
        throw new Error(
            `Unexpected token ${tokens[i].type} after expression at position ${tokens[i].pos}`
        );
    }

    return {
        kind: "call",
        name: head,
        args,
    };
}

/**
 * Renders a term to its canonical string form.
 * @param {Term} term
 * @returns {string}
 */
function renderTerm(term) {
    if (term.kind === "var") {
        return term.name;
    }

    // term.kind === "const"
    if (!term.value) {
        throw new Error("Constant term must have a value");
    }

    if (term.value.kind === "string") {
        // Escape quotes and backslashes
        const escaped = term.value.value
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"');
        return `"${escaped}"`;
    }

    // term.value.kind === "nat"
    return String(term.value.value);
}

/**
 * Renders a parsed expression to its canonical string form.
 * @param {ParsedExpr} expr
 * @returns {string}
 */
function renderExpr(expr) {
    if (expr.kind === "const") {
        return expr.name;
    }

    // expr.kind === "call"
    if (expr.args.length === 0) {
        return `${expr.name}()`;
    }

    const renderedArgs = expr.args.map(renderTerm).join(",");
    return `${expr.name}(${renderedArgs})`;
}

/**
 * Canonicalizes an expression string.
 * Removes whitespace, standardizes separators, and renders constants in canonical form.
 *
 * @param {string} str - The expression string to canonicalize
 * @returns {string} The canonical form
 * @throws {Error} If the expression is malformed
 */
function canonicalize(str) {
    const parsed = parseExpr(str);
    return renderExpr(parsed);
}

module.exports = {
    parseExpr,
    canonicalize,
    renderExpr,
    renderTerm,
};
