const { fromISOString } = require("../../../datetime");

/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, _bindings) => {
    const allEventsEntry = inputs[0];
    if (!allEventsEntry || allEventsEntry.type !== "all_events") {
        return { type: "sorted_events_descending", events: [] };
    }

    const eventsWithDates = allEventsEntry.events.map(event => ({
        event,
        date: fromISOString(event.date),
    }));
    eventsWithDates.sort((a, b) => b.date.compare(a.date));
    const sorted = eventsWithDates.map(({ event }) => event);
    return { type: "sorted_events_descending", events: sorted };
};

module.exports = {
    computor,
};
