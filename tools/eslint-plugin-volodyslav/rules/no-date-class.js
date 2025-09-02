"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Disallow using native Date class" },
    schema: [],
    messages: { 
      noDateConstructor: "Avoid using the native Date constructor. Use Luxon's DateTime.now(), DateTime.fromMillis(), DateTime.fromISO(), or other Luxon primitives instead.",
      noDateStatic: "Avoid using static Date methods. Use Luxon's DateTime.now() or other Luxon primitives instead."
    },
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    
    return {
      NewExpression(node) {
        // Check for new Date() calls
        if (node.callee.type === "Identifier" && node.callee.name === "Date") {
          // Allow Date usage if there's a specific performance comment
          const comments = sourceCode.getCommentsBefore(node);
          const allowPerformance = comments.some(comment => 
            comment.value.includes('performance-critical') || 
            comment.value.includes('eslint-disable-next-line volodyslav/no-date-class')
          );
          
          if (!allowPerformance) {
            context.report({ node, messageId: "noDateConstructor" });
          }
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
          // Allow Date usage if there's a specific performance comment
          const comments = sourceCode.getCommentsBefore(node);
          const allowPerformance = comments.some(comment => 
            comment.value.includes('performance-critical') || 
            comment.value.includes('eslint-disable-next-line volodyslav/no-date-class')
          );
          
          if (!allowPerformance) {
            context.report({ node, messageId: "noDateStatic" });
          }
        }
      }
    };
  },
};