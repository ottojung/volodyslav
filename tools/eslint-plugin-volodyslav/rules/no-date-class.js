"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Disallow using the native Date class" },
    schema: [],
    messages: { 
      unexpected: "Avoid using the native Date class. Use luxon DateTime primitives instead for better timezone handling and more robust date operations." 
    }
  },
  create(context) {
    return {
      NewExpression(node) {
        // Check for new Date()
        if (node.callee.type === "Identifier" && node.callee.name === "Date") {
          context.report({ node, messageId: "unexpected" });
        }
      },
      
      CallExpression(node) {
        // Check for Date() calls (without new)
        if (node.callee.type === "Identifier" && node.callee.name === "Date") {
          context.report({ node, messageId: "unexpected" });
        }
        
        // Check for Date.now(), Date.parse(), etc.
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Date"
        ) {
          context.report({ node, messageId: "unexpected" });
        }
      }
    };
  }
};
