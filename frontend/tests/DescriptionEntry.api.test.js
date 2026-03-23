jest.mock("../src/DescriptionEntry/logger.js", () => ({
    logger: {
        error: jest.fn(),
        warn: jest.fn(),
        info: jest.fn(),
        debug: jest.fn(),
    },
}));

jest.mock("../src/api_base_url.js", () => ({
    API_BASE_URL: "/api",
}));

import {
    submitEntry,
    fetchConfig,
    updateConfig,
    triggerLastEntriesPrefetch,
} from "../src/DescriptionEntry/api.js";

function makeResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        statusText: status === 201 ? "Created" : "Error",
        json: () => Promise.resolve(data),
    };
}

describe("submitEntry", () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    describe("without files", () => {
        it("sends a POST to /api/entries with JSON body", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            await submitEntry("food pizza");

            expect(global.fetch).toHaveBeenCalledWith(
                "/api/entries",
                expect.objectContaining({
                    method: "POST",
                    headers: expect.objectContaining({
                        "Content-Type": "application/json",
                    }),
                    body: JSON.stringify({ rawInput: "food pizza" }),
                })
            );
        });

        it("includes request_identifier query param when provided", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            await submitEntry("food pizza", "req-123");

            expect(global.fetch).toHaveBeenCalledWith(
                "/api/entries?request_identifier=req-123",
                expect.objectContaining({ method: "POST" })
            );
        });

        it("does not include request_identifier when undefined", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            await submitEntry("food pizza", undefined);

            expect(global.fetch).toHaveBeenCalledWith(
                "/api/entries",
                expect.anything()
            );
        });

        it("returns the result on 201 success", async () => {
            const entry = { id: "abc-123", date: "2025-01-01" };
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry })
            );

            const result = await submitEntry("food pizza");

            expect(result.success).toBe(true);
            expect(result.entry).toEqual(entry);
        });

        it("throws EntrySubmissionError on HTTP 500", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(500, { error: "Internal server error" })
            );

            await expect(submitEntry("food pizza")).rejects.toMatchObject({
                name: "EntrySubmissionError",
            });
        });

        it("throws EntrySubmissionError on HTTP 400", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(400, { error: "Missing required field: rawInput" })
            );

            await expect(submitEntry("")).rejects.toMatchObject({
                name: "EntrySubmissionError",
            });
        });

        it("throws EntrySubmissionError on network failure", async () => {
            global.fetch.mockRejectedValueOnce(
                new TypeError("fetch failed")
            );

            await expect(submitEntry("food pizza")).rejects.toMatchObject({
                name: "EntrySubmissionError",
            });
        });
    });

    describe("with files", () => {
        it("sends a POST to /api/entries with FormData body", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            const file = new File(["audio data"], "diary-recording.webm", {
                type: "audio/webm",
            });

            await submitEntry("diary [audiorecording]", undefined, [file]);

            expect(global.fetch).toHaveBeenCalledWith(
                "/api/entries",
                expect.objectContaining({ method: "POST" })
            );
            const [, options] = global.fetch.mock.calls[0];
            expect(options.body).toBeInstanceOf(FormData);
        });

        it("does not set Content-Type header for FormData (browser sets boundary)", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            const file = new File(["img"], "photo.jpeg", { type: "image/jpeg" });

            await submitEntry("food [photo] pizza", undefined, [file]);

            const [, options] = global.fetch.mock.calls[0];
            expect(options.headers).toBeUndefined();
        });

        it("puts rawInput in the FormData under field 'rawInput'", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            const file = new File(["audio"], "recording.webm", {
                type: "audio/webm",
            });

            await submitEntry("diary [audiorecording] morning", undefined, [file]);

            const [, options] = global.fetch.mock.calls[0];
            expect(options.body).toBeInstanceOf(FormData);
            expect(options.body.get("rawInput")).toBe(
                "diary [audiorecording] morning"
            );
        });

        it("puts uploaded files in FormData under field 'files'", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            const file = new File(["audio"], "diary-recording.webm", {
                type: "audio/webm",
            });

            await submitEntry("diary [audiorecording]", undefined, [file]);

            const [, options] = global.fetch.mock.calls[0];
            expect(options.body).toBeInstanceOf(FormData);
            const uploadedFiles = options.body.getAll("files");
            expect(uploadedFiles).toHaveLength(1);
            expect(uploadedFiles[0]).toBeInstanceOf(File);
            expect(uploadedFiles[0].name).toBe("diary-recording.webm");
        });

        it("appends multiple files under the 'files' field", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            const file1 = new File(["img1"], "photo_01.jpeg", {
                type: "image/jpeg",
            });
            const file2 = new File(["img2"], "photo_02.jpeg", {
                type: "image/jpeg",
            });

            await submitEntry("food pizza", "req-abc", [file1, file2]);

            const [, options] = global.fetch.mock.calls[0];
            expect(options.body).toBeInstanceOf(FormData);
            const uploadedFiles = options.body.getAll("files");
            expect(uploadedFiles).toHaveLength(2);
            expect(uploadedFiles[0].name).toBe("photo_01.jpeg");
            expect(uploadedFiles[1].name).toBe("photo_02.jpeg");
        });

        it("includes request_identifier query param in FormData request", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            const file = new File(["img"], "photo.jpeg", { type: "image/jpeg" });

            await submitEntry("food pizza", "photo-req-999", [file]);

            expect(global.fetch).toHaveBeenCalledWith(
                "/api/entries?request_identifier=photo-req-999",
                expect.objectContaining({ method: "POST" })
            );
        });

        it("returns the result on 201 success with files", async () => {
            const entry = { id: "xyz-789", date: "2025-06-15" };
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry })
            );

            const file = new File(["audio"], "diary-recording.webm", {
                type: "audio/webm",
            });
            const result = await submitEntry(
                "diary [audiorecording]",
                undefined,
                [file]
            );

            expect(result.success).toBe(true);
            expect(result.entry).toEqual(entry);
        });

        it("throws EntrySubmissionError on HTTP 500 during file upload", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(500, { error: "Internal server error" })
            );

            const file = new File(["audio"], "recording.webm", {
                type: "audio/webm",
            });

            await expect(
                submitEntry("diary [audiorecording]", undefined, [file])
            ).rejects.toMatchObject({ name: "EntrySubmissionError" });
        });
    });

    describe("empty files array behaves like no files", () => {
        it("sends JSON when files array is empty", async () => {
            global.fetch.mockResolvedValueOnce(
                makeResponse(201, { success: true, entry: { id: "abc" } })
            );

            await submitEntry("work [loc home] Remote day", undefined, []);

            const [, options] = global.fetch.mock.calls[0];
            expect(options.headers).toEqual(
                expect.objectContaining({ "Content-Type": "application/json" })
            );
            expect(options.body).toBe(
                JSON.stringify({ rawInput: "work [loc home] Remote day" })
            );
        });
    });
});

describe("triggerLastEntriesPrefetch", () => {
    beforeEach(() => {
        global.fetch = jest.fn().mockResolvedValue({ ok: true });
    });

    afterEach(() => {
        delete global.fetch;
    });

    it("sends a POST to the last_entries graph node URL", () => {
        triggerLastEntriesPrefetch();

        expect(global.fetch).toHaveBeenCalledWith(
            expect.stringContaining("/api/graph/nodes/last_entries/"),
            expect.objectContaining({ method: "POST" })
        );
    });
});

describe("fetchConfig", () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    it("returns config on success", async () => {
        const config = { help: "help text", shortcuts: [] };
        global.fetch.mockResolvedValueOnce(
            makeResponse(200, { config })
        );

        const result = await fetchConfig();

        expect(result).toEqual(config);
        expect(global.fetch).toHaveBeenCalledWith("/api/config");
    });

    it("returns null when the request fails", async () => {
        global.fetch.mockResolvedValueOnce(makeResponse(500, {}));

        const result = await fetchConfig();

        expect(result).toBeNull();
    });

    it("returns null on network error", async () => {
        global.fetch.mockRejectedValueOnce(new Error("Network error"));

        const result = await fetchConfig();

        expect(result).toBeNull();
    });
});

describe("updateConfig", () => {
    beforeEach(() => {
        global.fetch = jest.fn();
    });

    afterEach(() => {
        delete global.fetch;
    });

    it("PUTs the config as JSON and returns the saved config", async () => {
        const config = { help: "help text", shortcuts: [["a", "b"]] };
        global.fetch.mockResolvedValueOnce(
            makeResponse(200, { config })
        );

        const result = await updateConfig(config);

        expect(result).toEqual(config);
        expect(global.fetch).toHaveBeenCalledWith(
            "/api/config",
            expect.objectContaining({
                method: "PUT",
                headers: expect.objectContaining({
                    "Content-Type": "application/json",
                }),
                body: JSON.stringify(config),
            })
        );
    });

    it("returns null when the request fails", async () => {
        global.fetch.mockResolvedValueOnce(makeResponse(500, {}));

        const result = await updateConfig({ help: "", shortcuts: [] });

        expect(result).toBeNull();
    });
});
