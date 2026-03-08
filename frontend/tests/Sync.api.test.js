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

import { postSync } from "../src/Sync/api.js";

function makeResponse(status, data) {
    return {
        ok: status >= 200 && status < 300,
        status,
        json: () => Promise.resolve(data),
    };
}

describe("postSync", () => {
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

    it("starts sync once and polls until the backend reports success", async () => {
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running" }))
            .mockResolvedValueOnce(makeResponse(202, { status: "running" }))
            .mockResolvedValueOnce(makeResponse(200, { status: "success" }));

        let result;
        await act(async () => {
            result = await postSync(true);
        });

        expect(result).toEqual({ success: true });
        expect(global.fetch).toHaveBeenNthCalledWith(
            1,
            "/api/sync",
            expect.objectContaining({
                method: "POST",
                body: JSON.stringify({ reset_to_theirs: true }),
            })
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            2,
            "/api/sync"
        );
        expect(global.fetch).toHaveBeenNthCalledWith(
            3,
            "/api/sync"
        );
    });

    it("returns detailed error information from the polled sync status", async () => {
        const details = [
            {
                name: "EventLogSyncError",
                message: "Event log sync failed: git push failed",
                causes: ["git push failed"],
            },
        ];
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running" }))
            .mockResolvedValueOnce(makeResponse(500, {
                status: "error",
                error: {
                    message: "Sync failed: Event log sync failed: git push failed",
                    details,
                },
            }));

        let result;
        await act(async () => {
            result = await postSync();
        });

        expect(result).toEqual({
            success: false,
            error: "Sync failed: Event log sync failed: git push failed",
            details,
        });
    });
});
