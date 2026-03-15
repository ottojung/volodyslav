/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, _bindings) => {
    const allEventsEntry = inputs[0];
    if (!allEventsEntry || allEventsEntry.type !== "all_events") {
        return { type: "events_count", count: 0 };
    }
    return { type: "events_count", count: allEventsEntry.events.length };
};

module.exports = {
    computor,
};
