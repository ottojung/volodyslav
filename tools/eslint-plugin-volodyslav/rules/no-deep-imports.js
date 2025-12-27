"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { 
      description: "Disallow deep imports - only direct module/directory imports are allowed"
    },
    schema: [
      {
        type: "object",
        properties: {
          ignorePatterns: {
            type: "array",
            items: {
              type: "string"
            }
          }
        },
        additionalProperties: false
      }
    ],
    messages: { 
      deepImport: "Deep import detected. Import from '{{module}}' directly instead of '{{path}}'" 
    }
  },
  create(context) {
    const options = context.options[0] || {};
    const ignorePatterns = options.ignorePatterns || [];
    
    // Get the filename relative to the project root
    const filename = context.getFilename();
    
    // Check if the file should be ignored using simple glob patterns
    function shouldIgnoreFile() {
      for (const pattern of ignorePatterns) {
        // Convert glob pattern to regex
        // Support ** for any directory depth and * for any characters
        const regexPattern = pattern
          .replace(/\./g, '\\.')
          .replace(/\*\*/g, '§§DOUBLE§§')
          .replace(/\*/g, '[^/]*')
          .replace(/§§DOUBLE§§/g, '.*');
        
        const regex = new RegExp(regexPattern);
        if (regex.test(filename)) {
          return true;
        }
      }
      return false;
    }
    
    if (shouldIgnoreFile()) {
      return {};
    }
    /**
     * Check if a require path is a deep import
     * @param {string} importPath - The path being imported
     * @returns {{isDeep: boolean, module: string}} - Whether it's deep and the module name
     */
    function checkDeepImport(importPath) {
      // Ignore external packages (those without ./ or ../)
      if (!importPath.startsWith('./') && !importPath.startsWith('../')) {
        return { isDeep: false, module: '' };
      }

      // Remove leading ./ or ../
      // Count how many path segments remain after the relative part
      let path = importPath;
      let relativePrefix = '';
      
      // Extract all leading ../ parts
      while (path.startsWith('../')) {
        relativePrefix += '../';
        path = path.substring(3);
      }
      
      // Extract leading ./ if present
      if (path.startsWith('./')) {
        relativePrefix += './';
        path = path.substring(2);
      }
      
      // Now check if there are any remaining slashes
      // If there are, it's a deep import
      const hasDeepPath = path.includes('/');
      
      if (hasDeepPath) {
        // Extract the top-level module (first segment after relative prefix)
        const firstSlash = path.indexOf('/');
        const module = relativePrefix + path.substring(0, firstSlash);
        return { isDeep: true, module };
      }
      
      return { isDeep: false, module: '' };
    }

    return {
      CallExpression(node) {
        // Check for require() calls
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'require' &&
          node.arguments.length > 0 &&
          node.arguments[0].type === 'Literal' &&
          typeof node.arguments[0].value === 'string'
        ) {
          const importPath = node.arguments[0].value;
          const { isDeep, module } = checkDeepImport(importPath);
          
          if (isDeep) {
            context.report({
              node: node.arguments[0],
              messageId: 'deepImport',
              data: {
                path: importPath,
                module: module
              }
            });
          }
        }
      }
    };
  }
};
