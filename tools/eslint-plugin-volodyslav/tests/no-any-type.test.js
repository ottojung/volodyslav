"use strict";

const path = require("path");
const fs = require("fs");
const { ESLint } = require("eslint");

const testDir = __dirname;
const rule = require("../rules/no-any-type");

// Create a simple tsconfig for the test
const tsConfigPath = path.join(testDir, "tsconfig.test.json");
const tsConfig = {
  compilerOptions: {
    allowJs: true,
    checkJs: true,
    noEmit: true,
    target: "ES2019",
    lib: ["ES2019"],
    moduleResolution: "node"
  },
  include: [
    "temp-valid.js",
    "temp-invalid.js"
  ]
};

fs.writeFileSync(tsConfigPath, JSON.stringify(tsConfig, null, 2));

// Test helper
async function testRule(filename, code, shouldFail) {
  const testFile = path.join(testDir, filename);
  
  try {
    // Write test file
    fs.writeFileSync(testFile, code);
    
    // Configure ESLint with inline plugin
    const eslint = new ESLint({
      useEslintrc: false,
      baseConfig: {
        parser: "@typescript-eslint/parser",
        parserOptions: {
          ecmaVersion: "latest",
          sourceType: "module",
          tsconfigRootDir: testDir,
          project: "./tsconfig.test.json",
        },
        plugins: ["test-plugin"],
        rules: {
          "test-plugin/no-any-type": "error",
        },
      },
      plugins: {
        "test-plugin": {
          rules: {
            "no-any-type": rule,
          },
        },
      },
    });
    
    // Run ESLint
    const results = await eslint.lintFiles([testFile]);
    const hasErrors = results[0].errorCount > 0;
    
    if (shouldFail && !hasErrors) {
      throw new Error(`Expected code to fail but it passed: ${code}`);
    }
    
    if (!shouldFail && hasErrors) {
      const messages = results[0].messages.map(m => m.message).join(", ");
      throw new Error(`Expected code to pass but it failed: ${code}\nErrors: ${messages}`);
    }
    
    return true;
  } finally {
    // Clean up
    if (fs.existsSync(testFile)) {
      fs.unlinkSync(testFile);
    }
  }
}

async function runTests() {
  console.log("Running no-any-type tests...");
  
  // Valid cases - no 'any' type
  await testRule("temp-valid.js", "const x = 1 + 2;", false);
  await testRule("temp-valid.js", "const y = 'hello';", false);
  await testRule("temp-valid.js", "function foo(x) { return x; }", false);
  await testRule("temp-valid.js", "/** @typedef {number} MyNumber */", false);
  await testRule("temp-valid.js", "/** @param {string} x */ function bar(x) { return x; }", false);
  await testRule("temp-valid.js", "/** @type {string} */ const s = 'hello';", false);
  await testRule("temp-valid.js", "/** @type {number[]} */ const nums = [1, 2, 3];", false);
  await testRule("temp-valid.js", "/** @type {Map<string, number>} */ const map = new Map();", false);
  await testRule("temp-valid.js", "/** @param {object} obj */ function process(obj) {}", false);
  await testRule("temp-valid.js", "/** @returns {string} */ function getString() { return 'hi'; }", false);
  
  console.log("✓ Valid cases passed");
  
  // Invalid cases - using 'any' type
  await testRule("temp-invalid.js", "/** @type {any} */ const x = 1;", true);
  await testRule("temp-invalid.js", "/** @param {any} x */ function foo(x) {}", true);
  await testRule("temp-invalid.js", "/** @returns {any} */ function bar() { return 1; }", true);
  await testRule("temp-invalid.js", "/** @type {any[]} */ const arr = [];", true);
  await testRule("temp-invalid.js", "/** @type {Map<string, any>} */ const m = new Map();", true);
  await testRule("temp-invalid.js", "/** @type {Promise<any>} */ const p = Promise.resolve();", true);
  await testRule("temp-invalid.js", "/** @type {string | any} */ const val = 'hi';", true);
  await testRule("temp-invalid.js", "/** @type {[string, any]} */ const tuple = ['a', 1];", true);
  await testRule("temp-invalid.js", "/** @param {any} a @param {any} b */ function fn(a, b) {}", true);
  
  console.log("✓ Invalid cases passed");
  
  // Edge cases - should not flag regular comments
  await testRule("temp-valid.js", "// This is any comment", false);
  await testRule("temp-valid.js", "/* This has the word any in it */", false);
  await testRule("temp-valid.js", "// @type any - not JSDoc", false);
  
  console.log("✓ Edge cases passed");
  
  console.log("All no-any-type tests passed!");
  
  // Clean up tsconfig
  if (fs.existsSync(tsConfigPath)) {
    fs.unlinkSync(tsConfigPath);
  }
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
