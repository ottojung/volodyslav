const { withRetry, isRetryerError } = require("../src/retryer");
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

        await expect(withRetry(capabilities, callback)).rejects.toThrow();

        // Get the actual error for detailed testing
        let caughtError;
        try {
            await withRetry(capabilities, callback);
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
            "Retryer stopping retry loop due to callback error"
        );
    });

    test("removes callback from running set even after error", async () => {
        const callback = async () => {
            throw new Error("Test error");
        };

        await expect(withRetry(capabilities, callback)).rejects.toThrow();

        // Should be able to run again (not stuck in running set)
        await expect(withRetry(capabilities, callback)).rejects.toThrow();

        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackName: expect.any(String)
            }),
            "Retryer removed callback from running set"
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

        await expect(withRetry(capabilities, callback)).rejects.toThrow();

        expect(callCount).toBe(2);
        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 2,
                error: "Error on retry"
            }),
            "Retryer stopping retry loop due to callback error"
        );
    });
});
