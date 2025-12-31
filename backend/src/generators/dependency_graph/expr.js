/**
 * Expression parsing and canonicalization with support for quoted strings and natural numbers.
 */

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
 * Argument in a parsed expression - can be identifier, string, or number.
 * @typedef {Object} ParsedArg
 * @property {'identifier' | 'string' | 'number'} kind
 * @property {string} value - Raw value (identifier name, string content, or number as string)
 */

/**
 * Parsed expression - either a constant or a function call.
 * @typedef {Object} ParsedExpr
 * @property {'const' | 'call'} kind - The kind of expression
 * @property {string} name - The name/head of the expression (identifier only)
 * @property {ParsedArg[]} args - Arguments (empty for constants)
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
     * @returns {Token}
     */
    readString() {
        const startPos = this.pos;
        this.next(); // consume opening quote
        let value = "";

        while (true) {
            const ch = this.peek();
            if (ch === null) {
                throw new Error(`Unclosed string literal at position ${startPos}`);
            }
            if (ch === '"') {
                this.next(); // consume closing quote
                break;
            }
            if (ch === "\\") {
                this.next(); // consume backslash
                const escaped = this.next();
                if (escaped === null) {
                    throw new Error(`Unclosed string literal at position ${startPos}`);
                }
                // Handle escape sequences
                if (escaped === '"') {
                    value += '"';
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
        }

        return { kind: "string", value, pos: startPos };
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
        if (ch === '"') {
            return this.readString();
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
     * Advances to the next token.
     */
    advance() {
        this.currentToken = this.lexer.nextToken();
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
     * Parses a term (identifier, string, or number).
     * @returns {ParsedArg}
     */
    parseTerm() {
        const token = this.currentToken;
        if (
            token.kind === "identifier" ||
            token.kind === "string" ||
            token.kind === "number"
        ) {
            this.advance();
            return { kind: token.kind, value: token.value };
        }
        throw new Error(
            `Expected term (identifier, string, or number) but got ${token.kind} at position ${token.pos}`
        );
    }

    /**
     * Parses an expression.
     * @returns {ParsedExpr}
     */
    parseExpr() {
        if (this.currentToken.kind !== "identifier") {
            throw new Error(
                `Expected identifier at position ${this.currentToken.pos}`
            );
        }

        const name = this.currentToken.value;
        this.advance();

        // Check if it's a function call
        // Type assertion needed because TypeScript narrows too aggressively
        const tokenKind = /** @type {TokenKind} */ (this.currentToken.kind);
        if (tokenKind === "lparen") {
            this.advance(); // consume '('

            /** @type {ParsedArg[]} */
            const args = [];

            // Handle empty args - type assertion after advance
            const nextToken = /** @type {TokenKind} */ (this.currentToken.kind);
            if (nextToken === "rparen") {
                this.advance();
                return { kind: "call", name, args };
            }

            // Parse arguments
            args.push(this.parseTerm());

            // Type assertion after parseTerm which can change currentToken
            let nextTokenKind = /** @type {TokenKind} */ (this.currentToken.kind);
            while (nextTokenKind === "comma") {
                this.advance(); // consume ','
                args.push(this.parseTerm());
                nextTokenKind = /** @type {TokenKind} */ (this.currentToken.kind);
            }

            this.expect("rparen");

            return { kind: "call", name, args };
        }

        // It's a constant
        return { kind: "const", name, args: [] };
    }

    /**
     * Parses the full expression and ensures we've consumed all input.
     * @returns {ParsedExpr}
     */
    parse() {
        if (this.currentToken.kind === "eof") {
            throw new Error("Expression cannot be empty");
        }

        const expr = this.parseExpr();

        // Type assertion needed because TypeScript narrows too aggressively
        const tokenKind = /** @type {TokenKind} */ (this.currentToken.kind);
        if (tokenKind !== "eof") {
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
 * - constants: "name"
 * - calls: "name(arg1, arg2, ...)"
 * - args can be: identifiers, quoted strings, or natural numbers
 *
 * @param {string} str - The expression string to parse
 * @returns {ParsedExpr}
 * @throws {Error} If the expression is malformed
 */
function parseExpr(str) {
    const lexer = new Lexer(str);
    const parser = new Parser(lexer);
    return parser.parse();
}

/**
 * Renders a parsed argument to its canonical string form.
 * @param {ParsedArg} arg
 * @returns {string}
 */
function renderArg(arg) {
    if (arg.kind === "identifier") {
        return arg.value;
    } else if (arg.kind === "string") {
        // Escape special characters for canonical form
        const escaped = arg.value
            .replace(/\\/g, "\\\\")
            .replace(/"/g, '\\"')
            .replace(/\n/g, "\\n")
            .replace(/\t/g, "\\t")
            .replace(/\r/g, "\\r");
        return `"${escaped}"`;
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
    if (expr.kind === "const") {
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
