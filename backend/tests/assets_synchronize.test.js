/**
 * Tests for assets/synchronize.js
 */

const { synchronize, isAssetsSynchronizationError } = require("../src/assets/synchronize");

function makeCapabilities({ rsyncCall } = {}) {
    return {
        rsync: {
            call: jest.fn().mockImplementation(rsyncCall || (() => Promise.resolve())),
        },
        environment: {
            eventLogAssetsDirectory: jest.fn().mockReturnValue("/local/assets"),
            eventLogAssetsRepository: jest.fn().mockReturnValue("/remote/assets"),
        },
        logger: {
            logInfo: jest.fn(),
            logError: jest.fn(),
        },
    };
}

describe("assets/synchronize", () => {
    test("calls rsync exactly twice per synchronize() invocation", async () => {
        const capabilities = makeCapabilities();

        await synchronize(capabilities);

        expect(capabilities.rsync.call).toHaveBeenCalledTimes(2);
    });

    test("first call is pull (remote → local) with correct arguments", async () => {
        const capabilities = makeCapabilities();

        await synchronize(capabilities);

        const firstCall = capabilities.rsync.call.mock.calls[0];
        expect(firstCall).toEqual([
            "--recursive",
            "--partial",
            "--",
            "/remote/assets/",
            "/local/assets/",
        ]);
    });

    test("second call is push (local → remote) with correct arguments", async () => {
        const capabilities = makeCapabilities();

        await synchronize(capabilities);

        const secondCall = capabilities.rsync.call.mock.calls[1];
        expect(secondCall).toEqual([
            "--recursive",
            "--partial",
            "--",
            "/local/assets/",
            "/remote/assets/",
        ]);
    });

    test("pull invocation happens before push invocation", async () => {
        const order = [];
        const capabilities = makeCapabilities({
            rsyncCall: (...args) => {
                order.push(args[3]); // source is 4th arg (index 3)
                return Promise.resolve();
            },
        });

        await synchronize(capabilities);

        expect(order[0]).toBe("/remote/assets/"); // pull source is remote
        expect(order[1]).toBe("/local/assets/");  // push source is local
    });

    test("trailing slashes are present on both source and destination", async () => {
        const capabilities = makeCapabilities();

        await synchronize(capabilities);

        for (const callArgs of capabilities.rsync.call.mock.calls) {
            const source = callArgs[3];
            const destination = callArgs[4];
            expect(source).toMatch(/\/$/);
            expect(destination).toMatch(/\/$/);
        }
    });

    test("-- separator is present in both calls", async () => {
        const capabilities = makeCapabilities();

        await synchronize(capabilities);

        for (const callArgs of capabilities.rsync.call.mock.calls) {
            expect(callArgs).toContain("--");
        }
    });

    test("error from rsync.call is re-thrown as AssetsSynchronizationError with cause", async () => {
        const originalError = new Error("rsync failed");
        const capabilities = makeCapabilities({
            rsyncCall: () => Promise.reject(originalError),
        });

        let caught = null;
        try {
            await synchronize(capabilities);
        } catch (error) {
            caught = error;
        }

        expect(caught).not.toBeNull();
        expect(isAssetsSynchronizationError(caught)).toBe(true);
        expect(caught.cause).toBe(originalError);
    });

    test("isAssetsSynchronizationError returns false for non-AssetsSynchronizationError", () => {
        expect(isAssetsSynchronizationError(new Error("plain error"))).toBe(false);
        expect(isAssetsSynchronizationError(null)).toBe(false);
        expect(isAssetsSynchronizationError("string")).toBe(false);
    });
});
