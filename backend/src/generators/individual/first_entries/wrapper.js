/**
 * @type {import('../../incremental_graph/types').NodeDefComputor}
 */
const computor = async (inputs, _oldValue, bindings) => {
    const n = bindings.n;
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

module.exports = {
    computor,
};
