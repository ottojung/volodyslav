"use strict";
const { RuleTester } = require("eslint");
const rule = require("../rules/no-date-class");

const tester = new RuleTester({
  parserOptions: { ecmaVersion: "latest", sourceType: "module" },
});

tester.run("no-date-class", rule, {
  valid: [
    "const x = 1 + 2;",
    "const DateTime = require('luxon').DateTime;",
    "const dt = DateTime.now();",
    "import { DateTime } from 'luxon';",
    "const myDate = 'some string';",
  ],
  invalid: [
    { code: "const date = new Date();", errors: [{ messageId: "unexpected" }] },
    { code: "const date = new Date('2023-01-01');", errors: [{ messageId: "unexpected" }] },
    { code: "const timestamp = Date.now();", errors: [{ messageId: "unexpected" }] },
    { code: "const parsed = Date.parse('2023-01-01');", errors: [{ messageId: "unexpected" }] },
    { code: "const date = Date();", errors: [{ messageId: "unexpected" }] },
    { code: "const utc = Date.UTC(2023, 0, 1);", errors: [{ messageId: "unexpected" }] },
  ],
});
