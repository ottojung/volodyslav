"use strict";
const { RuleTester } = require("eslint");
const rule = require("../rules/no-any-type");

const tester = new RuleTester({
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
});

tester.run("no-any-type", rule, {
  valid: [
    // Regular code without JSDoc
    "const x = 1 + 2;",
    "function foo() { return 42; }",
    
    // JSDoc with proper types
    "/** @param {string} name */\nfunction greet(name) {}",
    "/** @param {number} value */\nfunction double(value) { return value * 2; }",
    "/** @returns {boolean} */\nfunction isValid() { return true; }",
    "/** @type {string} */\nconst message = 'hello';",
    "/** @type {number[]} */\nconst numbers = [1, 2, 3];",
    "/** @typedef {object} Person\n * @property {string} name\n * @property {number} age\n */",
    
    // Regular comments (not JSDoc) - these should be allowed
    "// This function can handle any input",
    "/* This is any comment */",
    "const x = 5; // any comment here",
    
    // String containing 'any'
    "const str = 'any string';",
    "const text = `any text`;",
    
    // Variable names containing 'any'
    "const anyValue = 123;",
    "function doAnyThing() {}",
    
    // Union types and other complex types
    "/** @param {string|number} value */\nfunction process(value) {}",
    "/** @param {unknown} value */\nfunction handle(value) {}",
    "/** @param {*} value - Using asterisk */\nfunction accept(value) {}",
  ],
  
  invalid: [
    // Simple any type
    {
      code: "/** @param {any} value */\nfunction process(value) {}",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any in return type
    {
      code: "/** @returns {any} */\nfunction getValue() { return null; }",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any in type annotation
    {
      code: "/** @type {any} */\nconst value = null;",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any array
    {
      code: "/** @type {any[]} */\nconst items = [];",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any in typedef
    {
      code: "/** @typedef {object} Config\n * @property {any} data\n */",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any in union type
    {
      code: "/** @param {string|any} value */\nfunction process(value) {}",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // Multiple any occurrences in same JSDoc
    {
      code: "/** @param {any} a\n * @param {any} b\n */\nfunction add(a, b) {}",
      errors: [
        { messageId: "noAnyType" },
        { messageId: "noAnyType" }
      ]
    },
    
    // Inline type cast with any
    {
      code: "const x = /** @type {any} */(value);",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any with generics
    {
      code: "/** @param {Array<any>} items */\nfunction process(items) {}",
      errors: [{ messageId: "noAnyType" }]
    },
    
    // any in Record type
    {
      code: "/** @type {Record<string, any>} */\nconst obj = {};",
      errors: [{ messageId: "noAnyType" }]
    },
  ],
});
