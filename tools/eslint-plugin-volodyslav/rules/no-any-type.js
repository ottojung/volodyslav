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

/**
 * Check if a TypeScript type node is or contains 'any'
 */
function isAnyType(typeNode) {
  if (!typeNode) return false;
  
  // Direct 'any' keyword
  if (typeNode.kind === ts.SyntaxKind.AnyKeyword) {
    return true;
  }
  
  // Check union types: string | any
  if (ts.isUnionTypeNode(typeNode)) {
    return typeNode.types.some(isAnyType);
  }
  
  // Check intersection types: Foo & any
  if (ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some(isAnyType);
  }
  
  // Check array types: any[]
  if (ts.isArrayTypeNode(typeNode)) {
    return isAnyType(typeNode.elementType);
  }
  
  // Check tuple types: [string, any]
  if (ts.isTupleTypeNode(typeNode)) {
    return typeNode.elements.some(isAnyType);
  }
  
  // Check generic types: Promise<any>, Map<string, any>
  if (ts.isTypeReferenceNode(typeNode) && typeNode.typeArguments) {
    return typeNode.typeArguments.some(isAnyType);
  }
  
  // Check function types: (x: any) => void
  if (ts.isFunctionTypeNode(typeNode) || ts.isConstructorTypeNode(typeNode)) {
    // Check parameters
    if (typeNode.parameters) {
      for (const param of typeNode.parameters) {
        if (param.type && isAnyType(param.type)) {
          return true;
        }
      }
    }
    // Check return type
    if (typeNode.type && isAnyType(typeNode.type)) {
      return true;
    }
  }
  
  // Check parenthesized types: (any)
  if (ts.isParenthesizedTypeNode(typeNode)) {
    return isAnyType(typeNode.type);
  }
  
  return false;
}

module.exports = {
  meta: {
    type: "problem",
    docs: {
      description: "Disallow the use of 'any' type in TypeScript/JSDoc type annotations.",
    },
    schema: [],
    messages: {
      unexpected: "Avoid using 'any' type. Use a more specific type instead.",
      missingParserServices:
        "This rule requires @typescript-eslint/parser with type information (parserOptions.project or projectService).",
    },
  },

  create(context) {
    const services = context.parserServices;

    // We need parser services for TypeScript API access
    if (!services || !services.program || !services.esTreeNodeToTSNodeMap) {
      // Silently skip files without parser services
      return {};
    }

    return {
      Program(esProgramNode) {
        const tsSourceFile = services.esTreeNodeToTSNodeMap.get(esProgramNode);
        if (!tsSourceFile) return;

        const visit = (node) => {
          // Check JSDoc type annotations
          if (node.jsDoc) {
            for (const doc of node.jsDoc) {
              // Check @type tags
              if (doc.tags) {
                for (const tag of doc.tags) {
                  if (tag.typeExpression && tag.typeExpression.type) {
                    if (isAnyType(tag.typeExpression.type)) {
                      const startPos = tag.typeExpression.getStart(tsSourceFile);
                      const endPos = tag.typeExpression.getEnd();
                      
                      context.report({
                        loc: toEslintLoc(tsSourceFile, startPos, endPos),
                        messageId: "unexpected",
                      });
                    }
                  }
                }
              }
              
              // Check inline @type in JSDoc comment
              if (doc.type && isAnyType(doc.type)) {
                const startPos = doc.type.getStart(tsSourceFile);
                const endPos = doc.type.getEnd();
                
                context.report({
                  loc: toEslintLoc(tsSourceFile, startPos, endPos),
                  messageId: "unexpected",
                });
              }
            }
          }
          
          // Check TypeScript type annotations (for .ts files or JSDoc in .js)
          // Function parameters
          if (ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)) {
            for (const param of node.parameters) {
              if (param.type && isAnyType(param.type)) {
                const startPos = param.type.getStart(tsSourceFile);
                const endPos = param.type.getEnd();
                
                context.report({
                  loc: toEslintLoc(tsSourceFile, startPos, endPos),
                  messageId: "unexpected",
                });
              }
            }
            
            // Return type
            if (node.type && isAnyType(node.type)) {
              const startPos = node.type.getStart(tsSourceFile);
              const endPos = node.type.getEnd();
              
              context.report({
                loc: toEslintLoc(tsSourceFile, startPos, endPos),
                messageId: "unexpected",
              });
            }
          }
          
          // Variable declarations
          if (ts.isVariableDeclaration(node) && node.type && isAnyType(node.type)) {
            const startPos = node.type.getStart(tsSourceFile);
            const endPos = node.type.getEnd();
            
            context.report({
              loc: toEslintLoc(tsSourceFile, startPos, endPos),
              messageId: "unexpected",
            });
          }
          
          // Property declarations
          if (ts.isPropertyDeclaration(node) && node.type && isAnyType(node.type)) {
            const startPos = node.type.getStart(tsSourceFile);
            const endPos = node.type.getEnd();
            
            context.report({
              loc: toEslintLoc(tsSourceFile, startPos, endPos),
              messageId: "unexpected",
            });
          }
          
          // Type aliases
          if (ts.isTypeAliasDeclaration(node) && isAnyType(node.type)) {
            const startPos = node.type.getStart(tsSourceFile);
            const endPos = node.type.getEnd();
            
            context.report({
              loc: toEslintLoc(tsSourceFile, startPos, endPos),
              messageId: "unexpected",
            });
          }

          ts.forEachChild(node, visit);
        };

        visit(tsSourceFile);
      },
    };
  },
};
