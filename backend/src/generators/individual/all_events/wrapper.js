const { serialize } = require("../../../event");
const { makeUnchanged } = require("../../incremental_graph");

/**
 * @typedef {import("../../../event").Event} Event
 */

/**
 * @typedef {object} AllEventsBox
 * @property {Array<Event> | "never-set"} value
 */

/**
 * @typedef {import('../../interface/default_graph').Capabilities} Capabilities
 */

/**
 * @returns {AllEventsBox}
 */
function makeBox() {
    const value = "never-set";
    return { value };
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
        if (box.value === "never-set") {
            // This is the initial state before we've ever set a value.
            if (oldValue === undefined) {
                // We haven't set a value yet, and we also don't have an old value,
                // so this is the very first time the computor is running.  Initialise the
                // box to an empty list of events and return that as the initial value.
                box.value = [];
            } else {
                // We haven't set a value yet, but we do have an old value.  This means
                // we've previously set a value, but it was cleared by an upstream change,
                // so we can simply return the unchanged token.
                return makeUnchanged();
            }
        }

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
