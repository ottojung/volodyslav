/**
 * ESLint configuration for the project.
 */
module.exports = {
    root: true,
    env: {
        browser: true,
        node: true,
        es2021: true,
        jest: true,
    },
    parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
    },
    settings: {
        react: { version: "detect" },
    },
    extends: [
        "eslint:recommended",
        "plugin:react/recommended",
        "plugin:jest/recommended",
        "plugin:import/recommended",
    ],
    rules: {
        "no-unused-vars": [
            "error",
            {
                vars: "all",
                args: "after-used",
                argsIgnorePattern: "^_",
            },
        ],
        "import/no-cycle": ["error", { maxDepth: "∞" }],
    },
    ignorePatterns: ["dist/", "node_modules/", "coverage/"],
};
