/**
 * Tests for event(e) and calories(e) nodes in the default incremental graph.
 */

const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubDatetime,
    stubAiCalories,
} = require("./stubs");

/**
 * Creates test capabilities.
 * @param {number | 'N/A'} [defaultCalories='N/A'] - calorie value to return from the mocked AI, or 'N/A' for unavailable
 */
async function getTestCapabilities(defaultCalories = "N/A") {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
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
        creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0", hostname: "test-host" },
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
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        const result = await iface._incrementalGraph.pull("event", ["1"]);
        expect(result).toMatchObject({
            type: "event",
            value: { id: "1", input: "food: a slice of bread" },
        });
    });

    test("throws EventNotFoundError for an unknown event ID", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        await expect(
            iface._incrementalGraph.pull("event", ["999"])
        ).rejects.toThrow("Event with ID 999 not found in all_events");
    });

    test("reflects updated input text after events change", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "sleep 8 hours")]);
        const first = await iface._incrementalGraph.pull("event", ["1"]);
        expect(first).toMatchObject({ type: "event", value: { id: "1", input: "sleep 8 hours" } });

        await replaceEventInStore(capabilities, makeEvent("1", "food: two eggs"));
        const second = await iface._incrementalGraph.pull("event", ["1"]);
        expect(second).toMatchObject({ type: "event", value: { id: "1", input: "food: two eggs" } });
    });

    test("handles event whose input field is empty string", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "")]);
        const result = await iface._incrementalGraph.pull("event", ["1"]);
        expect(result).toMatchObject({ type: "event", value: { id: "1", input: "" } });
    });

    test("handles multiple events and returns the correct one", async () => {
        const capabilities = await getTestCapabilities();
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [
            makeEvent("1", "food: pasta"),
            makeEvent("2", "sleep 7 hours"),
            makeEvent("3", "food: apple"),
        ]);
        const r1 = await iface._incrementalGraph.pull("event", ["1"]);
        const r2 = await iface._incrementalGraph.pull("event", ["2"]);
        const r3 = await iface._incrementalGraph.pull("event", ["3"]);

        expect(r1).toMatchObject({ type: "event", value: { id: "1", input: "food: pasta" } });
        expect(r2).toMatchObject({ type: "event", value: { id: "2", input: "sleep 7 hours" } });
        expect(r3).toMatchObject({ type: "event", value: { id: "3", input: "food: apple" } });
    });
});

// ---------------------------------------------------------------------------
// calories(e)
// ---------------------------------------------------------------------------

describe("calories(e) node", () => {
    test("calls estimateCalories with the event input text and returns result", async () => {
        const capabilities = await getTestCapabilities(250);
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a bowl of pasta")]);
        const result = await iface._incrementalGraph.pull("calories", ["1"]);

        expect(result).toEqual({ type: "calories", value: 250 });
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
            "food: a bowl of pasta"
        );
    });

    test("throws EventNotFoundError for an unknown event ID", async () => {
        const capabilities = await getTestCapabilities(999);
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: burger")]);
        await expect(
            iface._incrementalGraph.pull("calories", ["999"])
        ).rejects.toThrow("Event with ID 999 not found in all_events");
        expect(capabilities.aiCalories.estimateCalories).not.toHaveBeenCalled();
    });

    test("returns N/A for a non-food entry", async () => {
        const capabilities = await getTestCapabilities("N/A");
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "sleep 8 hours")]);
        const result = await iface._incrementalGraph.pull("calories", ["1"]);

        expect(result).toEqual({ type: "calories", value: "N/A" });
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
            "sleep 8 hours"
        );
    });

    test("returns 0 calories for a food entry with no caloric content (e.g. tea)", async () => {
        const capabilities = await getTestCapabilities(0);
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "a cup of plain tea")]);
        const result = await iface._incrementalGraph.pull("calories", ["1"]);

        expect(result).toEqual({ type: "calories", value: 0 });
        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
            "a cup of plain tea"
        );
    });

    test("does not recompute when input is unchanged (returns cached value)", async () => {
        const capabilities = await getTestCapabilities(100);
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        const first = await iface._incrementalGraph.pull("calories", ["1"]);
        expect(first).toEqual({ type: "calories", value: 100 });

        // Pull again without any update — should serve from cache
        const second = await iface._incrementalGraph.pull("calories", ["1"]);
        expect(second).toEqual({ type: "calories", value: 100 });

        expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(1);
    });

    test("recomputes when input text changes", async () => {
        const capabilities = await getTestCapabilities();
        capabilities.aiCalories.estimateCalories = jest
            .fn()
            .mockResolvedValueOnce(100)
            .mockResolvedValueOnce(300);
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [makeEvent("1", "food: a slice of bread")]);
        const first = await iface._incrementalGraph.pull("calories", ["1"]);
        expect(first).toEqual({ type: "calories", value: 100 });

        // Replace the event with new content
        await replaceEventInStore(capabilities, makeEvent("1", "food: a large pizza"));
        const second = await iface._incrementalGraph.pull("calories", ["1"]);
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
            .mockResolvedValueOnce("N/A")
            .mockResolvedValueOnce(400);
        const iface = capabilities.interface;
        await iface.ensureInitialized();

        await writeEventsToStore(capabilities, [
            makeEvent("1", "food: a sandwich"),
            makeEvent("2", "sleep 8 hours"),
            makeEvent("3", "food: a large steak"),
        ]);
        const c1 = await iface._incrementalGraph.pull("calories", ["1"]);
        const c2 = await iface._incrementalGraph.pull("calories", ["2"]);
        const c3 = await iface._incrementalGraph.pull("calories", ["3"]);

        expect(c1).toEqual({ type: "calories", value: 150 });
        expect(c2).toEqual({ type: "calories", value: "N/A" });
        expect(c3).toEqual({ type: "calories", value: 400 });
    });
});
