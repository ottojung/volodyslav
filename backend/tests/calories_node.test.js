/**
 * Tests for event(e) and calories(e) nodes in the default incremental graph.
 */

const { makeInterface } = require("../src/generators/interface");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    stubEventLogRepository,
    stubAiCalories,
} = require("./stubs");

/**
 * Creates test capabilities.
 * @param {number} [defaultCalories=0] - calorie value to return from the mocked AI
 */
async function getTestCapabilities(defaultCalories = 0) {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    stubAiCalories(capabilities, defaultCalories);
    return capabilities;
}

/**
 * Builds a minimal well-formed event for testing.
 * @param {string} id
 * @param {string} input
 */
function makeEvent(id, input) {
    return {
        id: eventId.fromString(id),
        type: "text",
        description: input || "no description",
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: input,
        input,
        modifiers: {},
        creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0" },
    };
}

/**
 * Writes events to the event log gitstore via a transaction.
 * @param {object} capabilities
 * @param {Array<object>} events
 */
async function writeEventsToStore(capabilities, events) {
    await transaction(capabilities, async (storage) => {
        for (const event of events) {
            storage.addEntry(event, []);
        }
    });
}

/**
 * Replaces an event in the event store by deleting the old one and adding the new one.
 * @param {object} capabilities
 * @param {object} event
 */
async function replaceEventInStore(capabilities, event) {
    await transaction(capabilities, async (storage) => {
        storage.deleteEntry(event.id);
        storage.addEntry(event, []);
    });
}

describe("event(e) node", () => {
    test("returns the input text of the identified event", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        await iface.update();

        const result = await iface.incrementalGraph.pull("event", ["1"]);
        expect(result).toMatchObject({
            type: "event",
            value: { id: { identifier: "1" }, input: "food: a slice of bread" },
        });
    });

    test("throws EventNotFoundError for an unknown event ID", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        await iface.update();

        await expect(
            iface.incrementalGraph.pull("event", ["999"])
        ).rejects.toThrow("Event with ID 999 not found in all_events");
    });

    test("reflects updated input text after events change", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "sleep 8 hours")]);
        await iface.update();
        const first = await iface.incrementalGraph.pull("event", ["1"]);
        expect(first).toMatchObject({ type: "event", value: { id: { identifier: "1" }, input: "sleep 8 hours" } });

        await replaceEventInStore(capabilities, makeEvent("1", "food: two eggs"));
        await iface.update();
        const second = await iface.incrementalGraph.pull("event", ["1"]);
        expect(second).toMatchObject({ type: "event", value: { id: { identifier: "1" }, input: "food: two eggs" } });
    });

    test("handles event whose input field is empty string", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "")]);
        await iface.update();

        const result = await iface.incrementalGraph.pull("event", ["1"]);
        expect(result).toMatchObject({ type: "event", value: { id: { identifier: "1" }, input: "" } });
    });

    test("handles multiple events and returns the correct one", async () => {
        const capabilities = await getTestCapabilities();
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [
            makeEvent("1", "food: pasta"),
            makeEvent("2", "sleep 7 hours"),
            makeEvent("3", "food: apple"),
        ]);
        await iface.update();

        const r1 = await iface.incrementalGraph.pull("event", ["1"]);
        const r2 = await iface.incrementalGraph.pull("event", ["2"]);
        const r3 = await iface.incrementalGraph.pull("event", ["3"]);

        expect(r1).toMatchObject({ type: "event", value: { id: { identifier: "1" }, input: "food: pasta" } });
        expect(r2).toMatchObject({ type: "event", value: { id: { identifier: "2" }, input: "sleep 7 hours" } });
        expect(r3).toMatchObject({ type: "event", value: { id: { identifier: "3" }, input: "food: apple" } });
    });
});

// ---------------------------------------------------------------------------
// calories(e)
// ---------------------------------------------------------------------------

describe("calories(e) node", () => {
    test("calls estimateCalories with the event input text and returns result", async () => {
        const capabilities = await getTestCapabilities(250);
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a bowl of pasta")]);
        await iface.update();
        const result = await iface.incrementalGraph.pull("calories", ["1"]);

        expect(result).toEqual({ type: "calories", value: 250 });
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
            "food: a bowl of pasta"
        );
    });

    test("throws EventNotFoundError for an unknown event ID", async () => {
        const capabilities = await getTestCapabilities(999);
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: burger")]);
        await iface.update();

        await expect(
            iface.incrementalGraph.pull("calories", ["999"])
        ).rejects.toThrow("Event with ID 999 not found in all_events");
        expect(capabilities.aiCalories.estimateCalories).not.toHaveBeenCalled();
    });

    test("returns 0 calories for a non-food entry", async () => {
        const capabilities = await getTestCapabilities(0);
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "sleep 8 hours")]);
        await iface.update();
        const result = await iface.incrementalGraph.pull("calories", ["1"]);

        expect(result).toEqual({ type: "calories", value: 0 });
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
            "sleep 8 hours"
        );
    });

    test("does not recompute when input is unchanged (returns cached value)", async () => {
        const capabilities = await getTestCapabilities(100);
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        await iface.update();

        const first = await iface.incrementalGraph.pull("calories", ["1"]);
        expect(first).toEqual({ type: "calories", value: 100 });

        // Pull again without any update — should serve from cache
        const second = await iface.incrementalGraph.pull("calories", ["1"]);
        expect(second).toEqual({ type: "calories", value: 100 });

        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(1);
    });

    test("recomputes when input text changes", async () => {
        const capabilities = await getTestCapabilities();
        capabilities.aiCalories.estimateCalories = jest
            .fn()
            .mockResolvedValueOnce(100)
            .mockResolvedValueOnce(300);
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        await iface.update();
        const first = await iface.incrementalGraph.pull("calories", ["1"]);
        expect(first).toEqual({ type: "calories", value: 100 });

        // Replace the event with new content
        await replaceEventInStore(capabilities, makeEvent("1", "food: a large pizza"));
        await iface.update();
        const second = await iface.incrementalGraph.pull("calories", ["1"]);
        expect(second).toEqual({ type: "calories", value: 300 });

        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(2);
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenNthCalledWith(
            1, "food: a slice of bread"
        );
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenNthCalledWith(
            2, "food: a large pizza"
        );
    });

    test("computes independently for different event IDs", async () => {
        const capabilities = await getTestCapabilities();
        capabilities.aiCalories.estimateCalories = jest
            .fn()
            .mockResolvedValueOnce(150)
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(400);
        const iface = makeInterface(() => capabilities);
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [
            makeEvent("1", "food: a sandwich"),
            makeEvent("2", "sleep 8 hours"),
            makeEvent("3", "food: a large steak"),
        ]);
        await iface.update();

        const c1 = await iface.incrementalGraph.pull("calories", ["1"]);
        const c2 = await iface.incrementalGraph.pull("calories", ["2"]);
        const c3 = await iface.incrementalGraph.pull("calories", ["3"]);

        expect(c1).toEqual({ type: "calories", value: 150 });
        expect(c2).toEqual({ type: "calories", value: 0 });
        expect(c3).toEqual({ type: "calories", value: 400 });
    });
});
