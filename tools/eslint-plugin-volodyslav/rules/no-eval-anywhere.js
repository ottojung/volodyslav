"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Disallow using eval anywhere" },
    schema: [],
    messages: { unexpected: "Avoid using eval()." },
  },
  create(context) {
    return {
      CallExpression(node) {
        // Simple check for direct eval() calls
        if (node.callee.type === "Identifier" && node.callee.name === "eval") {
          context.report({ node, messageId: "unexpected" });
        }
        
        // Check for window.eval() or globalThis.eval()
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.property.name === "eval"
        ) {
          const object = node.callee.object;
          if (
            (object.type === "Identifier" && 
             (object.name === "window" || object.name === "globalThis"))
          ) {
            context.report({ node, messageId: "unexpected" });
          }
        }
        
        // Check for computed access: window["eval"] or globalThis["eval"]
        if (
          node.callee.type === "MemberExpression" &&
          node.callee.computed &&
          node.callee.property.type === "Literal" &&
          node.callee.property.value === "eval"
        ) {
          const object = node.callee.object;
          if (
            object.type === "Identifier" && 
            (object.name === "window" || object.name === "globalThis")
          ) {
            context.report({ node: node.callee.property, messageId: "unexpected" });
          }
        }
      }
    };
  },
};