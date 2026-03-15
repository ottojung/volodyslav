const { transaction } = require("../../../event_log_storage");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (_inputs, _oldValue, _bindings) => {
        const config = await transaction(capabilities, async (storage) => {
            return await storage.getExistingConfig();
        });
        return { type: "config", config };
    };
}

module.exports = {
    makeComputor,
};
