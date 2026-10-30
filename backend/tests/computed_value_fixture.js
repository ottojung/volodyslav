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

const { fromISOString } = require("../src/datetime");
const { fromString: eventIdFromString } = require("../src/event").id;

const META_EVENT_FIXTURE_DATE = "2024-01-01T00:00:00.000Z";

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

/**
 * A `meta_events` member carrying one `add` meta event whose `original` text is
 * the marker. A fixture that needs a computor to return a different value on
 * each call needs a member of the union whose content changes, and a meta event's
 * `original` is a string it can carry that marker in.
 *
 * A `meta_events` member carries a live `Event`, so its identifier and date are
 * the nominal `EventId` and `DateTime` values rather than the persisted strings
 * an `all_events` member carries.
 *
 * @param {string} marker
 * @returns {ComputedValue}
 */
function metaEventComputedValue(marker) {
    return {
        type: "meta_events",
        meta_events: [
            {
                action: "add",
                event: {
                    id: eventIdFromString(marker),
                    date: fromISOString(META_EVENT_FIXTURE_DATE),
                    original: marker,
                    input: marker,
                    creator: {
                        name: "test",
                        uuid: "00000000-0000-0000-0000-000000000000",
                        version: "0.0.0",
                        hostname: "test-host",
                    },
                },
            },
        ],
    };
}

module.exports = {
    countComputedValue,
    metaEventComputedValue,
    numberComputedValue,
    textComputedValue,
};
