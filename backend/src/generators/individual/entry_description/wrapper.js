const { computeEntryDescription } = require("./compute");
const { deserialize } = require("../../../event");

/**
 * @typedef {import('../../incremental_graph/types').NodeDefComputor} NodeDefComputor
 */

/**
 * @type {NodeDefComputor}
 */
const computor = async (inputs) => {
    const eventEntry = inputs[0];
    if (!eventEntry || eventEntry.type !== "event") {
        throw new Error("Expected event input for entry_description(e) computor");
    }
    return computeEntryDescription(deserialize(eventEntry.value));
};

module.exports = {
    computor,
};
