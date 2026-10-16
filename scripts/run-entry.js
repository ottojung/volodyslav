/**
 * The shipped deployment wrapper around the backend entry point.
 *
 * `database-lifecycle.md` §4 and `incremental-graph-journal-migrations.md` §4
 * carry the installation-recovery and canonical-bootstrap sources as deployment
 * configuration, so the deployment supplies them and the backend entry point
 * forwards them to the root capabilities. This wrapper is where a deployment
 * names the module which builds those sources; without the naming environment
 * variable the deployment configures none and the backend keeps its fail-closed
 * default.
 *
 * The module named by `VOLODYSLAV_DEPLOYMENT_SOURCES` exports a
 * `makeDeploymentSources()` function returning an object with optional
 * `cohortBootstrapSource` and `installationRecoverySource` members, which are
 * passed through unchanged to `entry()` and validated there by the root
 * capabilities. Loading the deployment's own module is the deployment's choice,
 * so it stays outside the backend's import boundary.
 */

const path = require("path");

const { entry } = require("../backend/src/index.js");

/** @typedef {import("../backend/src/capabilities/root").RootCapabilityOptions} RootCapabilityOptions */

/**
 * The module the deployment names, or `undefined` when it configures none.
 *
 * @returns {string | undefined}
 */
function deploymentSourcesModulePath() {
    const value = process.env.VOLODYSLAV_DEPLOYMENT_SOURCES;
    if (value === undefined || value === "") {
        return undefined;
    }
    return value;
}

/**
 * Load the deployment's source configuration.
 *
 * @returns {RootCapabilityOptions}
 */
function makeDeploymentSources() {
    const modulePath = deploymentSourcesModulePath();
    if (modulePath === undefined) {
        return {};
    }
    const loaded = require(path.resolve(modulePath));
    if (loaded === null || typeof loaded !== "object" || typeof loaded.makeDeploymentSources !== "function") {
        throw new Error(
            "the deployment sources module named by VOLODYSLAV_DEPLOYMENT_SOURCES must export a makeDeploymentSources function"
        );
    }
    const sources = loaded.makeDeploymentSources();
    if (sources === null || typeof sources !== "object") {
        throw new Error("the deployment sources module returned a configuration which is not an object");
    }
    return {
        cohortBootstrapSource: sources.cohortBootstrapSource,
        installationRecoverySource: sources.installationRecoverySource,
    };
}

function main() {
    entry(makeDeploymentSources());
}

if (require.main === module) {
    main();
}

module.exports = {
    makeDeploymentSources,
};
