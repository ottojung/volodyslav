const localConfig = require("../../../local_config");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (_inputs, _oldValue, _bindings) => {
        const config = await localConfig.readConfig(capabilities);
        return { type: "config", config };
    };
}

module.exports = {
    makeComputor,
};
