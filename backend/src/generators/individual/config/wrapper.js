const { serialize } = require("../../../config");
const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 * @typedef {object} ConfigBox
 * @property {import('../../../config/structure').Config | null} value
 */

/**
 * @returns {ConfigBox}
 */
function makeBox() {
    return {
        value: null,
    };
}

/**
 * @param {ConfigBox} box
 * @param {Capabilities} _capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(box, _capabilities) {
    return async (_inputs, oldValue, _bindings) => {
        const nextValue = { type: "config", config: box.value };
        if (
            oldValue !== undefined &&
            oldValue.type === "config" &&
            JSON.stringify(
                oldValue.config === null ? null : serialize(oldValue.config)
            ) === JSON.stringify(
                nextValue.config === null ? null : serialize(nextValue.config)
            )
        ) {
            return makeUnchanged();
        }
        return nextValue;
    };
}

module.exports = {
    makeBox,
    makeComputor,
};
