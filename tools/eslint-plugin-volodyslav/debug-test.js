"use strict";
const { Linter } = require("eslint");

const rule = {
  meta: { type: "problem" },
  create(context) {
    const sourceCode = context.getSourceCode();
    const allComments = sourceCode.getAllComments();
    
    return {
      "VariableDeclarator"(node) {
        if (!node.init) return;
        
        // Find comments that appear just before this node's init
        const initStart = node.init.range[0];
        
        // Look for a comment that ends close to where init starts
        const nearbyComments = allComments.filter(c => {
          const gap = sourceCode.text.slice(c.range[1], initStart);
          // Check if gap contains only whitespace and parentheses
          return c.range[1] < initStart && /^\s*\($/.test(gap);
        });
        
        if (nearbyComments.length > 0) {
          const lastComment = nearbyComments[nearbyComments.length - 1];
          console.log(`Found type cast pattern!`);
          console.log(`  Variable: ${node.id.name}`);
          console.log(`  Comment: ${lastComment.value}`);
          console.log(`  Init node type: ${node.init.type}`);
          const gap = sourceCode.text.slice(lastComment.range[1], initStart);
          console.log(`  Gap text: "${gap}"`);
        }
      }
    };
  }
};

const linter = new Linter();
linter.defineRule("test-rule", rule);

const code = `const x = /** @type {number} */ (123);
const obj = /** @type {SomeType} */ (unknownObject);`;

linter.verify(code, {
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
  rules: { "test-rule": "error" }
});
