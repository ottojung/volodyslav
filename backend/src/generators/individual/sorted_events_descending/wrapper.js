
/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, _bindings) => {
    const allEventsEntry = inputs[0];
    if (!allEventsEntry || allEventsEntry.type !== "all_events") {
        return { type: "sorted_events_descending", events: [] };
    }

    const events = allEventsEntry.events
    events.sort((a, b) => b.date.localeCompare(a.date));
    return { type: "sorted_events_descending", events };
};

module.exports = {
    computor,
};
