/**
 * Expression parsing and canonicalization.
 */

const { makeInvalidExpressionError } = require("./errors");

/**
 * Token types for the lexer.
 * @typedef {'identifier' | 'string' | 'number' | 'lparen' | 'rparen' | 'comma' | 'eof'} TokenKind
 */

/**
 * A token from the lexer.
 * @typedef {Object} Token
 * @property {TokenKind} kind
 * @property {string} value - The token value
 * @property {number} pos - Position in source string
 */

/**
 * Argument in a parsed expression - only identifiers (variables) are allowed.
 * @typedef {Object} ParsedArg
 * @property {'identifier'} kind
 * @property {string} value - Variable name
 */

/**
 * Parsed expression - either an atom or a function call.
 * @typedef {Object} ParsedExpr
 * @property {'atom' | 'call'} kind - The kind of expression
 * @property {string} name - The name/head of the expression (identifier only)
 * @property {ParsedArg[]} args - Arguments (empty for atoms)
 */

/**
 * Lexer for tokenizing expression strings.
 */
class Lexer {
    /**
     * @param {string} input
     */
    constructor(input) {
        this.input = input;
        this.pos = 0;
    }

    /**
     * Peeks at the current character without consuming it.
     * @returns {string | null}
     */
    peek() {
        if (this.pos >= this.input.length) {
            return null;
        }
        const char = this.input[this.pos];
        return char !== undefined ? char : null;
    }

    /**
     * Advances position and returns the character.
     * @returns {string | null}
     */
    next() {
        if (this.pos >= this.input.length) {
            return null;
        }
        const char = this.input[this.pos++];
        return char !== undefined ? char : null;
    }

    /**
     * Skips whitespace characters.
     */
    skipWhitespace() {
        while (this.peek() && /\s/.test(this.peek() || "")) {
            this.next();
        }
    }

    /**
     * Reads a quoted string literal.
     * @param {string} quoteChar
     * @returns {Token}
     */
    readString(quoteChar) {
        const startPos = this.pos;
        this.next(); // consume opening quote
        let value = "";

        let ch = this.peek();
        while (ch !== null) {
            if (ch === quoteChar) {
                this.next(); // consume closing quote
                return { kind: "string", value, pos: startPos };
            }
            if (ch === "\\") {
                this.next(); // consume backslash
                const escaped = this.next();
                if (escaped === null) {
                    throw new Error(`Unclosed string literal at position ${startPos}`);
                }
                // Handle escape sequences
                if (escaped === quoteChar) {
                    value += quoteChar;
                } else if (escaped === "\\") {
                    value += "\\";
                } else if (escaped === "n") {
                    value += "\n";
                } else if (escaped === "t") {
                    value += "\t";
                } else if (escaped === "r") {
                    value += "\r";
                } else {
                    // For simplicity, accept any escaped character as-is
                    value += escaped;
                }
            } else {
                value += ch;
                this.next();
            }
            ch = this.peek();
        }

        throw new Error(`Unclosed string literal at position ${startPos}`);
    }

    /**
     * Reads an identifier or number.
     * @returns {Token}
     */
    readIdentifierOrNumber() {
        const startPos = this.pos;
        let value = "";

        // Read all alphanumeric and underscore characters
        while (this.peek() && /[a-zA-Z0-9_]/.test(this.peek() || "")) {
            value += this.next();
        }

        // Check if it's a valid natural number
        if (/^\d+$/.test(value)) {
            // Validate natural number format
            if (value.length > 1 && value[0] === "0") {
                throw new Error(
                    `Invalid number format at position ${startPos}: leading zeros not allowed (${value})`
                );
            }
            return { kind: "number", value, pos: startPos };
        }

        // Check if it's a valid identifier
        if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
            throw new Error(
                `Invalid identifier at position ${startPos}: ${value}`
            );
        }

        return { kind: "identifier", value, pos: startPos };
    }

    /**
     * Gets the next token.
     * @returns {Token}
     */
    nextToken() {
        this.skipWhitespace();

        const ch = this.peek();
        if (ch === null) {
            return { kind: "eof", value: "", pos: this.pos };
        }

        const pos = this.pos;

        if (ch === "(") {
            this.next();
            return { kind: "lparen", value: "(", pos };
        }
        if (ch === ")") {
            this.next();
            return { kind: "rparen", value: ")", pos };
        }
        if (ch === ",") {
            this.next();
            return { kind: "comma", value: ",", pos };
        }
        if (ch === '"' || ch === "'") {
            return this.readString(ch);
        }
        if (/[a-zA-Z0-9_]/.test(ch)) {
            return this.readIdentifierOrNumber();
        }

        throw new Error(`Unexpected character '${ch}' at position ${pos}`);
    }
}

/**
 * Parser for expressions.
 */
class Parser {
    /**
     * @param {Lexer} lexer
     */
    constructor(lexer) {
        /** @type {Lexer} */
        this.lexer = lexer;
        /** @type {Token} */
        this.currentToken = lexer.nextToken();
    }

    /**
     * Gets the current token kind without TypeScript control flow narrowing.
     * @returns {TokenKind}
     */
    getCurrentKind() {
        return this.currentToken.kind;
    }

    /**
     * Advances to the next token.
     * @returns {void}
     */
    advance() {
        this.currentToken = this.lexer.nextToken();
        // Explicitly mark return to help TypeScript understand mutation
        return;
    }

    /**
     * Expects a specific token kind and advances.
     * @param {TokenKind} kind
     */
    expect(kind) {
        if (this.currentToken.kind !== kind) {
            throw new Error(
                `Expected ${kind} but got ${this.currentToken.kind} at position ${this.currentToken.pos}`
            );
        }
        this.advance();
    }

    /**
     * Parses a term (only identifiers are allowed as arguments).
     * @returns {ParsedArg}
     */
    parseTerm() {
        const token = this.currentToken;
        if (token.kind === "identifier") {
            this.advance();
            return { kind: token.kind, value: token.value };
        }
        // Reject strings and numbers - only variables allowed
        throw new Error(
            `Expected identifier (variable) but got ${token.kind} at position ${token.pos}`
        );
    }

    /**
     * Parses an expression.
     * @returns {ParsedExpr}
     */
    parseExpr() {
        const initialToken = this.currentToken;
        if (initialToken.kind !== "identifier") {
            throw new Error(
                `Expected identifier at position ${initialToken.pos}`
            );
        }

        const name = initialToken.value;
        this.advance();

        // After advance(), check what kind of token we have
        if (this.getCurrentKind() === "lparen") {
            this.advance(); // consume '('

            /** @type {ParsedArg[]} */
            const args = [];

            // Check for empty args
            if (this.getCurrentKind() === "rparen") {
                this.advance(); // consume '('
                return { kind: "call", name, args: [] };
            }

            // Parse arguments
            args.push(this.parseTerm());

            while (this.getCurrentKind() === "comma") {
                this.advance(); // consume ','
                args.push(this.parseTerm());
            }

            this.expect("rparen");

            return { kind: "call", name, args };
        }

        // It's an atom
        return { kind: "atom", name, args: [] };
    }

    /**
     * Parses the full expression and ensures we've consumed all input.
     * @returns {ParsedExpr}
     */
    parse() {
        const initialToken = this.currentToken;
        if (initialToken.kind === "eof") {
            throw new Error("Expression cannot be empty");
        }

        const expr = this.parseExpr();

        // After parseExpr(), check the current token
        if (this.currentToken.kind !== "eof") {
            throw new Error(
                `Unexpected token ${this.currentToken.kind} at position ${this.currentToken.pos}`
            );
        }

        return expr;
    }
}

/**
 * Parses an expression string into a structured form.
 * Supports:
 * - atoms: "name"
 * - calls: "name(arg1, arg2, ...)"
 * - args can be: identifiers, quoted strings, or natural numbers
 *
 * @param {string} str - The expression string to parse
 * @returns {ParsedExpr}
 * @throws {Error} If the expression is malformed
 */
function parseExpr(str) {
    try {
        const lexer = new Lexer(str);
        const parser = new Parser(lexer);
        return parser.parse();
    } catch (err) {
        if (err instanceof Error && err.name === "InvalidExpressionError") {
            throw err;
        }
        const message = err instanceof Error ? err.message : String(err);
        throw makeInvalidExpressionError(str, message);
    }
}

/**
 * Renders a parsed argument to its canonical string form.
 * Note: While parsing only accepts identifiers, this function must handle
 * string and number args for substitution (converting ConstValue back to strings).
 * @param {ParsedArg | {kind: 'string', value: string} | {kind: 'number', value: string}} arg
 * @returns {string}
 */
function renderArg(arg) {
    if (arg.kind === "identifier") {
        return arg.value;
    } else if (arg.kind === "string") {
        // Escape special characters for canonical form
        const escaped = arg.value
            .replace(/\\/g, "\\\\")
            .replace(/'/g, "\\'")
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t")
            .replace(/\r/g, "\\r");
        return `'${escaped}'`;
    } else if (arg.kind === "number") {
        return arg.value;
    }
    throw new Error(`Unknown arg kind: ${arg.kind}`);
}

/**
 * Renders a parsed expression to its canonical string form.
 * @param {ParsedExpr} expr
 * @returns {string}
 */
function renderExpr(expr) {
    if (expr.kind === "atom") {
        return expr.name;
    } else {
        const renderedArgs = expr.args.map(renderArg).join(",");
        return `${expr.name}(${renderedArgs})`;
    }
}

/**
 * Canonicalizes an expression string.
 * Removes irrelevant whitespace and returns a standardized form.
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
    renderArg,
};
