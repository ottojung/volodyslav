/**
 * Tests for GET /api/entries/:id/additional-properties
 */

const path = require("path");
const fs = require("fs");
const os = require("os");
const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const eventId = require("../src/event/id");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubAiCalories } = require("./stubs");

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
        date: "2024-01-01",
        original: input,
        input,
        modifiers: {},
        creator: { type: "user", name: "test" },
    };
}

function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

/**
 * Creates a full Express app with routes, but does NOT initialize the interface.
 */
async function makeUninitializedApp(defaultCalories = 0) {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "additional-properties-test-"));
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubAiCalories(capabilities, defaultCalories);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    addRoutes(capabilities, app);
    return { app, capabilities, tmpDir };
}

/**
 * Creates a full Express app with routes AND initializes the incremental graph.
 */
async function makeInitializedApp(defaultCalories = 0) {
    const { app, capabilities, tmpDir } = await makeUninitializedApp(defaultCalories);
    await capabilities.interface.ensureInitialized();
    return { app, capabilities, tmpDir };
}

describe("GET /api/entries/:id/additional-properties", () => {
    describe("when incremental graph is not initialized", () => {
        it("returns 503", async () => {
            const { app, tmpDir } = await makeUninitializedApp();
            try {
                const res = await request(app)
                    .get("/api/entries/evt-1/additional-properties");
                expect(res.statusCode).toBe(503);
                expect(res.body).toMatchObject({ error: expect.any(String) });
            } finally {
                cleanup(tmpDir);
            }
        });
    });

    describe("when incremental graph is initialized", () => {
        it("returns empty object for an unknown entry id", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(100);
            try {
                await capabilities.interface.update([makeEvent("known-id", "food: a pizza")]);

                const res = await request(app)
                    .get("/api/entries/unknown-id/additional-properties");

                expect(res.statusCode).toBe(200);
                expect(res.body).toEqual({});
            } finally {
                cleanup(tmpDir);
            }
        });

        it("returns empty object when entry has no input text", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(0);
            try {
                await capabilities.interface.update([makeEvent("entry-1", "")]);

                const res = await request(app)
                    .get("/api/entries/entry-1/additional-properties");

                expect(res.statusCode).toBe(200);
                expect(res.body).toEqual({});
            } finally {
                cleanup(tmpDir);
            }
        });

        it("returns empty object when AI estimates 0 calories", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(0);
            try {
                await capabilities.interface.update([makeEvent("entry-1", "ran 5km")]);

                const res = await request(app)
                    .get("/api/entries/entry-1/additional-properties");

                expect(res.statusCode).toBe(200);
                expect(res.body).toEqual({});
            } finally {
                cleanup(tmpDir);
            }
        });

        it("returns { calories } when AI estimates non-zero calories", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(420);
            try {
                await capabilities.interface.update([makeEvent("entry-1", "food: had a big pasta")]);

                const res = await request(app)
                    .get("/api/entries/entry-1/additional-properties");

                expect(res.statusCode).toBe(200);
                expect(res.body).toEqual({ calories: 420 });
            } finally {
                cleanup(tmpDir);
            }
        });

        it("passes the entry input text to the AI estimator", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(300);
            try {
                const input = "food: two slices of toast with butter";
                await capabilities.interface.update([makeEvent("entry-2", input)]);

                await request(app)
                    .get("/api/entries/entry-2/additional-properties");

                expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(input);
            } finally {
                cleanup(tmpDir);
            }
        });

        it("uses cached value on repeated requests without re-calling AI", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(200);
            try {
                await capabilities.interface.update([makeEvent("entry-3", "food: a bowl of oatmeal")]);

                await request(app).get("/api/entries/entry-3/additional-properties");
                await request(app).get("/api/entries/entry-3/additional-properties");

                // AI should only have been called once due to graph caching
                expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledTimes(1);
            } finally {
                cleanup(tmpDir);
            }
        });

        it("returns correct calories for each of multiple entries independently", async () => {
            const { app, capabilities, tmpDir } = await makeInitializedApp(0);
            try {
                capabilities.aiCalories.estimateCalories
                    .mockResolvedValueOnce(150)
                    .mockResolvedValueOnce(500);

                await capabilities.interface.update([
                    makeEvent("entry-a", "food: an apple"),
                    makeEvent("entry-b", "food: a big burger"),
                ]);

                const resA = await request(app)
                    .get("/api/entries/entry-a/additional-properties");
                const resB = await request(app)
                    .get("/api/entries/entry-b/additional-properties");

                expect(resA.body).toEqual({ calories: 150 });
                expect(resB.body).toEqual({ calories: 500 });
            } finally {
                cleanup(tmpDir);
            }
        });
    });
});
