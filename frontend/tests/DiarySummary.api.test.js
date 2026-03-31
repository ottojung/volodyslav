import { act } from "@testing-library/react";

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

import { runDiarySummary } from "../src/DiarySummary/api.js";

function makeResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(data),
    };
}

/** @returns {import('../src/DiarySummary/api.js').DiarySummaryData} */
function makeSummaryData() {
    return {
        type: "diary_most_important_info_summary",
        markdown: "## Summary",
        summaryDate: "2024-03-01T00:00:00.000Z",
        processedTranscriptions: {},
        updatedAt: "2024-03-02T10:00:00.000Z",
        model: "gpt-5.4",
        version: "1",
    };
}

describe("runDiarySummary", () => {
    beforeEach(() => {
        global.fetch = jest.fn();
        jest.spyOn(global, "setTimeout").mockImplementation((callback) => {
            callback();
            return 0;
        });
    });

    afterEach(() => {
        jest.restoreAllMocks();
        delete global.fetch;
    });

    it("starts the pipeline once and polls until success", async () => {
        const summary = makeSummaryData();
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running", entries: [] }))
            .mockResolvedValueOnce(makeResponse(202, { status: "running", entries: [] }))
            .mockResolvedValueOnce(makeResponse(200, { status: "success", summary, entries: [] }));

        let result;
        await act(async () => {
            result = await runDiarySummary();
        });

        expect(result).toEqual({ success: true, summary, entries: [] });
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            "/api/diary-summary/run",
            expect.objectContaining({ method: "POST" })
        );
        expect(global.fetch).toHaveBeenNthCalledWith(2, "/api/diary-summary/run");
        expect(global.fetch).toHaveBeenNthCalledWith(3, "/api/diary-summary/run");
    });

    it("returns failure when the pipeline reports an error", async () => {
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running", entries: [] }))
            .mockResolvedValueOnce(makeResponse(500, { status: "error", error: "AI service unavailable", entries: [] }));

        let result;
        await act(async () => {
            result = await runDiarySummary();
        });

        expect(result).toEqual({
            success: false,
            error: "AI service unavailable",
            entries: [],
        });
    });

    it("calls onProgress with intermediate entries while running", async () => {
        const summary = makeSummaryData();
        const entries1 = [{ path: "assets/a.wav", status: "pending" }];
        const entries2 = [{ path: "assets/a.wav", status: "success" }];
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running", entries: entries1 }))
            .mockResolvedValueOnce(makeResponse(202, { status: "running", entries: entries1 }))
            .mockResolvedValueOnce(makeResponse(200, { status: "success", summary, entries: entries2 }));

        const onProgress = jest.fn();

        await act(async () => {
            await runDiarySummary(onProgress);
        });

        expect(onProgress).toHaveBeenCalledWith(entries1);
        expect(onProgress).toHaveBeenCalledTimes(2);
    });

    it("returns error result when the POST returns an unexpected status", async () => {
        global.fetch.mockResolvedValueOnce(makeResponse(503, { error: "Not ready" }));

        let result;
        await act(async () => {
            result = await runDiarySummary();
        });

        expect(result.success).toBe(false);
        expect(result.error).toContain("503");
    });

    it("returns error result on network failure", async () => {
        global.fetch.mockRejectedValueOnce(new Error("Network error"));

        let result;
        await act(async () => {
            result = await runDiarySummary();
        });

        expect(result.success).toBe(false);
        expect(result.error).toBe("Network error");
    });
});
