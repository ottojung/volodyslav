"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Disallow using 'any' type in JSDoc annotations" },
    schema: [],
    messages: { 
      noAnyType: "Avoid using 'any' type in JSDoc. Use a more specific type instead." 
    }
  },
  create(context) {
    const sourceCode = context.getSourceCode();
    
    /**
     * Check if a comment is a JSDoc comment containing 'any' type
     * @param {object} comment - ESLint comment object
     * @returns {Array<{line: number, column: number}>} - Locations of 'any' occurrences
     */
    function checkJSDocForAny(comment) {
      if (comment.type !== "Block" || !comment.value.startsWith("*")) {
        return [];
      }
      
      const locations = [];
      const lines = comment.value.split("\n");
      
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        
        // Match {any} or {any[]} or similar patterns in JSDoc
        // We need to find 'any' inside curly braces that are part of JSDoc type annotations
        // Pattern matches: {any}, {any[]}, {any|string}, {string|any}, etc.
        const anyTypePattern = /{[^}]*\bany\b[^}]*}/g;
        let match;
        
        while ((match = anyTypePattern.exec(line)) !== null) {
          // Calculate the actual position in the source
          const matchIndex = match.index;
          const anyIndex = match[0].indexOf("any");
          
          locations.push({
            line: comment.loc.start.line + i,
            column: comment.loc.start.column + matchIndex + anyIndex + 2 // +2 for "/*"
          });
        }
      }
      
      return locations;
    }
    
    return {
      Program() {
        const comments = sourceCode.getAllComments();
        
        for (const comment of comments) {
          const locations = checkJSDocForAny(comment);
          
          for (const loc of locations) {
            context.report({
              loc: {
                start: { line: loc.line, column: loc.column },
                end: { line: loc.line, column: loc.column + 3 }
              },
              messageId: "noAnyType"
            });
          }
        }
      }
    };
  }
};
