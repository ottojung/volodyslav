"use strict";

const { RuleTester } = require("eslint");
const rule = require("../rules/no-date-class");

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tester.run("no-date-class", rule, {
  valid: [
    "const x = 1 + 2;",
    "const DateTime = require('luxon').DateTime;",
    "const now = DateTime.now();",
    "const dt = DateTime.fromMillis(123456);",
    "const iso = DateTime.fromISO('2023-01-01');",
    "const dateString = 'Date'; // just a string",
    "const obj = { Date: 123 }; obj.Date; // property access",
  ],
  invalid: [
    { code: "new Date();", errors: [{ messageId: "noDateConstructor" }] },
    { code: "new Date(2023, 0, 1);", errors: [{ messageId: "noDateConstructor" }] },
    { code: "new Date('2023-01-01');", errors: [{ messageId: "noDateConstructor" }] },
    { code: "Date.now();", errors: [{ messageId: "noDateStatic" }] },
    { code: "Date.parse('2023-01-01');", errors: [{ messageId: "noDateStatic" }] },
    { code: "Date.UTC(2023, 0, 1);", errors: [{ messageId: "noDateStatic" }] },
  ],
});