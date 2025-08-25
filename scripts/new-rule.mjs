#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const ruleId = process.argv[2];
if (!ruleId) {
  console.error("Usage: scripts/new-rule.mjs <rule-id-kebab>");
  process.exit(1);
}

const rulesDir = path.join(__dirname, "..", "tools", "eslint-plugin-volodyslav", "rules");
const testsDir = path.join(__dirname, "..", "tools", "eslint-plugin-volodyslav", "tests");

fs.mkdirSync(rulesDir, { recursive: true });
fs.mkdirSync(testsDir, { recursive: true });

const rulePath = path.join(rulesDir, `${ruleId}.js`);
const testPath = path.join(testsDir, `${ruleId}.test.js`);

const ruleTemplate = `\
"use strict";

module.exports = {
  meta: {
    type: "problem",
    docs: { description: "${ruleId.replace(/-/g, " ")}" },
    schema: [],
    messages: { unexpected: "${ruleId}" }
  },
  create(context) {
    return {
      // TODO: implement
      Program() { /* no-op */ }
    };
  }
};
`;

const testTemplate = `\
"use strict";
const { RuleTester } = require("eslint");
const rule = require("../rules/${ruleId}");

const tester = new RuleTester({
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
});

tester.run("${ruleId}", rule, {
  valid: [],
  invalid: [
    // { code: "", errors: [{ messageId: "unexpected" }] },
  ],
});
`;

if (fs.existsSync(rulePath)) {
  console.error("Rule already exists:", rulePath);
  process.exit(1);
}

fs.writeFileSync(rulePath, ruleTemplate);
fs.writeFileSync(testPath, testTemplate);

console.log("Created:");
console.log(" ", rulePath);
console.log(" ", testPath);
console.log();
console.log("Run tests with: npm run rules:test");