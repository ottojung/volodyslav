"use strict";

const MAX_CODE_LINES = 300;

/**
 * Returns true if the given filename should be excluded from this rule.
 * Test files are excluded because they often need many test cases in one file.
 *
 * @param {string} filename
 * @returns {boolean}
 */
function isTestFile(filename) {
    // Matches files inside any /tests/ directory or with .test.js/.test.jsx extension
    return (
        /[/\\]tests[/\\]/.test(filename) ||
        /\.test\.[jt]sx?$/.test(filename) ||
        /\.spec\.[jt]sx?$/.test(filename)
    );
}

module.exports = {
    meta: {
        type: "suggestion",
        docs: {
            description:
                "Enforce a maximum number of code lines per file (comments and blank lines are not counted).",
        },
        schema: [],
        messages: {
            tooManyLines:
                "This file contains {{count}} lines of code, which exceeds the limit of {{max}} lines. " +
                "Please split this file into smaller modules. " +
                "NOTE: Only non-blank, non-comment lines are counted — " +
                "comment-only lines and blank lines do NOT count toward this limit.",
        },
    },

    create(context) {
        const filename = context.getFilename();

        if (isTestFile(filename)) {
            return {};
        }

        return {
            Program(node) {
                const sourceCode = context.getSourceCode();

                // getTokens() returns all code tokens (not comments, not whitespace).
                // Each token's loc.start.line tells us which line has actual code.
                const tokens = sourceCode.getTokens(node);

                // Build the set of line numbers that contain at least one code token.
                const linesWithCode = new Set();
                for (const token of tokens) {
                    linesWithCode.add(token.loc.start.line);
                }

                const codeLineCount = linesWithCode.size;

                if (codeLineCount > MAX_CODE_LINES) {
                    context.report({
                        node,
                        messageId: "tooManyLines",
                        data: {
                            count: codeLineCount,
                            max: MAX_CODE_LINES,
                        },
                    });
                }
            },
        };
    },
};
