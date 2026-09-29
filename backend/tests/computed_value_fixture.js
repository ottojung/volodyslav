/**
 * Builders for the `ComputedValue` members test fixtures return.
 *
 * A computor's return value is a `ComputedValue`, so a fixture computor that
 * invents `{ value: 1 }` or `{ test: true }` is not a smaller version of a real
 * computor — it is a payload the graph's own union does not contain, and a
 * journal value record cannot name it. These builders name the real members and
 * keep the payload a fixture wants to carry in the member field that holds it.
 *
 * `calories` is the member for a bare number, `events_count` for a bare count,
 * and `entry_description` for a bare string, so a fixture's assertions keep
 * reading the field it always read.
 */

/** @typedef {import('../src/generators/incremental_graph/database/types').ComputedValue} ComputedValue */

/**
 * A `calories` member carrying a bare number.
 * @param {number} value
 * @returns {ComputedValue}
 */
function numberComputedValue(value) {
    return { type: "calories", value };
}

/**
 * An `events_count` member carrying a bare count.
 * @param {number} count
 * @returns {ComputedValue}
 */
function countComputedValue(count) {
    return { type: "events_count", count };
}

/**
 * An `entry_description` member carrying a bare string.
 * @param {string} description
 * @returns {ComputedValue}
 */
function textComputedValue(description) {
    return { type: "entry_description", description };
}

module.exports = {
    countComputedValue,
    numberComputedValue,
    textComputedValue,
};
