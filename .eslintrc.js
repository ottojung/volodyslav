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
        "import/resolver": {
            "node": {
                "extensions": [".js", ".jsx", ".ts", ".tsx"]
            }
        },
        "import/ignore": [
            "virtual:"
        ]
    },
    plugins: ["@typescript-eslint", "volodyslav"],
    extends: [
        "eslint:recommended",
        "plugin:react/recommended",
        "plugin:jest/recommended",
        "plugin:import/recommended",
        "plugin:@typescript-eslint/recommended",
        "plugin:volodyslav/recommended",
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

        // Disable prop-types validation since we use TypeScript
        "react/prop-types": "off",

        // Ban directive comments that silence ESLint warnings
        "no-warning-comments": [
            "error",
            {
                "terms": [
                    "eslint-disable",
                    "eslint-disable-next-line",
                    "eslint-disable-line",
                    "eslint-enable"
                ],
                "location": "anywhere"
            }
        ],

        // Allow virtual imports from Vite plugins
        "import/no-unresolved": [
            "error",
            {
                "ignore": ["^virtual:"]
            }
        ],

        // No deep imports rule with test files ignored
        "volodyslav/no-deep-imports": [
            "error",
            {
                "ignorePatterns": ["**/tests/**", "**/test/**"]
            }
        ],
    },
    overrides: [
        {
            files: ["frontend/src/**/*.js", "frontend/src/**/*.jsx", "backend/src/**/*.js"],
            excludedFiles: ["frontend/src/sw.js"],
            parser: "@typescript-eslint/parser",
            parserOptions: {
                ecmaVersion: "latest",
                sourceType: "module",
                ecmaFeatures: { jsx: true },
                project: "./tsconfig.json",
            },
        },
    ],
    ignorePatterns: ["dist/", "node_modules/", "coverage/", "docs/build/", "tools/eslint-plugin-volodyslav"],
};
