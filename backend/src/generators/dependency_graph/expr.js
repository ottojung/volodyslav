/**
 * Expression parsing and canonicalization.
 */

/**
 * @typedef {import('./types').SchemaPattern} SchemaPattern
 */

const { makeInvalidExpressionError } = require("./errors");

/**
 * Token types for the lexer.
 * @typedef {'identifier' | 'lparen' | 'rparen' | 'comma' | 'eof'} TokenKind
 */

/**
 * A token from the lexer.
 * @typedef {Object} Token
 * @property {TokenKind} kind
 * @property {string} value - The token value
 * @property {number} pos - Position in source string
 */

/**
 * Argument in a parsed expression - only identifiers (variables) are supported.
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
     * Reads an identifier.
     * @returns {Token}
     */
    readIdentifier() {
        const startPos = this.pos;
        let value = "";

        // Read all alphanumeric and underscore characters
        while (this.peek() && /[a-zA-Z0-9_]/.test(this.peek() || "")) {
            value += this.next();
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
        if (/[a-zA-Z_]/.test(ch)) {
            return this.readIdentifier();
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
     * Parses a term (only identifiers for variables).
     * @returns {ParsedArg}
     */
    parseTerm() {
        const token = this.currentToken;
        if (token.kind === "identifier") {
            this.advance();
            return { kind: token.kind, value: token.value };
        }
        throw new Error(
            `Expected identifier but got ${token.kind} at position ${token.pos}`
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
 * - args can only be identifiers (variables)
 *
 * @param {SchemaPattern} str - The expression string to parse
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
 * Only identifiers are supported.
 * @param {ParsedArg} arg
 * @returns {string}
 */
function renderArg(arg) {
    return arg.value;
}

/**
 * Renders a parsed expression to its canonical string form.
 * @param {ParsedExpr} expr
 * @returns {SchemaPattern}
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
 *
 * @param {SchemaPattern | ParsedExpr} str - The expression string to canonicalize
 * @returns {SchemaPattern} The canonical form (still a valid expression)
 * @throws {Error} If the expression is malformed
 */
function canonicalize(str) {
    const parsed = typeof str === "string" ? parseExpr(str) : str;
    return parsed.name;
}

module.exports = {
    parseExpr,
    canonicalize,
    renderExpr,
    renderArg,
};
