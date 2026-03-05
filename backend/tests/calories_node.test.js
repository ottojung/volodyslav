/**
 * Tests for event(e) and calories(e) nodes in the default incremental graph.
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const { makeInterface } = require("../src/generators/interface");
const eventId = require("../src/event/id");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment, stubAiCalories } = require("./stubs");

/**
 * Creates test capabilities with a temporary data directory.
 * @param {number} [defaultCalories=0] - calorie value to return from the mocked AI
 */
function getTestCapabilities(defaultCalories = 0) {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), "calories-node-test-")
    );
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubAiCalories(capabilities, defaultCalories);
    return { ...capabilities, tmpDir };
}

function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
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
        description: input,
        date: "2024-01-01",
        original: input,
        input,
        modifiers: {},
        creator: { type: "user", name: "test" },
    };
}

// ---------------------------------------------------------------------------
// event(e)
// ---------------------------------------------------------------------------

describe("event(e) node", () => {
    test("returns the input text of the identified event", async () => {
        const capabilities = getTestCapabilities();
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            const events = [makeEvent("1", "food: a slice of bread")];
            await iface.update(events);

            const result = await iface.incrementalGraph.pull("event", ["1"]);
            expect(result).toEqual({ type: "event", value: events[0] });
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("returns empty string for an unknown event ID", async () => {
        const capabilities = getTestCapabilities();
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            const events = [makeEvent("1", "food: a slice of bread")];
            await iface.update(events);

            const result = await iface.incrementalGraph.pull("event", ["999"]);
            expect(result).toEqual({ type: "event", value: null });
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("reflects updated input text after events change", async () => {
        const capabilities = getTestCapabilities();
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([makeEvent("1", "sleep 8 hours")]);
            const first = await iface.incrementalGraph.pull("event", ["1"]);
            expect(first).toEqual({ type: "event", value: makeEvent("1", "sleep 8 hours") });

            await iface.update([makeEvent("1", "food: two eggs")]);
            const second = await iface.incrementalGraph.pull("event", ["1"]);
            expect(second).toEqual({ type: "event", value: makeEvent("1", "food: two eggs") });
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("handles event whose input field is empty string", async () => {
        const capabilities = getTestCapabilities();
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            const event = makeEvent("1", "");
            await iface.update([event]);

            const result = await iface.incrementalGraph.pull("event", ["1"]);
            expect(result).toEqual({ type: "event", value: event });
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("handles multiple events and returns the correct one", async () => {
        const capabilities = getTestCapabilities();
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([
                makeEvent("1", "food: pasta"),
                makeEvent("2", "sleep 7 hours"),
                makeEvent("3", "food: apple"),
            ]);

            expect(await iface.incrementalGraph.pull("event", ["1"])).toEqual(
                { type: "event", value: makeEvent("1", "food: pasta") }
            );
            expect(await iface.incrementalGraph.pull("event", ["2"])).toEqual(
                { type: "event", value: makeEvent("2", "sleep 7 hours") }
            );
            expect(await iface.incrementalGraph.pull("event", ["3"])).toEqual(
                { type: "event", value: makeEvent("3", "food: apple") }
            );
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });
});

// ---------------------------------------------------------------------------
// calories(e)
// ---------------------------------------------------------------------------

describe("calories(e) node", () => {
    test("calls estimateCalories with the event input text and returns result", async () => {
        const capabilities = getTestCapabilities(250);
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([makeEvent("1", "food: a bowl of pasta")]);
            const result = await iface.incrementalGraph.pull("calories", ["1"]);

            expect(result).toEqual({ type: "calories", value: 250 });
            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
                "food: a bowl of pasta"
            );
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("returns default calories for an unknown event ID", async () => {
        const capabilities = getTestCapabilities(999);
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([makeEvent("1", "food: burger")]);
            const result = await iface.incrementalGraph.pull("calories", ["999"]);

            expect(result).toEqual({ type: "calories", value: 999 });
            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith("");
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("returns 0 calories for a non-food entry", async () => {
        const capabilities = getTestCapabilities(0);
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([makeEvent("1", "sleep 8 hours")]);
            const result = await iface.incrementalGraph.pull("calories", ["1"]);

            expect(result).toEqual({ type: "calories", value: 0 });
            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
                "sleep 8 hours"
            );
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("does not recompute when input is unchanged (returns cached value)", async () => {
        const capabilities = getTestCapabilities(100);
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([makeEvent("1", "food: a slice of bread")]);

            const first = await iface.incrementalGraph.pull("calories", ["1"]);
            expect(first).toEqual({ type: "calories", value: 100 });

            // Pull again without any update — should serve from cache
            const second = await iface.incrementalGraph.pull("calories", ["1"]);
            expect(second).toEqual({ type: "calories", value: 100 });

            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(1);
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("recomputes when input text changes", async () => {
        const capabilities = getTestCapabilities();
        capabilities.aiCalories.estimateCalories = jest
            .fn()
            .mockResolvedValueOnce(100)
            .mockResolvedValueOnce(300);
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([makeEvent("1", "food: a slice of bread")]);
            const first = await iface.incrementalGraph.pull("calories", ["1"]);
            expect(first).toEqual({ type: "calories", value: 100 });

            // Change the event input
            await iface.update([makeEvent("1", "food: a large pizza")]);
            const second = await iface.incrementalGraph.pull("calories", ["1"]);
            expect(second).toEqual({ type: "calories", value: 300 });

            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(2);
            expect(capabilities.aiCalories.estimateCalories).toHaveBeenNthCalledWith(
                1, "food: a slice of bread"
            );
            expect(capabilities.aiCalories.estimateCalories).toHaveBeenNthCalledWith(
                2, "food: a large pizza"
            );
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test("computes independently for different event IDs", async () => {
        const capabilities = getTestCapabilities();
        capabilities.aiCalories.estimateCalories = jest
            .fn()
            .mockResolvedValueOnce(150)
            .mockResolvedValueOnce(0)
            .mockResolvedValueOnce(400);
        try {
            const iface = makeInterface(() => capabilities);
            await iface.ensureInitialized();

            await iface.update([
                makeEvent("1", "food: a sandwich"),
                makeEvent("2", "sleep 8 hours"),
                makeEvent("3", "food: a large steak"),
            ]);

            const c1 = await iface.incrementalGraph.pull("calories", ["1"]);
            const c2 = await iface.incrementalGraph.pull("calories", ["2"]);
            const c3 = await iface.incrementalGraph.pull("calories", ["3"]);

            expect(c1).toEqual({ type: "calories", value: 150 });
            expect(c2).toEqual({ type: "calories", value: 0 });
            expect(c3).toEqual({ type: "calories", value: 400 });
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });
});
