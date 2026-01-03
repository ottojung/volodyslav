"use strict";

const { RuleTester } = require("eslint");
const rule = require("../rules/no-type-casts");

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tester.run("no-type-casts", rule, {
  valid: [
    // Normal variable declarations
    "const x = 1 + 2;",
    "const name = 'hello';",
    
    // JSDoc type annotations on class properties (not casts)
    "class Foo { /** @type {string} */ id; }",
    
    // JSDoc type annotations on variables without casts
    "/** @type {string[]} */ const arr = [];",
    
    // Function parameter type annotations (not casts)
    "function foo(/** @type {string} */ text) { return text; }",
    
    // Catch clause type annotations (not casts)
    "try {} catch (/** @type {unknown} */ error) {}",
    
    // Type guards (correct pattern)
    "if (isSomeType(obj)) { const x = obj; }",
    
    // Regular function calls with no type cast
    "doSomething(getValue())",
    
    // Arrays without type casts
    "const arr = [1, 2, 3];",
  ],
  invalid: [
    {
      code: "const x = /** @type {number} */ (123);",
      errors: [{ messageId: "noTypeCast" }],
    },
    {
      code: "const obj = /** @type {SomeType} */ (unknownObject);",
      errors: [{ messageId: "noTypeCast" }],
    },
    {
      code: "const result = /** @type {string} */ ('hello');",
      errors: [{ messageId: "noTypeCast" }],
    },
    {
      code: "function test() { return /** @type {any} */ (value); }",
      errors: [{ messageId: "noTypeCast" }],
    },
    {
      code: "const arr = [/** @type {number} */ (123)];",
      errors: [{ messageId: "noTypeCast" }],
    },
    {
      code: "let x; x = /** @type {boolean} */ (true);",
      errors: [{ messageId: "noTypeCast" }],
    },
    {
      code: "doSomething(/** @type {string} */ (value));",
      errors: [{ messageId: "noTypeCast" }],
    },
    // Double type cast (nested) - should report the inner one
    {
      code: "const val = /** @type {DatabaseValue} */ (/** @type {unknown} */ ({ inputs }));",
      errors: [{ messageId: "noTypeCast" }],
    },
  ],
});
