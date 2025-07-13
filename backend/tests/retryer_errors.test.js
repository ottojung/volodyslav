const { withRetry, isRetryerError, makeRetryableCallback } = require("../src/retryer");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

describe("Retryer - Error handling", () => {
    /** @type {import('../src/retryer/core').RetryerCapabilities} */
    let capabilities;

    beforeEach(() => {
        capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    test("handles callback that throws error", async () => {
        const testError = new Error("Test error");
        const callback = async () => {
            throw testError;
        };

        const retryableCallback = makeRetryableCallback("error-test", callback);

        await expect(withRetry(capabilities, retryableCallback)).rejects.toThrow();

        // Get the actual error for detailed testing
        let caughtError;
        try {
            await withRetry(capabilities, retryableCallback);
        } catch (error) {
            caughtError = error;
        }

        expect(isRetryerError(caughtError)).toBe(true);
        expect(caughtError.message).toContain("Callback failed on attempt 1");
        expect(caughtError.details).toBe(testError);

        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 1,
                error: "Test error"
            }),
            "Retryer stopping retry loop due to callback error in \"error-test\""
        );
    });

    test("removes callback from running set even after error", async () => {
        const callback = async () => {
            throw new Error("Test error");
        };

        const retryableCallback1 = makeRetryableCallback("error-cleanup-test-1", callback);
        const retryableCallback2 = makeRetryableCallback("error-cleanup-test-2", callback);

        await expect(withRetry(capabilities, retryableCallback1)).rejects.toThrow();

        // Should be able to run again (not stuck in running set)
        await expect(withRetry(capabilities, retryableCallback2)).rejects.toThrow();

        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackName: expect.any(String)
            }),
            expect.stringContaining("Retryer removed callback")
        );
    });

    test("handles callback that throws on retry", async () => {
        let callCount = 0;
        const callback = async () => {
            callCount++;
            if (callCount === 1) {
                return fromMilliseconds(50);
            }
            throw new Error("Error on retry");
        };

        const retryableCallback = makeRetryableCallback("retry-error-test", callback);

        await expect(withRetry(capabilities, retryableCallback)).rejects.toThrow();

        expect(callCount).toBe(2);
        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 2,
                error: "Error on retry"
            }),
            "Retryer stopping retry loop due to callback error in \"retry-error-test\""
        );
    });
});
