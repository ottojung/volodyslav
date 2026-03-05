/**
 * Tests for GET /api/entries/:id/additional-properties
 */

const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubAiCalories,
    stubEventLogRepository,
} = require("./stubs");

/**
 * Builds a minimal well-formed event for testing.
 * @param {string} id
 * @param {string} input
 */
function makeEvent(id, input = "") {
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
 * Creates a full Express app with routes, but does NOT initialize the interface.
 */
async function makeUninitializedApp(defaultCalories = 0) {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubAiCalories(capabilities, defaultCalories);
    await stubEventLogRepository(capabilities);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    addRoutes(capabilities, app);
    return { app, capabilities };
}

/**
 * Creates a full Express app with routes AND initializes the incremental graph.
 */
async function makeInitializedApp(defaultCalories = 0) {
    const { app, capabilities } = await makeUninitializedApp(defaultCalories);
    await capabilities.interface.ensureInitialized();
    return { app, capabilities };
}

describe("GET /api/entries/:id/additional-properties", () => {
    describe("when incremental graph is not initialized", () => {
        it("returns 503", async () => {
            const { app } = await makeUninitializedApp();
            const res = await request(app)
                .get("/api/entries/evt-1/additional-properties");
            expect(res.statusCode).toBe(503);
            expect(res.body).toMatchObject({ error: expect.any(String) });
        });
    });

    describe("when incremental graph is initialized", () => {
        it("returns empty object for an unknown entry id", async () => {
            const { app, capabilities } = await makeInitializedApp(100);

            await writeEventsToStore(capabilities, [makeEvent("known-id", "food: a pizza")]);
            await capabilities.interface.update();

            const res = await request(app)
                .get("/api/entries/unknown-id/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({});
        });

        it("returns empty object when entry has no input text", async () => {
            const { app, capabilities } = await makeInitializedApp(0);

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "")]);
            await capabilities.interface.update();

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({});
        });

        it("returns empty object when AI estimates 0 calories", async () => {
            const { app, capabilities } = await makeInitializedApp(0);

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "ran 5km")]);
            await capabilities.interface.update();

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({});
        });

        it("returns { calories } when AI estimates non-zero calories", async () => {
            const { app, capabilities } = await makeInitializedApp(420);

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "food: had a big pasta")]);
            await capabilities.interface.update();

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ calories: 420 });
        });

        it("passes the entry input text to the AI estimator", async () => {
            const { app, capabilities } = await makeInitializedApp(300);
            const input = "food: two slices of toast with butter";

            await writeEventsToStore(capabilities, [makeEvent("entry-2", input)]);
            await capabilities.interface.update();

            await request(app)
                .get("/api/entries/entry-2/additional-properties");

            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(input);
        });

        it("uses cached value on repeated requests without re-calling AI", async () => {
            const { app, capabilities } = await makeInitializedApp(200);

            await writeEventsToStore(capabilities, [makeEvent("entry-3", "food: a bowl of oatmeal")]);
            await capabilities.interface.update();

            await request(app).get("/api/entries/entry-3/additional-properties");
            await request(app).get("/api/entries/entry-3/additional-properties");

            // AI should only have been called once due to graph caching
            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(1);
        });

        it("returns correct calories for each of multiple entries independently", async () => {
            const { app, capabilities } = await makeInitializedApp(0);

            capabilities.aiCalories.estimateCalories
                .mockResolvedValueOnce(150)
                .mockResolvedValueOnce(500);

            await writeEventsToStore(capabilities, [
                makeEvent("entry-a", "food: an apple"),
                makeEvent("entry-b", "food: a big burger"),
            ]);
            await capabilities.interface.update();

            const resA = await request(app)
                .get("/api/entries/entry-a/additional-properties");
            const resB = await request(app)
                .get("/api/entries/entry-b/additional-properties");

            expect(resA.body).toEqual({ calories: 150 });
            expect(resB.body).toEqual({ calories: 500 });
        });
    });
});
