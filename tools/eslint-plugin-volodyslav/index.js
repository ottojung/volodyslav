"use strict";

const fs = require("node:fs");
const path = require("node:path");

const rulesDir = path.join(__dirname, "rules");
const rules = {};

for (const file of fs.readdirSync(rulesDir)) {
  if (!file.endsWith(".js")) continue;
  const id = path.basename(file, ".js");
  // Each rule module must export { meta, create }
  // eslint-disable-next-line global-require, import/no-dynamic-require
  rules[id] = require(path.join(rulesDir, file));
}

// Build "recommended" automatically: enable every rule as "error".
const recommendedRules = Object.fromEntries(
  Object.keys(rules).map((id) => [`volodyslav/${id}`, "error"])
);

module.exports = {
  rules,
  // Classic (extends-based) and flat-config friendly:
  // Consumers can `extends: ["plugin:volodyslav/recommended"]` (legacy)
  // or import this plugin and spread the rules mapping in flat config.
  configs: {
    recommended: { rules: recommendedRules },
  },
};