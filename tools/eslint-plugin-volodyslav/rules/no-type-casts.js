"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Disallow JSDoc type casts" },
    schema: [],
    messages: {
      noTypeCast: "Type casting is not allowed. Use type guards with instanceof instead.",
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    const allComments = sourceCode.getAllComments();

    /**
     * Check if a node is preceded by a type cast comment pattern.
     * Pattern: /** @type {...} *\/ (expression)
     */
    function checkNodeForTypeCast(node) {
      if (!node || !node.range) return;
      
      const nodeStart = node.range[0];
      
      // Find comments that appear just before this node
      const nearbyComments = allComments.filter(c => {
        if (c.range[1] >= nodeStart) return false;
        
        const gap = sourceCode.text.slice(c.range[1], nodeStart);
        // Check if gap contains only whitespace and a single opening parenthesis
        return /^\s*\($/.test(gap);
      });
      
      if (nearbyComments.length > 0) {
        const lastComment = nearbyComments[nearbyComments.length - 1];
        
        // Check if it's a block comment with @type
        if (
          lastComment.type === "Block" &&
          /^\*\s*@type\s*\{/.test(lastComment.value)
        ) {
          context.report({
            node,
            messageId: "noTypeCast",
          });
        }
      }
    }

    return {
      VariableDeclarator(node) {
        if (node.init) {
          checkNodeForTypeCast(node.init);
        }
      },
      AssignmentExpression(node) {
        checkNodeForTypeCast(node.right);
      },
      ReturnStatement(node) {
        if (node.argument) {
          checkNodeForTypeCast(node.argument);
        }
      },
      CallExpression(node) {
        // Check each argument for type cast
        node.arguments.forEach(arg => checkNodeForTypeCast(arg));
      },
      ArrayExpression(node) {
        // Check each element for type cast
        node.elements.forEach(element => {
          if (element) {
            checkNodeForTypeCast(element);
          }
        });
      },
      Property(node) {
        // Check object property values
        checkNodeForTypeCast(node.value);
      },
    };
  },
};
