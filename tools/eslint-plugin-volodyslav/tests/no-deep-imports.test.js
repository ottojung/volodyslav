"use strict";
const { RuleTester } = require("eslint");
const rule = require("../rules/no-deep-imports");

const tester = new RuleTester({
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
});

tester.run("no-deep-imports", rule, {
  valid: [
    // External packages are always allowed
    'const express = require("express");',
    'const luxon = require("luxon");',
    'const path = require("path");',
    
    // Single-level relative imports are allowed
    'const foo = require("./something");',
    'const bar = require("../another");',
    'const baz = require("../../yet_another");',
    'const qux = require("../../../module");',
    'const multi = require("../../../../single_segment");',
    
    // Edge case: no arguments
    'const x = require();',
    
    // Edge case: non-string argument
    'const y = require(someVar);',
    'const z = require(123);',
  ],
  invalid: [
    // Deep imports with ./
    {
      code: 'const x = require("./something/deep");',
      errors: [{ messageId: "deepImport" }],
    },
    {
      code: 'const y = require("./something/deep/in/the/module");',
      errors: [{ messageId: "deepImport" }],
    },
    
    // Deep imports with ../
    {
      code: 'const a = require("../another/example");',
      errors: [{ messageId: "deepImport" }],
    },
    {
      code: 'const b = require("../../some/nested/path");',
      errors: [{ messageId: "deepImport" }],
    },
    {
      code: 'const c = require("../../../../another/example");',
      errors: [{ messageId: "deepImport" }],
    },
    
    // Real examples from the codebase
    {
      code: 'const eventId = require("../../event/id");',
      errors: [{ messageId: "deepImport" }],
    },
    {
      code: 'const { fromDays } = require("../src/datetime/duration");',
      errors: [{ messageId: "deepImport" }],
    },
    {
      code: 'const structure = require("../src/runtime_state_storage/structure");',
      errors: [{ messageId: "deepImport" }],
    },
  ],
});
