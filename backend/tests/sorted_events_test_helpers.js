/**
 * Shared test helpers for sorted-events and cache-entry graph-node tests.
 */

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { fromDays } = require("../src/datetime/duration");
const { transaction } = require("../src/event_log_storage");
const { stubGeneratorsRepository } = require("./stub_generators_repository");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
} = require("./stubs");

/**
 * Creates fully-stubbed test capabilities including a generator database.
 * @returns {Promise<object>}
 */
async function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubGeneratorsRepository(capabilities);
    return capabilities;
}

/**
 * Creates a minimal well-formed event.
 * @param {string} id
 * @param {string} dateIso - ISO-8601 date string
 * @param {string} [type]
 * @param {string} [description]
 */
function makeEvent(id, dateIso, type = "text", description = `Event ${id}`) {
    return {
        id: eventId.fromString(id),
        type,
        description,
        date: fromISOString(dateIso),
        original: description,
        input: description,
        modifiers: {},
        creator: {
            name: "test",
            uuid: "00000000-0000-0000-0000-000000000001",
            version: "0.0.0",
            hostname: "test-host",
        },
    };
}

/**
 * Writes an array of events into the incremental graph-backed event log.
 * @param {object} capabilities
 * @param {Array<object>} events
 */
async function writeEventsAndUpdate(capabilities, events) {
    await transaction(capabilities, async (storage) => {
        for (const ev of events) {
            storage.addEntry(ev, []);
        }
    });
}

/**
 * Collects all values from an async iterable into an array.
 * @template T
 * @param {AsyncIterable<T>} iter
 * @returns {Promise<T[]>}
 */
async function collectAll(iter) {
    const results = [];
    for await (const item of iter) {
        results.push(item);
    }
    return results;
}

/**
 * Creates `count` events with sequential dates starting from `baseIso`,
 * each one day apart.  IDs have their numeric portion zero-padded to four
 * digits (e.g. 'evt-0001', 'evt-0002', …) so lexicographic and numeric
 * ordering agree.
 * @param {number} count
 * @param {string} [baseIso]
 * @returns {object[]}
 */
function makeSequentialEvents(count, baseIso = "2024-01-01T00:00:00.000Z") {
    const base = fromISOString(baseIso);
    return Array.from({ length: count }, (_, i) => {
        const pad = String(i + 1).padStart(4, "0");
        const date = base.advance(fromDays(i));
        return makeEvent(`evt-${pad}`, date.toISOString());
    });
}

module.exports = {
    getTestCapabilities,
    makeEvent,
    writeEventsAndUpdate,
    collectAll,
    makeSequentialEvents,
};
