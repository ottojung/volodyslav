/**
 * Tests for GET /api/entries/:id/additional-properties
 */

const path = require("path");
const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const event = require("../src/event");
const eventId = require("../src/event/id");
const { fromISOString } = require("../src/datetime");
const { transaction } = require("../src/event_log_storage");
const { makeFromExistingFile } = require("../src/filesystem/file_ref");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubAiCalories,
    stubAiTranscriber,
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
        creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0", hostname: "test-host" },
    };
}

/**
 * Builds a minimal diary event for testing.
 * @param {string} id
 */
function makeDiaryEvent(id) {
    return {
        id: eventId.fromString(id),
        type: "diary",
        description: "",
        date: fromISOString("2024-01-01T00:00:00.000Z"),
        original: "diary [when 0 hours ago] [audiorecording]",
        input: "diary [when 0 hours ago] [audiorecording]",
        modifiers: { when: "0 hours ago", audiorecording: "" },
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
        for (const entry of events) {
            storage.addEntry(entry, []);
        }
    });
}

/**
 * Writes a diary event with attached audio asset files and updates the store.
 * @param {object} capabilities
 * @param {string} entryId
 * @param {Array<string>} filenames
 */
async function writeDiaryEventWithAudioAssets(capabilities, entryId, filenames) {
    const diaryEvent = makeDiaryEvent(entryId);
    const tmpDir = await capabilities.creator.createTemporaryDirectory();
    const assets = [];

    for (const filename of filenames) {
        const sourcePath = path.join(tmpDir, filename);
        const sourceFile = await capabilities.creator.createFile(sourcePath);
        await capabilities.writer.writeFile(sourceFile, "fake audio");
        assets.push(event.asset.make(diaryEvent, makeFromExistingFile(sourceFile)));
    }

    await transaction(capabilities, async (storage) => {
        storage.addEntry(diaryEvent, assets);
    });
}

/**
 * Creates a full Express app with routes, but does NOT initialize the interface.
 */
async function makeUninitializedApp(defaultCalories = "N/A") {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubAiCalories(capabilities, defaultCalories);
    stubAiTranscriber(capabilities);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return { app, capabilities };
}

/**
 * Creates a full Express app with routes AND initializes the incremental graph.
 */
async function makeInitializedApp(defaultCalories = "N/A") {
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

            const res = await request(app)
                .get("/api/entries/unknown-id/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({});
        });

        it("returns empty object when entry has no input text", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "")]);

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).not.toHaveProperty("calories");
            expect(res.body).not.toHaveProperty("transcription");
        });

        it("returns empty object for a non-food entry", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "ran 5km")]);

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).not.toHaveProperty("calories");
            expect(res.body).not.toHaveProperty("transcription");
        });

        it("returns { calories: 0 } for a 0-calorie food entry", async () => {
            const { app, capabilities } = await makeInitializedApp(0);

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "a cup of plain tea")]);

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ calories: 0 });
        });

        it("returns { calories } when AI estimates non-zero calories", async () => {
            const { app, capabilities } = await makeInitializedApp(420);

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "food: had a big pasta")]);

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ calories: 420 });
        });

        it("returns only the requested calories property", async () => {
            const { app, capabilities } = await makeInitializedApp(300);

            await writeDiaryEventWithAudioAssets(capabilities, "diary-calories", ["memo.mp3"]);

            const res = await request(app)
                .get("/api/entries/diary-calories/additional-properties?property=calories");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ calories: 300 });
            expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
        });

        it("passes the target event and raw basic context to the AI estimator", async () => {
            const { app, capabilities } = await makeInitializedApp(300);
            const input = "food: two slices of toast with butter";
            const entry = makeEvent("entry-2", input);

            await writeEventsToStore(capabilities, [entry]);

            await request(app)
                .get("/api/entries/entry-2/additional-properties");

            expect(capabilities.aiCalories.estimateCalories).toHaveBeenCalledWith(
                expect.objectContaining({ id: "entry-2", input }),
                [expect.objectContaining({ id: "entry-2", input })]
            );
        });

        it("uses cached value on repeated requests without re-calling AI", async () => {
            const { app, capabilities } = await makeInitializedApp(200);

            await writeEventsToStore(capabilities, [makeEvent("entry-3", "food: a bowl of oatmeal")]);

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

            const resA = await request(app)
                .get("/api/entries/entry-a/additional-properties");
            const resB = await request(app)
                .get("/api/entries/entry-b/additional-properties");

            expect(resA.body).toMatchObject({ calories: 150 });
            expect(resB.body).toMatchObject({ calories: 500 });
        });

        it("returns no calories or transcription for entry with no audio assets", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [makeEvent("entry-1", "ran 5km")]);

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).not.toHaveProperty("calories");
            expect(res.body).not.toHaveProperty("transcription");
            expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
        });

        it("returns { transcription } for a diary entry with an audio asset", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeDiaryEventWithAudioAssets(capabilities, "diary-1", ["memo.mp3"]);

            const res = await request(app)
                .get("/api/entries/diary-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({ transcription: "mocked transcription result" });
            expect(capabilities.aiTranscription.transcribeStream).toHaveBeenCalledTimes(1);
        });

        it("returns only the requested transcription property", async () => {
            const { app, capabilities } = await makeInitializedApp(300);

            await writeDiaryEventWithAudioAssets(capabilities, "diary-transcription", ["memo.mp3"]);

            const res = await request(app)
                .get("/api/entries/diary-transcription/additional-properties?property=transcription");

            expect(res.statusCode).toBe(200);
            expect(res.body).toEqual({ transcription: "mocked transcription result" });
            expect(capabilities.aiCalories.estimateCalories).not.toHaveBeenCalled();
        });

        it("returns transcription from the first audio asset only", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeDiaryEventWithAudioAssets(capabilities, "diary-2", ["first.mp3", "second.mp3"]);

            const res = await request(app)
                .get("/api/entries/diary-2/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body.transcription).toBe("mocked transcription result");
        });

        it("ignores non-audio assets when looking for transcription", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            const diaryEvent = makeDiaryEvent("diary-3");
            const tmpDir = await capabilities.creator.createTemporaryDirectory();
            const imgPath = path.join(tmpDir, "photo.jpg");
            const imgFile = await capabilities.creator.createFile(imgPath);
            await capabilities.writer.writeFile(imgFile, "fake image");
            const assets = [event.asset.make(diaryEvent, makeFromExistingFile(imgFile))];

            await transaction(capabilities, async (storage) => {
                storage.addEntry(diaryEvent, assets);
            });

            const res = await request(app)
                .get("/api/entries/diary-3/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).not.toHaveProperty("transcription");
            expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
        });

        it("uses cached transcription on repeated requests", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeDiaryEventWithAudioAssets(capabilities, "diary-4", ["memo.mp3"]);

            await request(app).get("/api/entries/diary-4/additional-properties");
            await request(app).get("/api/entries/diary-4/additional-properties");

            expect(capabilities.aiTranscription.transcribeStream).toHaveBeenCalledTimes(1);
        });

        it("returns both calories and transcription when both are available", async () => {
            const { app, capabilities } = await makeInitializedApp(300);

            await writeDiaryEventWithAudioAssets(capabilities, "diary-5", ["memo.mp3"]);

            const res = await request(app)
                .get("/api/entries/diary-5/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                calories: 300,
                transcription: "mocked transcription result",
            });
        });

        it("returns 400 for an invalid requested additional property", async () => {
            const { app } = await makeInitializedApp("N/A");

            const res = await request(app)
                .get("/api/entries/entry-1/additional-properties?property=unknown");

            expect(res.statusCode).toBe(400);
            expect(res.body).toEqual({ error: "Invalid additional property" });
        });

        it("includes transcription error in response when transcription AI fails", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeDiaryEventWithAudioAssets(capabilities, "diary-error", ["memo.mp3"]);

            // Override the stub to simulate AI failure after graph invalidation
            capabilities.aiTranscription.transcribeStream.mockRejectedValue(
                new Error("AI transcription service unavailable"),
            );

            const res = await request(app)
                .get("/api/entries/diary-error/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                errors: {
                    transcription: expect.any(String),
                },
            });
            expect(res.body.transcription).toBeUndefined();
        });

        it("includes calories error in response when calories AI fails", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [makeEvent("entry-calories-error", "food: a pizza")]);

            // Override the stub to simulate AI failure after graph invalidation
            capabilities.aiCalories.estimateCalories.mockRejectedValue(
                new Error("AI calories service unavailable"),
            );

            const res = await request(app)
                .get("/api/entries/entry-calories-error/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                errors: {
                    calories: expect.any(String),
                },
            });
            expect(res.body.calories).toBeUndefined();
        });

        it("includes errors for all failed properties and values for successful ones", async () => {
            const { app, capabilities } = await makeInitializedApp(420);

            await writeDiaryEventWithAudioAssets(capabilities, "diary-mixed", ["memo.mp3"]);

            // Calories should succeed (returns 420), transcription should fail
            capabilities.aiTranscription.transcribeStream.mockRejectedValue(
                new Error("AI transcription service unavailable"),
            );

            const res = await request(app)
                .get("/api/entries/diary-mixed/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toMatchObject({
                calories: 420,
                errors: {
                    transcription: expect.any(String),
                },
            });
            expect(res.body.transcription).toBeUndefined();
        });

        it("returns { basic_context } containing the event's own input", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [makeEvent("entry-ctx-1", "ran 5km")]);

            const res = await request(app)
                .get("/api/entries/entry-ctx-1/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty("basic_context");
            expect(res.body.basic_context).toContain("ran 5km");
        });

        it("returns only the requested basic_context property", async () => {
            const { app, capabilities } = await makeInitializedApp(300);

            await writeEventsToStore(capabilities, [makeEvent("entry-ctx-2", "ran 5km")]);

            const res = await request(app)
                .get("/api/entries/entry-ctx-2/additional-properties?property=basic_context");

            expect(res.statusCode).toBe(200);
            expect(res.body).toHaveProperty("basic_context");
            expect(res.body.basic_context).toContain("ran 5km");
            expect(capabilities.aiCalories.estimateCalories).not.toHaveBeenCalled();
            expect(capabilities.aiTranscription.transcribeStream).not.toHaveBeenCalled();
        });

        it("returns basic_context with all related event inputs sharing a hashtag", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [
                makeEvent("ctx-a", "text went to the gym #fitness"),
                makeEvent("ctx-b", "text ran 10km #fitness"),
                makeEvent("ctx-c", "text had a pizza"),
            ]);

            const res = await request(app)
                .get("/api/entries/ctx-a/additional-properties?property=basic_context");

            expect(res.statusCode).toBe(200);
            expect(res.body.basic_context).toContain("text went to the gym #fitness");
            expect(res.body.basic_context).toContain("text ran 10km #fitness");
            expect(res.body.basic_context).not.toContain("text had a pizza");
        });

        it("does not return basic_context for an unknown entry id", async () => {
            const { app, capabilities } = await makeInitializedApp("N/A");

            await writeEventsToStore(capabilities, [makeEvent("known-id-ctx", "some event")]);

            const res = await request(app)
                .get("/api/entries/unknown-id-ctx/additional-properties");

            expect(res.statusCode).toBe(200);
            expect(res.body).not.toHaveProperty("basic_context");
        });
    });
});
