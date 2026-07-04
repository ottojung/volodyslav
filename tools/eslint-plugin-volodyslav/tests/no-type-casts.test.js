"use strict";

const path = require("path");
const fs = require("fs");
const { ESLint } = require("eslint");

const testDir = __dirname;
const rule = require("../rules/no-type-casts");

// Test helper
async function testRule(filename, code, shouldFail) {
  const testFile = path.join(testDir, filename);

  try {
    // Write test file
    fs.writeFileSync(testFile, code);

    // Create a tsconfig for this specific file
    const tsConfigPath = path.join(testDir, "tsconfig.test.json");
    const tsConfig = {
      compilerOptions: {
        allowJs: true,
        checkJs: true,
        noEmit: true,
        target: "ES2019",
        lib: ["ES2019"],
        moduleResolution: "node",
      },
      include: [filename],
    };
    fs.writeFileSync(tsConfigPath, JSON.stringify(tsConfig, null, 2));

    // Configure ESLint with inline plugin
    const eslint = new ESLint({
      ignore: false,
      overrideConfigFile: true,
      overrideConfig: [
        {
          languageOptions: {
            parser: require("@typescript-eslint/parser"),
            parserOptions: {
              ecmaVersion: "latest",
              sourceType: "module",
              tsconfigRootDir: testDir,
              project: "./tsconfig.test.json",
            },
          },
          plugins: {
            "test-plugin": {
              rules: {
                "no-type-casts": rule,
              },
            },
          },
          rules: {
            "test-plugin/no-type-casts": "error",
          },
        },
      ],
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
    const tsConfigPath = path.join(testDir, "tsconfig.test.json");
    if (fs.existsSync(tsConfigPath)) {
      fs.unlinkSync(tsConfigPath);
    }
  }
}

async function runTests() {
  console.log("Running no-type-casts tests...");

  // Valid cases
  await testRule("temp-valid.js", "const x = 1 + 2;", false);
  await testRule("temp-valid.js", "const y = 'hello';", false);
  await testRule("temp-valid.js", "function foo(x) { return x; }", false);
  await testRule("temp-valid.js", "/** @typedef {number} MyNumber */", false);
  await testRule("temp-valid.js", "/** @param {string} x */ function bar(x) { return x; }", false);

  console.log("\u2713 Valid cases passed");

  // Invalid cases
  await testRule("temp-invalid.js", "const x = /** @type {number} */ ('hello');", true);
  await testRule("temp-invalid.js", "const y = /** @type {string} */ (123);", true);
  await testRule("temp-invalid.js", "const z = ('hello' as number);", true);
  await testRule("temp-invalid.js", "const w = (<number>'hello');", true);
  await testRule("temp-invalid.js", "const obj = { x: 1 }; obj.x!;", true);

  console.log("\u2713 Invalid cases passed");
  console.log("All no-type-casts tests passed!");
}

runTests().catch(err => {
  console.error("Test failed:", err);
  process.exit(1);
});
