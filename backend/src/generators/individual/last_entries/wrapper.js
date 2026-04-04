/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, bindings) => {
    const n = bindings.n;
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

module.exports = {
    computor,
};
