/**
 * Jest Global Setup
 *
 * Fails the whole Jest run when the per-test timeout budget declared by a config
 * file disagrees with the budget the operator asked for through
 * `JEST_TEST_TIMEOUT`.
 *
 * Jest's circus runner reads the budget from `globalConfig.testTimeout` only,
 * and it ignores `projectConfig.testTimeout` (`jest-circus` seeds circus state
 * from `globalConfig.testTimeout` and no other value). In a `projects`
 * configuration the root config is what becomes `globalConfig`, so the root
 * value is the effective one; this guard fails the run when the root value and
 * the project values have drifted apart from the request, so a per-project
 * setting can never quietly become the thing operators think is in charge.
 *
 * The comparison is made against what the config files *declare*, not against
 * the `globalConfig` value Jest hands to this hook. Jest seeds its root options
 * from `argv` (`setFromArgv` in `jest-config` overwrites every option named on
 * the command line), so `--testTimeout=N` legitimately lands in
 * `globalConfig.testTimeout` and would otherwise make this hook reject a
 * supported invocation before a single test is loaded. Jest's documented
 * precedence — command line over config file — is left intact; this guard only
 * polices the declarations the repository itself ships.
 */

const { resolveTestTimeout } = require("./jest_test_timeout");
const { resolvedProjectConfigPaths, resolvedRootConfigPath } = require("./jest_projects");

/**
 * The `testTimeout` one config file declares.
 *
 * @typedef {object} DeclaredBudget
 * @property {string} configPath - The config file the declaration was read from.
 * @property {unknown} testTimeout - The declared value, or `undefined` when the key is absent.
 */

/**
 * Describe every declaration which disagrees with the requested budget.
 *
 * The properties this function carries are:
 * - The result names each declaration that is not equal to `requested`.
 * - An empty result means every given declaration equals `requested`.
 *
 * The proof of those properties is guaranteed by:
 * - This function is the only place the comparison is made, and it returns
 *   without adding a line only in the branch where a declaration equals
 *   `requested`.
 *
 * @param {number} requested - The budget the operator asked for.
 * @param {DeclaredBudget[]} declarations - One entry per config file.
 * @returns {string[]} One description per disagreeing declaration.
 */
function findBudgetOffenders(requested, declarations) {
    /** @type {string[]} */
    const offenders = [];

    for (const declaration of declarations) {
        if (declaration.testTimeout !== requested) {
            offenders.push(`${declaration.configPath} declares testTimeout ${String(declaration.testTimeout)} instead of ${String(requested)}`);
        }
    }

    return offenders;
}

/**
 * Read the budget every config file in this repository declares.
 *
 * The properties this function carries are:
 * - One entry per config file, the root config first.
 *
 * The proof of those properties is guaranteed by:
 * - `declaredBudgets` is the only reader of the config files, and it emits one
 *   entry for `resolvedRootConfigPath()` and then one entry for every path
 *   `resolvedProjectConfigPaths()` returns, without filtering or skipping any.
 *
 * @returns {DeclaredBudget[]}
 */
function declaredBudgets() {
    /** @type {DeclaredBudget[]} */
    const declarations = [];
    /** @type {string[]} */
    const configPaths = [resolvedRootConfigPath(), ...resolvedProjectConfigPaths()];

    for (const configPath of configPaths) {
        /** @type {{testTimeout?: unknown}} */
        const config = require(configPath);

        declarations.push({ configPath, testTimeout: config.testTimeout });
    }

    return declarations;
}

/**
 * Assert that every config file declares the requested per-test timeout.
 *
 * The properties this function carries are:
 * - Every config file the repository ships declares the requested budget.
 *
 * The proof of those properties is guaranteed by:
 * - This function is the only `globalSetup` entry point, and it returns without
 *   throwing only after the comparison loop over the root and project
 *   declarations has completed with an empty list of offenders.
 *
 * @returns {void}
 */
function assertBudgetIsReachable() {
    const offenders = findBudgetOffenders(resolveTestTimeout(process.env), declaredBudgets());

    if (offenders.length > 0) {
        throw new Error(
            "The per-test timeout budget is not reachable:\n" +
                offenders.map((line) => `  - ${line}`).join("\n") +
                "\nThe root config and every project config must set testTimeout to resolveTestTimeout(process.env) " +
                "from jest_test_timeout.js. Only the root value reaches Jest's circus runner, so the project " +
                "values must not be left to disagree with it."
        );
    }
}

module.exports = async function globalSetup() {
    assertBudgetIsReachable();
};

module.exports["assertBudgetIsReachable"] = assertBudgetIsReachable;
module.exports["findBudgetOffenders"] = findBudgetOffenders;
