# Linting Methodology

This repository uses a custom internal ESLint plugin system that allows for easy addition of project-specific linting rules.

## Architecture

The custom plugin lives at `tools/eslint-plugin-volodyslav/` and features:

- **Auto-discovery**: New rules are automatically loaded without requiring ESLint configuration changes
- **Minimal boilerplate**: Rule scaffolding, tests, and aggregation are automated
- **Zero-config**: The plugin is linked into npm and loaded via ESLint configuration

## How to Add a New Rule

1. **Create the rule**: `npm run rules:new my-rule-name`
2. **Edit the rule**: Modify `tools/eslint-plugin-volodyslav/rules/my-rule-name.js`
3. **Test the rule**: `npm run rules:test`

That's it! The rule is automatically enabled via the plugin's `recommended` configuration.

## Example: Adding a "no-console" Rule

```bash
npm run rules:new no-console-logs
```

This creates:
- `tools/eslint-plugin-volodyslav/rules/no-console-logs.js`
- `tools/eslint-plugin-volodyslav/tests/no-console-logs.test.js`

Edit the rule implementation, run tests, and the rule will be enforced across the entire codebase.

## Available Scripts

- `npm run rules:test` - Run all custom rule tests
- `npm run rules:new <name>` - Generate a new rule with boilerplate
- `npm run static-analysis` - Run the full linting pipeline (includes custom rules)

## Technical Details

The plugin structure follows ESLint plugin conventions:

```
tools/eslint-plugin-volodyslav/
├── index.js                     # Plugin entry that auto-loads rules
├── package.json                 # Plugin metadata  
├── rules/
│   └── no-eval-anywhere.js      # Example rule implementation
└── tests/
    └── no-eval-anywhere.test.js # Rule tests
```

Rules are auto-discovered by reading the `rules/` directory and building a `recommended` configuration that enables all rules as errors.\
