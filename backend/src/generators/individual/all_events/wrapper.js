const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} _capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(_capabilities) {
    return async (_inputs, oldValue, _bindings) => {
        if (oldValue !== undefined) {
            return makeUnchanged();
        }
        return { type: "all_events", events: [] };
    };
}

module.exports = {
    makeComputor,
};
