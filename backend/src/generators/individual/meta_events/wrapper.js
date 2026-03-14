const { isUnchanged } = require('../../incremental_graph');
const { deserialize } = require('../../../event');
const { computeMetaEvents } = require('./compute');

/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, oldValue, _bindings) => {
    const allEventsEntry = inputs[0];
    if (!allEventsEntry) {
        return { type: "meta_events", meta_events: [] };
    }

    if (allEventsEntry.type !== "all_events") {
        return { type: "meta_events", meta_events: [] };
    }

    const allEvents = allEventsEntry.events.map(deserialize);

    /** @type {Array<import('./compute').MetaEvent>} */
    let currentMetaEvents = [];
    if (oldValue && oldValue.type === "meta_events") {
        currentMetaEvents = oldValue.meta_events;
    }

    const result = computeMetaEvents(
        allEvents,
        currentMetaEvents
    );

    if (isUnchanged(result) && oldValue !== undefined) {
        return result;
    }

    return {
        type: "meta_events",
        meta_events: isUnchanged(result) ? currentMetaEvents : result,
    };
};

module.exports = {
    computor,
};
