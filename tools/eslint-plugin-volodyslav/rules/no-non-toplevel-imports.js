"use strict";

/**
 * Node types that indicate the require() is NOT at the module top level.
 */
const NON_TOPLEVEL_INDICATORS = new Set([
    "FunctionDeclaration",
    "FunctionExpression",
    "ArrowFunctionExpression",
    "IfStatement",
    "ConditionalExpression",
    "SwitchCase",
    "ForStatement",
    "ForInStatement",
    "ForOfStatement",
    "WhileStatement",
    "DoWhileStatement",
    "TryStatement",
    "CatchClause",
    "WithStatement",
]);

module.exports = {
    meta: {
        type: "problem",
        docs: {
            description:
                "Disallow import statements (require / import()) outside module top level",
        },
        schema: [
            {
                type: "object",
                properties: {
                    ignorePatterns: {
                        type: "array",
                        items: {
                            type: "string",
                        },
                    },
                },
                additionalProperties: false,
            },
        ],
        messages: {
            nonToplevelRequire:
                "require() must be used at the top level of the module, not inside '{{enclosing}}'.",
            nonToplevelDynamicImport:
                "import() must be used at the top level of the module, not inside '{{enclosing}}'.",
        },
    },
    create(context) {
        const options = context.options[0] || {};
        const ignorePatterns = options.ignorePatterns || [];

        const filename = context.getFilename();

        function shouldIgnoreFile() {
            for (const pattern of ignorePatterns) {
                const regexPattern = pattern
                    .replace(/\./g, "\\.")
                    .replace(/\*\*/g, "\u00a7\u00a7DOUBLE\u00a7\u00a7")
                    .replace(/\*/g, "[^/]*")
                    .replace(/\u00a7\u00a7DOUBLE\u00a7\u00a7/g, ".*");

                const regex = new RegExp(regexPattern);
                if (regex.test(filename)) {
                    return true;
                }
            }
            return false;
        }

        if (shouldIgnoreFile()) {
            return {};
        }

        function findNonToplevelAncestor(node) {
            const ancestors = context.sourceCode.getAncestors(node);
            for (let i = ancestors.length - 1; i >= 0; i--) {
                const ancestor = ancestors[i];
                if (ancestor.type === "Program") {
                    return null;
                }
                if (NON_TOPLEVEL_INDICATORS.has(ancestor.type)) {
                    return ancestor;
                }
            }
            return null;
        }

        return {
            CallExpression(node) {
                if (
                    node.callee.type === "Identifier" &&
                    node.callee.name === "require" &&
                    node.arguments.length > 0 &&
                    node.arguments[0].type === "Literal" &&
                    typeof node.arguments[0].value === "string"
                ) {
                    const enclosing = findNonToplevelAncestor(node);
                    if (enclosing) {
                        context.report({
                            node: node.callee,
                            messageId: "nonToplevelRequire",
                            data: {
                                enclosing: enclosing.type,
                            },
                        });
                    }
                }
            },
            ImportExpression(node) {
                const enclosing = findNonToplevelAncestor(node);
                if (enclosing) {
                    context.report({
                        node,
                        messageId: "nonToplevelDynamicImport",
                        data: {
                            enclosing: enclosing.type,
                        },
                    });
                }
            },
        };
    },
};
