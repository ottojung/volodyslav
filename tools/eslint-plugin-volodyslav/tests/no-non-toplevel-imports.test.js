"use strict";
const { RuleTester } = require("eslint");
const rule = require("../rules/no-non-toplevel-imports");

const tester = new RuleTester({
    languageOptions: { ecmaVersion: "latest", sourceType: "module" },
});

tester.run("no-non-toplevel-imports", rule, {
    valid: [
        // Top-level require() calls
        'const fs = require("fs");',
        'const { readFile } = require("fs");',
        'const x = require("./foo");',
        'module.exports = require("./bar");',
        'require("./side-effect");',
        'const x = require("./foo").bar;',

        // Top-level dynamic import()
        'const x = await import("fs");',
        'const x = await import("./foo");',

        // Non-string require arguments (dynamic expressions) are ignored
        'const x = require(someVar);',
        'const y = require(123);',
        'const z = require(`template`);',
        'const w = require("./" + name);',

        // No arguments
        "const x = require();",

        // Non-require calls are fine anywhere
        "function foo() { console.log(\"hi\"); }",
        "if (true) { console.log(\"hi\"); }",
        "const x = [1, 2, 3].map(v => v * 2);",

        // Global require reference (not a call) is ignored
        "const x = require;",

        // Non-toplevel require is allowed when file matches ignorePatterns
        {
            code: 'function foo() { const x = require("fs"); }',
            filename: "/path/to/lazy/module.js",
            options: [{ ignorePatterns: ["**/lazy/**"] }],
        },
    ],

    invalid: [
        // require() inside a function
        {
            code: 'function foo() { const x = require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'const foo = function() { const x = require("fs"); };',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'const foo = () => { const x = require("fs"); };',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'const foo = () => require("fs");',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() inside an if statement
        {
            code: 'if (condition) { const x = require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'if (condition) { require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() inside a for loop
        {
            code: 'for (;;) { const x = require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'for (const x of ys) { require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() inside a while loop
        {
            code: 'while (true) { require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() inside a try/catch
        {
            code: 'try { require("fs"); } catch (e) {}',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() inside a switch case
        {
            code: 'switch (x) { case 1: require("fs"); break; }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() inside a ternary
        {
            code: 'const x = condition ? require("fs") : null;',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'const x = condition ? null : require("fs");',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // require() deeply nested in functions
        {
            code: 'function outer() { function inner() { require("fs"); } }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },
        {
            code: 'const outer = () => { const inner = () => { require("fs"); }; };',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // async function
        {
            code: 'async function foo() { const x = require("fs"); }',
            errors: [{ messageId: "nonToplevelRequire" }],
        },

        // Dynamic import() inside a function
        {
            code: 'async function foo() { const x = await import("fs"); }',
            errors: [{ messageId: "nonToplevelDynamicImport" }],
        },

        // Dynamic import() inside an if
        {
            code: 'if (condition) { const x = await import("fs"); }',
            errors: [{ messageId: "nonToplevelDynamicImport" }],
        },
    ],
});
