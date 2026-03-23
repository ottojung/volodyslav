/**
 * Integration tests for POST /api/entries with audio file attachments.
 *
 * These tests cover the diary audio recording submission path that was
 * previously broken: the frontend was sending multipart FormData but the
 * backend needed to correctly parse the rawInput field and file attachment.
 *
 * Regression: desktop Chrome records audio as audio/webm while Android Chrome
 * may record as audio/mp4.  Both must produce a 201 and persist an entry.
 */

const request = require("supertest");
const expressApp = require("../src/express_app");
const { addRoutes } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubEventLogRepository,
} = require("./stubs");
const { getType, getModifiers } = require("../src/event");
const fs = require("fs");
const path = require("path");
const os = require("os");

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

/**
 * Creates a temporary file with the given content and name, invokes the
 * provided callback, then removes the file.
 *
 * @param {string} name - Filename (e.g. "diary-recording.webm")
 * @param {string|Buffer} content - File content
 * @param {(filePath: string) => Promise<void>} fn - Async callback
 */
async function withTempFile(name, content, fn) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "audio-entry-test-"));
    const filePath = path.join(dir, name);
    fs.writeFileSync(filePath, content);
    try {
        await fn(filePath);
    } finally {
        try { fs.unlinkSync(filePath); } catch (_) { /* ignore */ }
        try { fs.rmdirSync(dir); } catch (_) { /* ignore */ }
    }
}

describe("POST /api/entries – audio diary recording (multipart FormData)", () => {
    it("creates a diary entry with webm audio file (desktop Chrome scenario)", async () => {
        const { app, capabilities } = await makeTestApp();

        await withTempFile(
            "diary-recording.webm",
            Buffer.from("fake-webm-audio-content"),
            async (filePath) => {
                const res = await request(app)
                    .post("/api/entries")
                    .field("rawInput", "diary [audiorecording]")
                    .attach("files", filePath, {
                        contentType: "audio/webm",
                    });

                expect(res.statusCode).toBe(201);
                expect(res.body.success).toBe(true);
                expect(getType(res.body.entry)).toBe("diary");
                expect(getModifiers(res.body.entry)).toMatchObject({
                    audiorecording: "",
                });
                expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                    expect.objectContaining({ type: "diary", fileCount: 1 }),
                    expect.stringContaining("Entry created")
                );
            }
        );
    });

    it("creates a diary entry with mp4 audio file (Android Chrome scenario)", async () => {
        const { app } = await makeTestApp();

        await withTempFile(
            "diary-recording.mp4",
            Buffer.from("fake-mp4-audio-content"),
            async (filePath) => {
                const res = await request(app)
                    .post("/api/entries")
                    .field("rawInput", "diary [audiorecording]")
                    .attach("files", filePath, {
                        contentType: "audio/mp4",
                    });

                expect(res.statusCode).toBe(201);
                expect(res.body.success).toBe(true);
                expect(getType(res.body.entry)).toBe("diary");
                expect(getModifiers(res.body.entry)).toMatchObject({
                    audiorecording: "",
                });
            }
        );
    });

    it("creates a diary entry with ogg audio file (Firefox scenario)", async () => {
        const { app } = await makeTestApp();

        await withTempFile(
            "diary-recording.ogg",
            Buffer.from("fake-ogg-audio-content"),
            async (filePath) => {
                const res = await request(app)
                    .post("/api/entries")
                    .field("rawInput", "diary [audiorecording]")
                    .attach("files", filePath, {
                        contentType: "audio/ogg",
                    });

                expect(res.statusCode).toBe(201);
                expect(res.body.success).toBe(true);
                expect(getType(res.body.entry)).toBe("diary");
            }
        );
    });

    it("creates a diary entry with note text and audio file", async () => {
        const { app } = await makeTestApp();

        await withTempFile(
            "diary-recording.webm",
            Buffer.from("fake-webm-content"),
            async (filePath) => {
                const res = await request(app)
                    .post("/api/entries")
                    .field("rawInput", "diary [audiorecording] morning reflection")
                    .attach("files", filePath, {
                        contentType: "audio/webm",
                    });

                expect(res.statusCode).toBe(201);
                expect(res.body.success).toBe(true);
                expect(getType(res.body.entry)).toBe("diary");
            }
        );
    });

    it("creates a diary entry without audio file (text-only diary)", async () => {
        const { app } = await makeTestApp();

        const res = await request(app)
            .post("/api/entries")
            .send({ rawInput: "diary [audiorecording] written note only" })
            .set("Content-Type", "application/json");

        expect(res.statusCode).toBe(201);
        expect(res.body.success).toBe(true);
        expect(getType(res.body.entry)).toBe("diary");
    });

    it("returns 400 when rawInput is missing in multipart request", async () => {
        const { app } = await makeTestApp();

        await withTempFile(
            "diary-recording.webm",
            Buffer.from("fake-content"),
            async (filePath) => {
                const res = await request(app)
                    .post("/api/entries")
                    .attach("files", filePath);

                expect(res.statusCode).toBe(400);
                expect(res.body.error).toContain("Missing required field: rawInput");
            }
        );
    });

    it("creates an entry with photo attachment (describe page with photos scenario)", async () => {
        const { app, capabilities } = await makeTestApp();

        await withTempFile(
            "photo.jpg",
            Buffer.from("fake-jpeg-content"),
            async (filePath) => {
                const res = await request(app)
                    .post("/api/entries")
                    .field("rawInput", "food [certainty 9] pizza with photos")
                    .attach("files", filePath, {
                        contentType: "image/jpeg",
                    });

                expect(res.statusCode).toBe(201);
                expect(res.body.success).toBe(true);
                expect(getType(res.body.entry)).toBe("food");
                expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                    expect.objectContaining({ type: "food", fileCount: 1 }),
                    expect.stringContaining("Entry created")
                );
            }
        );
    });

    it("creates an entry with multiple photo attachments", async () => {
        const { app, capabilities } = await makeTestApp();

        const dir = fs.mkdtempSync(path.join(os.tmpdir(), "multi-photo-test-"));
        const file1 = path.join(dir, "photo1.jpg");
        const file2 = path.join(dir, "photo2.jpg");
        fs.writeFileSync(file1, "fake-jpeg-1");
        fs.writeFileSync(file2, "fake-jpeg-2");

        try {
            const res = await request(app)
                .post("/api/entries")
                .field("rawInput", "social [with friends] dinner photos")
                .attach("files", file1, { contentType: "image/jpeg" })
                .attach("files", file2, { contentType: "image/jpeg" });

            expect(res.statusCode).toBe(201);
            expect(res.body.success).toBe(true);
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ fileCount: 2 }),
                expect.stringContaining("Entry created")
            );
        } finally {
            try { fs.unlinkSync(file1); } catch (_) { /* ignore */ }
            try { fs.unlinkSync(file2); } catch (_) { /* ignore */ }
            try { fs.rmdirSync(dir); } catch (_) { /* ignore */ }
        }
    });
});
