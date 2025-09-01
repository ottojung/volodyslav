"use strict";

const { RuleTester } = require("eslint");
const rule = require("../rules/unique-symbol-top-level-only");

const ruleTester = new RuleTester({ 
  parserOptions: { ecmaVersion: 2018, sourceType: "module" } 
});

ruleTester.run("unique-symbol-top-level-only", rule, {
  valid: [
    // Top-level creation is allowed - each test as separate case
    {
      code: 'const uniqueSymbol = require("./unique_symbol"); const symbol = uniqueSymbol.makeRandom(capabilities);'
    },
    {
      code: 'const uniqueSymbol = require("./unique_symbol"); const symbol = uniqueSymbol.fromString("test");'
    },
    {
      code: 'const symbol = require("./unique_symbol").makeRandom(capabilities);'
    },
    {
      code: 'const symbol = require("./unique_symbol").fromString("test");'
    },
    
    // Other function calls should not be affected
    {
      code: 'function test() { const result = someOtherModule.makeRandom(); }'
    },
    {
      code: 'function test() { const result = obj.fromString("test"); }'
    },
    {
      code: 'function test() { const result = require("other-module").someMethod(); }'
    },
  ],
  
  invalid: [
    // Inside function declaration
    {
      code: 'const uniqueSymbol = require("./unique_symbol"); function test() { const symbol = uniqueSymbol.makeRandom(capabilities); }',
      errors: [{ messageId: "notInFunction" }]
    },
    {
      code: 'const uniqueSymbol = require("./unique_symbol"); function test() { const symbol = uniqueSymbol.fromString("test"); }',
      errors: [{ messageId: "notInFunction" }]
    },
    
    // Direct require inside function
    {
      code: 'function test() { const symbol = require("./unique_symbol").makeRandom(capabilities); }',
      errors: [{ messageId: "notInFunction" }]
    },
    {
      code: 'function test() { const symbol = require("./unique_symbol").fromString("test"); }',
      errors: [{ messageId: "notInFunction" }]
    },
  ]
});