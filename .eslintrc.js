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
    plugins: ["@typescript-eslint"],
    extends: [
        "eslint:recommended",
        "plugin:react/recommended",
        "plugin:jest/recommended",
        "plugin:import/recommended",
        "plugin:@typescript-eslint/recommended",
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
        "@typescript-eslint/no-require-imports": "off",
        "@typescript-eslint/no-unused-vars": "off",
        "@typescript-eslint/consistent-type-assertions": [
            "error",
            { assertionStyle: "never" },
        ],

        // Ban non-null assertions (`foo!.bar`):
        "@typescript-eslint/no-non-null-assertion": "error",
    },
    ignorePatterns: ["dist/", "node_modules/", "coverage/"],
};
