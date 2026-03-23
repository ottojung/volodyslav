"use strict";

const { RuleTester } = require("eslint");
const rule = require("../rules/max-lines-per-file");

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

/**
 * Generates a JavaScript code string with the given number of unique code lines.
 * Each line declares a uniquely named variable so every line is a code token line.
 * @param {number} count
 * @returns {string}
 */
function makeCodeLines(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(`const _v${i} = ${i};`);
  }
  return lines.join("\n");
}

/**
 * Generates a block of comment-only lines.
 * @param {number} count
 * @returns {string}
 */
function makeCommentLines(count) {
  const lines = [];
  for (let i = 0; i < count; i++) {
    lines.push(`// comment line ${i}`);
  }
  return lines.join("\n");
}

tester.run("max-lines-per-file", rule, {
  valid: [
    // Exactly at the limit: 300 code lines → should pass
    { code: makeCodeLines(300) },

    // Under the limit
    { code: makeCodeLines(1) },
    { code: makeCodeLines(299) },

    // 400 lines of comments → should pass (comments are not counted)
    { code: makeCommentLines(400) },

    // 200 code lines + 200 comment lines → 200 code lines, should pass
    {
      code: makeCodeLines(200) + "\n" + makeCommentLines(200),
    },

    // 300 code lines + 500 comment lines → 300 code lines, exactly at limit, should pass
    {
      code: makeCodeLines(300) + "\n" + makeCommentLines(500),
    },
  ],

  invalid: [
    // 301 code lines → should fail
    {
      code: makeCodeLines(301),
      errors: [{ messageId: "tooManyLines" }],
    },

    // 400 code lines → should fail
    {
      code: makeCodeLines(400),
      errors: [{ messageId: "tooManyLines" }],
    },

    // 301 code lines + 1000 comment lines → still 301 code lines, should fail
    {
      code: makeCodeLines(301) + "\n" + makeCommentLines(1000),
      errors: [{ messageId: "tooManyLines" }],
    },
  ],
});

console.log("All max-lines-per-file tests passed!");
