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

        expect(result).toEqual({ success: true, steps: undefined });
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
                name: "GeneratorsSyncError",
                message: "Generators database sync failed: git push failed",
                causes: ["git push failed"],
            },
        ];
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running" }))
            .mockResolvedValueOnce(makeResponse(500, {
                status: "error",
                error: {
                    message: "Sync failed: Generators database sync failed: git push failed",
                    details,
                },
            }));

        let result;
        await act(async () => {
            result = await postSync();
        });

        expect(result).toEqual({
            success: false,
            error: "Sync failed: Generators database sync failed: git push failed",
            details,
        });
    });

    it("returns steps from the final success response", async () => {
        const steps = [
            { name: "generators", status: "success" },
            { name: "assets", status: "success" },
        ];
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running", steps: [] }))
            .mockResolvedValueOnce(makeResponse(200, { status: "success", steps }));

        let result;
        await act(async () => {
            result = await postSync();
        });

        expect(result).toEqual({ success: true, steps });
    });

    it("returns steps from the final error response", async () => {
        const steps = [
            { name: "generators", status: "error" },
        ];
        const details = [
            {
                name: "GeneratorsSyncError",
                message: "Generators database sync failed",
                causes: ["db error"],
            },
        ];
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running", steps: [] }))
            .mockResolvedValueOnce(makeResponse(500, {
                status: "error",
                steps,
                error: {
                    message: "Sync failed: Generators database sync failed",
                    details,
                },
            }));

        let result;
        await act(async () => {
            result = await postSync();
        });

        expect(result).toEqual({
            success: false,
            error: "Sync failed: Generators database sync failed",
            details,
            steps,
        });
    });

    it("calls onProgress with intermediate steps while the sync is running", async () => {
        const intermediateSteps = [{ name: "generators", status: "success" }];
        global.fetch
            .mockResolvedValueOnce(makeResponse(202, { status: "running", steps: intermediateSteps }))
            .mockResolvedValueOnce(makeResponse(202, { status: "running", steps: intermediateSteps }))
            .mockResolvedValueOnce(makeResponse(200, { status: "success", steps: [...intermediateSteps, { name: "assets", status: "success" }] }));

        const onProgress = jest.fn();

        await act(async () => {
            await postSync(undefined, onProgress);
        });

        expect(onProgress).toHaveBeenCalledWith(intermediateSteps);
        expect(onProgress).toHaveBeenCalledTimes(2);
    });
});
