/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, _bindings) => {
    const descEntry = inputs[0];
    if (!descEntry || descEntry.type !== "sorted_events_descending") {
        return { type: "sorted_events_ascending", events: [] };
    }
    return {
        type: "sorted_events_ascending",
        events: descEntry.events.slice().reverse(),
    };
};

module.exports = {
    computor,
};
