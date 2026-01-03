"use strict";

const ts = require("typescript");

function toEslintLoc(sourceFile, startPos, endPos) {
  const start = ts.getLineAndCharacterOfPosition(sourceFile, startPos);
  const end = ts.getLineAndCharacterOfPosition(sourceFile, endPos);

  return {
    start: { line: start.line + 1, column: start.character },
    end: { line: end.line + 1, column: end.character },
  };
}

function kindLabel(node) {
  if (ts.isAsExpression(node)) return "`as` assertion";
  if (ts.isTypeAssertionExpression(node)) return "`<T>` assertion";
  if (ts.isNonNullExpression(node)) return "non-null assertion `!`";
  if (node.kind === ts.SyntaxKind.SatisfiesExpression) return "`satisfies` operator";
  // For JSDoc type casts, check if it's a ParenthesizedExpression with JSDoc type tag
  if (ts.isParenthesizedExpression(node) && node.jsDoc && node.jsDoc.length > 0) {
    // Check if any JSDoc has a type tag
    for (const doc of node.jsDoc) {
      if (doc.tags) {
        for (const tag of doc.tags) {
          if (tag.kind === ts.SyntaxKind.JSDocTypeTag) {
            return "JSDoc type assertion (`/** @type */ (expr)`)";
          }
        }
      }
    }
  }
  return "type assertion";
}

function isJSDocTypeCast(node) {
  // A JSDoc type cast is a ParenthesizedExpression with a @type JSDoc tag
  if (!ts.isParenthesizedExpression(node)) return false;
  if (!node.jsDoc || node.jsDoc.length === 0) return false;
  
  for (const doc of node.jsDoc) {
    if (doc.tags) {
      for (const tag of doc.tags) {
        if (tag.kind === ts.SyntaxKind.JSDocTypeTag) {
          return true;
        }
      }
    }
  }
  
  return false;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description:
        "Disallow all TypeScript/JSDoc type assertions (as, <T>, /** @type */ (expr), optionally ! and satisfies).",
    },
    schema: [
      {
        type: "object",
        properties: {
          includeNonNull: { type: "boolean" },   // default true
          includeSatisfies: { type: "boolean" }, // default true
        },
        additionalProperties: false,
      },
    ],
    messages: {
      unexpected: "Avoid type casting/type assertions: {{kind}}.",
      missingParserServices:
        "This rule requires @typescript-eslint/parser with type information (parserOptions.project or projectService).",
    },
  },

  create(context) {
    const opts = context.options[0] || {};
    const includeNonNull = opts.includeNonNull !== false;
    const includeSatisfies = opts.includeSatisfies !== false;

    const services = context.parserServices;

    // We *must* have a TS Program to get a real TS SourceFile and its nodes.
    if (!services || !services.program || !services.esTreeNodeToTSNodeMap) {
      // Silently skip files without parser services (e.g., config files, tests not in tsconfig)
      return {};
    }

    function shouldReport(tsNode) {
      if (ts.isAsExpression(tsNode)) return true;
      if (ts.isTypeAssertionExpression(tsNode)) return true;
      if (isJSDocTypeCast(tsNode)) return true;
      if (includeNonNull && ts.isNonNullExpression(tsNode)) return true;
      if (includeSatisfies && tsNode.kind === ts.SyntaxKind.SatisfiesExpression) return true;
      return false;
    }

    return {
      Program(esProgramNode) {
        // Map ESTree Program -> TS SourceFile (no source-text scanning required).
        const tsSourceFile = services.esTreeNodeToTSNodeMap.get(esProgramNode);
        if (!tsSourceFile) return;

        const visit = (node) => {
          if (shouldReport(node)) {
            // For JSDoc type casts, include the JSDoc comment in the range
            const includeJsDoc = isJSDocTypeCast(node);

            const startPos = node.getStart(tsSourceFile, includeJsDoc);
            const endPos = node.getEnd();

            context.report({
              loc: toEslintLoc(tsSourceFile, startPos, endPos),
              messageId: "unexpected",
              data: { kind: kindLabel(node) },
            });
          }

          ts.forEachChild(node, visit);
        };

        visit(tsSourceFile);
      },
    };
  },
};
