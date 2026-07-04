/**
 * ESLint configuration for the project (flat config).
 */
import globals from "globals";
import tsParser from "@typescript-eslint/parser";
import tsPlugin from "@typescript-eslint/eslint-plugin";
import js from "@eslint/js";
import importX from "eslint-plugin-import-x";
import jestPlugin from "eslint-plugin-jest";
import reactHooks from "eslint-plugin-react-hooks";
import eslintReact from "@eslint-react/eslint-plugin";
import volodyslavPlugin from "eslint-plugin-volodyslav";

/** @type {import('eslint').Linter.Config[]} */
export default [
  // Ignore patterns
  {
    ignores: ["**/dist/**", "**/node_modules/**", "**/coverage/**", "docs/build/**", "**/*.d.ts"],
  },

  // ESLint recommended
  js.configs.recommended,

  // TypeScript recommended
  ...tsPlugin.configs["flat/recommended"],

  // Volodyslav recommended
  {
    ...volodyslavPlugin.configs.recommended,
  },

  // Import plugin configs (before local rule block so local overrides take precedence)
  importX.flatConfigs.recommended,
  importX.flatConfigs.typescript,

  // Base project config
  {
    name: "volodyslav/base",
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
        ...globals.es2021,
        ...globals.jest,
      },
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
      },
    },
    settings: {
      react: { version: "detect" },
      "import-x/resolver": {
        node: {
          extensions: [".js", ".jsx", ".ts", ".tsx"],
        },
      },
      "import-x/ignore": [
        "^virtual:",
      ],
    },
    plugins: {
      "@typescript-eslint": tsPlugin,
      "import-x": importX,
      volodyslav: volodyslavPlugin,
    },
    rules: {
      "no-unused-vars": [
        "error",
        {
          vars: "all",
          args: "after-used",
          argsIgnorePattern: "^_",
          caughtErrors: "none",
        },
      ],
      "no-useless-assignment": "off",
      "preserve-caught-error": "off",
      "@typescript-eslint/no-require-imports": "off",
      "@typescript-eslint/no-unused-vars": "off",
      "import-x/no-named-as-default-member": "off",
      "import-x/no-unresolved": [
        "error",
        {
          ignore: ["^virtual:"],
        },
      ],
      "no-warning-comments": [
        "error",
        {
          terms: [
            "eslint-disable",
            "eslint-disable-next-line",
            "eslint-disable-line",
            "eslint-enable",
          ],
          location: "anywhere",
        },
      ],
      "volodyslav/no-deep-imports": [
        "error",
        {
          ignorePatterns: ["**/tests/**", "**/test/**", "scripts/**"],
        },
      ],
      "volodyslav/no-non-toplevel-imports": [
        "error",
        {
          ignorePatterns: [
            "**/tests/**", "**/test/**", "scripts/**",
            "**/scheduler/expression/structure.js",
            "**/generators/incremental_graph/database/node_key.js",
            "**/generators/incremental_graph/database/gitstore.js",
          ],
        },
      ],
    },
  },

  // Source files with TypeScript parser and project config
  {
    name: "volodyslav/source",
    files: ["frontend/src/**/*.js", "frontend/src/**/*.jsx", "backend/src/**/*.js"],
    ignores: ["frontend/src/sw.js"],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: "latest",
        sourceType: "module",
        ecmaFeatures: { jsx: true },
        project: "./tsconfig.json",
      },
      globals: {
        __BASE_PATH__: "readonly",
      },
    },
    rules: {
      "import-x/no-cycle": ["error", { maxDepth: "∞" }],
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "never" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
    },
  },

  // Jest plugin (only for test files)
  {
    files: ["**/*.test.js", "**/*.test.jsx", "**/*.spec.js", "**/*.spec.jsx", "**/tests/**"],
    ...jestPlugin.configs["flat/recommended"],
  },

  // Test files override
  {
    name: "volodyslav/tests",
    files: ["**/*.test.js", "**/*.test.jsx", "**/*.spec.js", "**/*.spec.jsx", "**/tests/**"],
    rules: {
      "volodyslav/max-lines-per-file": "off",
    },
  },

  // React plugin (minimal recommended rules, suppress opinionated suggestions)
  eslintReact.configs["recommended-typescript"],
  eslintReact.configs["disable-experimental"],
  eslintReact.configs["disable-naming-convention"],
  {
    rules: {
      "@eslint-react/preserve-caught-error": "off",
      "@eslint-react/use-state": "off",
      "@eslint-react/no-array-index-key": "off",
      "@eslint-react/no-forward-ref": "off",
      "@eslint-react/set-state-in-effect": "off",
      "@eslint-react/no-use-context": "off",
      "@eslint-react/no-context-provider": "off",
      "@eslint-react/no-unnecessary-use-prefix": "off",
      "@eslint-react/dom-no-dangerously-set-innerhtml": "off",
      "@eslint-react/exhaustive-deps": "off",
      "@eslint-react/refs": "off",
    },
  },

  // Suppress import-x warnings on the eslint config file itself
  {
    files: ["eslint.config.mjs"],
    rules: {
      "import-x/no-named-as-default": "off",
      "import-x/no-named-as-default-member": "off",
    },
  },

  // React hooks plugin
  {
    plugins: {
      "react-hooks": reactHooks,
    },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "off",
    },
  },
];
