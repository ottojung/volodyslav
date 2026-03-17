const { serialize } = require("../../../event");
const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {object} AllEventsBox
 * @property {Array<import('../../../event').Event>} value
 */

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 */

/**
 * @returns {AllEventsBox}
 */
function makeBox() {
    return {
        value: [],
    };
}

/**
 * @param {Array<import('../../../event').SerializedEvent>} left
 * @param {Array<import('../../../event').SerializedEvent>} right
 * @returns {boolean}
 */
function serializedEventsEqual(left, right) {
    if (left.length !== right.length) {
        return false;
    }
    for (const [index, leftEvent] of left.entries()) {
        const rightEvent = right[index];
        if (rightEvent === undefined) {
            return false;
        }
        if (
            leftEvent.id !== rightEvent.id ||
            leftEvent.date !== rightEvent.date ||
            leftEvent.original !== rightEvent.original ||
            leftEvent.input !== rightEvent.input ||
            leftEvent.creator.name !== rightEvent.creator.name ||
            leftEvent.creator.uuid !== rightEvent.creator.uuid ||
            leftEvent.creator.version !== rightEvent.creator.version ||
            leftEvent.creator.hostname !== rightEvent.creator.hostname
        ) {
            return false;
        }
    }
    return true;
}

/**
 * @param {AllEventsBox} box
 * @param {Capabilities} capabilities
 * @returns {import('../../incremental_graph/types').NodeDefComputor}
 */
function makeComputor(box, capabilities) {
    return async (_inputs, oldValue, _bindings) => {
        const nextValue = {
            type: "all_events",
            events: box.value.map((entry) => serialize(capabilities, entry)),
        };

        if (
            oldValue !== undefined &&
            oldValue.type === "all_events" &&
            serializedEventsEqual(oldValue.events, nextValue.events)
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
