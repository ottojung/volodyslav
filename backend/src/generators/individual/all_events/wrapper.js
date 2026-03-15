const { transaction } = require("../../../event_log_storage");
const { serialize } = require("../../../event");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(capabilities) {
    return async (_inputs, _oldValue, _bindings) => {
        const events = await transaction(capabilities, async (storage) => {
            return await storage.getExistingEntries();
        });
        return { type: "all_events", events: events.map((e) => serialize(capabilities, e)) };
    };
}

module.exports = {
    makeComputor,
};
