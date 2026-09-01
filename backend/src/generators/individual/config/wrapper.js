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
        if (box.value === null) {
            // This is the initial state before the interface has ever called setConfig.
            if (oldValue === undefined) {
                // We haven't set a value yet, and we also don't have an old value,
                // so we return the default of null.
                return { type: "config", config: null };
            } else {
                // We haven't set a value yet, but we do have an old value.  This means
                // we've previously set a value, but it was cleared by an upstream change,
                // so we can simply return the unchanged token.
                return makeUnchanged();
            }
        }

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
