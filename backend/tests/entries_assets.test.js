/**
 * Tests for GET /api/entries/:id/assets
 */

const request = require("supertest");
const path = require("path");
const fs = require("fs").promises;
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
    stubEventLogRepository,
} = require("./stubs");

/**
 * Builds a minimal well-formed event for testing.
 * @param {string} id
 * @param {string} [dateStr]
 */
function makeEvent(id, dateStr = "2024-01-15T10:00:00.000Z") {
    return {
        id: eventId.fromString(id),
        type: "text",
        description: "test description",
        date: fromISOString(dateStr),
        original: "text - test description",
        input: "text - test description",
        modifiers: {},
        creator: { name: "test", uuid: "00000000-0000-0000-0000-000000000001", version: "0.0.0" },
    };
}

/**
 * Writes events to the event log store via a transaction.
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
 * Creates a full Express app with routes.
 */
async function makeTestApp() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    await stubEventLogRepository(capabilities);
    const app = expressApp.make();
    capabilities.logger.enableHttpCallsLogging(app);
    await addRoutes(capabilities, app);
    return { app, capabilities };
}

describe("GET /api/entries/:id/assets", () => {
    it("returns 400 for empty entry id", async () => {
        const { app } = await makeTestApp();
        // Express routing won't match an empty :id, but test validation logic via a trimmed space
        const res = await request(app).get("/api/entries/%20/assets");
        expect(res.statusCode).toBe(400);
    });

    it("returns empty assets when the entry does not exist", async () => {
        const { app } = await makeTestApp();
        const res = await request(app).get("/api/entries/nonexistent-id/assets");
        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ assets: [] });
    });

    it("returns empty assets array when entry has no associated files", async () => {
        const { app, capabilities } = await makeTestApp();

        const event = makeEvent("entry-no-assets");
        await writeEventsToStore(capabilities, [event]);

        const res = await request(app).get("/api/entries/entry-no-assets/assets");

        expect(res.statusCode).toBe(200);
        expect(res.body).toEqual({ assets: [] });
    });

    it("returns image assets when entry has associated image files", async () => {
        const { app, capabilities } = await makeTestApp();

        const event = makeEvent("entry-with-images", "2024-01-15T10:00:00.000Z");
        await writeEventsToStore(capabilities, [event]);

        // Create the assets directory and a test image file
        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const entryAssetsDir = path.join(assetsDir, "2024-01", "15", "entry-with-images");
        await fs.mkdir(entryAssetsDir, { recursive: true });
        await fs.writeFile(path.join(entryAssetsDir, "photo.jpg"), "fake image content");

        const res = await request(app).get("/api/entries/entry-with-images/assets");

        expect(res.statusCode).toBe(200);
        expect(res.body.assets).toHaveLength(1);
        expect(res.body.assets[0]).toMatchObject({
            filename: "photo.jpg",
            url: expect.stringContaining("photo.jpg"),
            mediaType: "image",
        });
    });

    it("returns audio assets when entry has associated audio files", async () => {
        const { app, capabilities } = await makeTestApp();

        const event = makeEvent("entry-with-audio", "2024-03-20T12:00:00.000Z");
        await writeEventsToStore(capabilities, [event]);

        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const entryAssetsDir = path.join(assetsDir, "2024-03", "20", "entry-with-audio");
        await fs.mkdir(entryAssetsDir, { recursive: true });
        await fs.writeFile(path.join(entryAssetsDir, "recording.m4a"), "fake audio content");

        const res = await request(app).get("/api/entries/entry-with-audio/assets");

        expect(res.statusCode).toBe(200);
        expect(res.body.assets).toHaveLength(1);
        expect(res.body.assets[0]).toMatchObject({
            filename: "recording.m4a",
            url: expect.stringContaining("recording.m4a"),
            mediaType: "audio",
        });
    });

    it("returns multiple assets of different types", async () => {
        const { app, capabilities } = await makeTestApp();

        const event = makeEvent("entry-mixed-assets", "2024-06-10T08:00:00.000Z");
        await writeEventsToStore(capabilities, [event]);

        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const entryAssetsDir = path.join(assetsDir, "2024-06", "10", "entry-mixed-assets");
        await fs.mkdir(entryAssetsDir, { recursive: true });
        await fs.writeFile(path.join(entryAssetsDir, "photo.png"), "fake image content");
        await fs.writeFile(path.join(entryAssetsDir, "audio.mp3"), "fake audio content");

        const res = await request(app).get("/api/entries/entry-mixed-assets/assets");

        expect(res.statusCode).toBe(200);
        expect(res.body.assets).toHaveLength(2);

        const filenames = res.body.assets.map((a) => a.filename);
        expect(filenames).toContain("photo.png");
        expect(filenames).toContain("audio.mp3");

        const imageAsset = res.body.assets.find((a) => a.filename === "photo.png");
        const audioAsset = res.body.assets.find((a) => a.filename === "audio.mp3");
        expect(imageAsset.mediaType).toBe("image");
        expect(audioAsset.mediaType).toBe("audio");
    });

    it("returns asset URLs that begin with /assets/", async () => {
        const { app, capabilities } = await makeTestApp();

        const event = makeEvent("entry-url-check", "2024-02-28T00:00:00.000Z");
        await writeEventsToStore(capabilities, [event]);

        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const entryAssetsDir = path.join(assetsDir, "2024-02", "28", "entry-url-check");
        await fs.mkdir(entryAssetsDir, { recursive: true });
        await fs.writeFile(path.join(entryAssetsDir, "image.jpg"), "fake image");

        const res = await request(app).get("/api/entries/entry-url-check/assets");

        expect(res.statusCode).toBe(200);
        expect(res.body.assets[0].url).toMatch(/^\/assets\//);
    });

    it("asset URL includes year-month/day/entryId structure", async () => {
        const { app, capabilities } = await makeTestApp();

        const event = makeEvent("entry-url-structure", "2024-11-05T00:00:00.000Z");
        await writeEventsToStore(capabilities, [event]);

        const assetsDir = capabilities.environment.eventLogAssetsDirectory();
        const entryAssetsDir = path.join(assetsDir, "2024-11", "05", "entry-url-structure");
        await fs.mkdir(entryAssetsDir, { recursive: true });
        await fs.writeFile(path.join(entryAssetsDir, "file.jpg"), "fake image");

        const res = await request(app).get("/api/entries/entry-url-structure/assets");

        expect(res.statusCode).toBe(200);
        expect(res.body.assets[0].url).toBe("/assets/2024-11/05/entry-url-structure/file.jpg");
    });
});
