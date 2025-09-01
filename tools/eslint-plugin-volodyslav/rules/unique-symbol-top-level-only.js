"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "Enforce UniqueSymbol creation only at module top-level" },
    schema: [],
    messages: { 
      notTopLevel: "UniqueSymbol can only be created at module top-level.",
      notInFunction: "UniqueSymbol creation is not allowed inside functions.",
      notInMethod: "UniqueSymbol creation is not allowed inside methods.",
      notInClass: "UniqueSymbol creation is not allowed inside classes.",
      notInBlock: "UniqueSymbol creation is not allowed inside block statements."
    },
  },
  create(context) {
    /**
     * Check if a node is a UniqueSymbol creation call
     * @param {object} node - AST node
     * @returns {boolean}
     */
    function isUniqueSymbolCreation(node) {
      if (node.type !== "CallExpression") return false;
      
      // Check for makeRandom() or fromString() calls
      if (node.callee.type === "MemberExpression" && 
          !node.callee.computed &&
          (node.callee.property.name === "makeRandom" || 
           node.callee.property.name === "fromString")) {
        
        const object = node.callee.object;
        
        // Check for require("...unique_symbol").makeRandom()
        if (object.type === "CallExpression" &&
            object.callee.type === "Identifier" &&
            object.callee.name === "require" &&
            object.arguments.length === 1 &&
            object.arguments[0].type === "Literal" &&
            typeof object.arguments[0].value === "string" &&
            object.arguments[0].value.includes("unique_symbol")) {
          return true;
        }
        
        // Check if it's called on a variable that might be the UniqueSymbol module
        // We'll be more conservative here and only flag if the variable name
        // suggests it's a unique symbol module
        if (object.type === "Identifier" && 
            (object.name.toLowerCase().includes("unique") || 
             object.name.toLowerCase().includes("symbol"))) {
          return true;
        }
      }
      
      return false;
    }
    
    /**
     * Check if we are inside a function, method, or block that's not top-level
     * @param {object} node - AST node
     * @returns {boolean}
     */
    function isInsideNonTopLevelContext(node) {
      // Use context.getAncestors() which works in older ESLint versions
      const ancestors = context.getAncestors ? context.getAncestors() : 
                        (context.getSourceCode && context.getSourceCode().getAncestors ? 
                         context.getSourceCode().getAncestors(node) : []);
      
      for (const ancestor of ancestors) {
        switch (ancestor.type) {
          case "FunctionDeclaration":
          case "FunctionExpression":
          case "ArrowFunctionExpression":
          case "MethodDefinition":
            return true;
          case "IfStatement":
          case "ForStatement":
          case "WhileStatement":
          case "DoWhileStatement":
          case "SwitchStatement":
          case "TryStatement":
          case "CatchClause":
          case "WithStatement":
            return true;
        }
      }
      
      return false;
    }
    
    /**
     * Get a more specific error message based on the current context
     * @param {object} node - AST node
     * @returns {string}
     */
    function getSpecificErrorMessage(node) {
      const ancestors = context.getAncestors ? context.getAncestors() : 
                        (context.getSourceCode && context.getSourceCode().getAncestors ? 
                         context.getSourceCode().getAncestors(node) : []);
      
      for (let i = ancestors.length - 1; i >= 0; i--) {
        const ancestor = ancestors[i];
        
        switch (ancestor.type) {
          case "FunctionDeclaration":
          case "FunctionExpression":
          case "ArrowFunctionExpression":
            return "notInFunction";
          case "MethodDefinition":
            return "notInMethod";
          case "ClassDeclaration":
          case "ClassExpression":
            return "notInClass";
          case "IfStatement":
          case "ForStatement":
          case "WhileStatement":
          case "DoWhileStatement":
          case "SwitchStatement":
          case "TryStatement":
          case "CatchClause":
          case "WithStatement":
            return "notInBlock";
        }
      }
      
      return "notTopLevel";
    }

    return {
      CallExpression(node) {
        if (isUniqueSymbolCreation(node) && isInsideNonTopLevelContext(node)) {
          const messageId = getSpecificErrorMessage(node);
          context.report({ 
            node, 
            messageId 
          });
        }
      }
    };
  },
};