"use strict";

const { RuleTester } = require("eslint");
const rule = require("../rules/no-eval-anywhere");

const tester = new RuleTester({
  parserOptions: {
    ecmaVersion: "latest",
    sourceType: "module",
  },
});

tester.run("no-eval-anywhere", rule, {
  valid: [
    "const x = 1 + 2;",
    "const evalFunc = (x) => x; evalFunc('not real js');",
    "const o = { eval: 1 }; o.eval; // property access without call",
  ],
  invalid: [
    { code: "eval('2+2');", errors: [{ messageId: "unexpected" }] },
    { code: "window.eval('2+2');", errors: [{ messageId: "unexpected" }] },
    { code: "globalThis.eval('2+2');", errors: [{ messageId: "unexpected" }] },
    { code: "window['eval']('2+2');", errors: [{ messageId: "unexpected" }] },
    { code: "globalThis['eval']('2+2');", errors: [{ messageId: "unexpected" }] },
  ],
});