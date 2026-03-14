const { computeEventContexts } = require('./compute');

/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, _bindings) => {
    const metaEventsEntry = inputs[0];
    if (!metaEventsEntry) {
        return { type: "event_context", contexts: [] };
    }

    if (metaEventsEntry.type !== "meta_events") {
        return { type: "event_context", contexts: [] };
    }

    const metaEventsArray = metaEventsEntry.meta_events;
    const contexts = computeEventContexts(metaEventsArray);

    return {
        type: "event_context",
        contexts: contexts,
    };
};

module.exports = {
    computor,
};
