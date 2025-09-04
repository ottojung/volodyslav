"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Disallow using native Date class" },
    schema: [],
    messages: { 
      noDateConstructor: "Avoid using the native Date constructor. Methods of `Datetime` capability should be used instead.",
      noDateStatic: "Avoid using static Date methods. Methods of `Datetime` capability should be used instead."
    },
  },
  create(context) {
    return {
      NewExpression(node) {
        // Check for new Date() calls
        if (node.callee.type === "Identifier" && node.callee.name === "Date") {
          context.report({ node, messageId: "noDateConstructor" });
        }
      },
      CallExpression(node) {
        // Check for Date.now(), Date.parse(), etc.
        if (
          node.callee.type === "MemberExpression" &&
          !node.callee.computed &&
          node.callee.object.type === "Identifier" &&
          node.callee.object.name === "Date"
        ) {
          context.report({ node, messageId: "noDateStatic" });
        }
      }
    };
  },
};