/**
 * Jest Global Setup
 *
 * Fails the whole Jest run when the per-test timeout budget the operator asked
 * for is not the budget Jest will actually apply.
 *
 * Jest's circus runner reads the budget from `globalConfig.testTimeout` only,
 * and it ignores `projectConfig.testTimeout`. The root config is what becomes
 * `globalConfig`, so the root value is the effective one; this guard fails the
 * run when the root value and the project values have drifted apart, so a
 * per-project setting can never quietly become the thing operators think is in
 * charge.
 */

const { resolveTestTimeout } = require("./jest_test_timeout");
const { resolvedProjectConfigPaths } = require("./jest_projects");

/**
 * Assert that the effective per-test timeout equals the requested one.
 *
 * The properties this function carries are:
 * - Jest's `globalConfig.testTimeout` equals the requested budget.
 * - Every project config declares the same budget as the root config.
 *
 * The proof of those properties is guaranteed by:
 * - This function is the only `globalSetup` entry point, and it returns without
 *   throwing only after the comparison loop over the root and project values has
 *   completed with an empty list of offenders.
 *
 * @param {object} globalConfig - The `globalConfig` Jest hands to `globalSetup`.
 * @param {unknown} _projectConfig - The project config for this hook's project.
 * @returns {void}
 */
function assertBudgetIsReachable(globalConfig, _projectConfig) {
    const requested = resolveTestTimeout(process.env);
    /** @type {string[]} */
    const offenders = [];

    const effective = globalConfig["testTimeout"];

    if (effective !== requested) {
        offenders.push(`root config applies testTimeout ${String(effective)}, but ${String(requested)} was requested`);
    }

    for (const configPath of resolvedProjectConfigPaths()) {
        /** @type {{testTimeout?: unknown}} */
        const config = require(configPath);

        if (config.testTimeout !== requested) {
            offenders.push(`${configPath} declares testTimeout ${String(config.testTimeout)} instead of ${String(requested)}`);
        }
    }

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

module.exports = async function globalSetup(globalConfig, projectConfig) {
    assertBudgetIsReachable(globalConfig, projectConfig);
};