const { transaction } = require("../../event_log_storage");
const { serialize } = require("../../event");
const { fromISOString } = require("../../datetime");

/**
 * @typedef {import('./default_graph').Capabilities} Capabilities
 */

/**
 * @param {Capabilities} capabilities
 * @returns {import('../incremental_graph/types').NodeDefComputor}
 */
function makeConfigComputor(capabilities) {
    return async (_inputs, _oldValue, _bindings) => {
        const config = await transaction(capabilities, async (storage) => {
            return await storage.getExistingConfig();
        });
        return { type: "config", config };
    };
}

/**
 * @param {Capabilities} capabilities
 * @returns {import('../incremental_graph/types').NodeDefComputor}
 */
function makeAllEventsComputor(capabilities) {
    return async (_inputs, _oldValue, _bindings) => {
        const events = await transaction(capabilities, async (storage) => {
            return await storage.getExistingEntries();
        });
        return { type: "all_events", events: events.map((e) => serialize(capabilities, e)) };
    };
}

/**
 * @type {import('../incremental_graph/types').NodeDefComputor}
 */
const sortedEventsDescendingComputor = async (inputs, _oldValue, _bindings) => {
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

/**
 * @type {import('../incremental_graph/types').NodeDefComputor}
 */
const sortedEventsAscendingComputor = async (inputs, _oldValue, _bindings) => {
    const descEntry = inputs[0];
    if (!descEntry || descEntry.type !== "sorted_events_descending") {
        return { type: "sorted_events_ascending", events: [] };
    }
    return {
        type: "sorted_events_ascending",
        events: descEntry.events.slice().reverse(),
    };
};

/**
 * @type {import('../incremental_graph/types').NodeDefComputor}
 */
const lastEntriesComputor = async (inputs, _oldValue, bindings) => {
    const n = bindings[0];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        throw new Error(
            `Expected non-negative integer binding n for last_entries(n) but got: ${JSON.stringify(n)}`
        );
    }
    const descEntry = inputs[0];
    if (!descEntry || descEntry.type !== "sorted_events_descending") {
        return { type: "last_entries", n, events: [] };
    }
    return {
        type: "last_entries",
        n,
        events: descEntry.events.slice(0, n),
    };
};

/**
 * @type {import('../incremental_graph/types').NodeDefComputor}
 */
const firstEntriesComputor = async (inputs, _oldValue, bindings) => {
    const n = bindings[0];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 0) {
        throw new Error(
            `Expected non-negative integer binding n for first_entries(n) but got: ${JSON.stringify(n)}`
        );
    }
    const ascEntry = inputs[0];
    if (!ascEntry || ascEntry.type !== "sorted_events_ascending") {
        return { type: "first_entries", n, events: [] };
    }
    return {
        type: "first_entries",
        n,
        events: ascEntry.events.slice(0, n),
    };
};

/**
 * @type {import('../incremental_graph/types').NodeDefComputor}
 */
const eventsCountComputor = async (inputs, _oldValue, _bindings) => {
    const allEventsEntry = inputs[0];
    if (!allEventsEntry || allEventsEntry.type !== "all_events") {
        return { type: "events_count", count: 0 };
    }
    return { type: "events_count", count: allEventsEntry.events.length };
};

module.exports = {
    makeConfigComputor,
    makeAllEventsComputor,
    sortedEventsDescendingComputor,
    sortedEventsAscendingComputor,
    lastEntriesComputor,
    firstEntriesComputor,
    eventsCountComputor,
};
