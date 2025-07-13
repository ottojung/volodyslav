const { withRetry, isRetryerError, makeRetryableCallback } = require("../src/retryer");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

describe("Retryer - Core functionality", () => {
    /** @type {import('../src/retryer/core').RetryerCapabilities} */
    let capabilities;

    beforeEach(() => {
        capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    describe("isRetryerError type guard", () => {
        test("identifies RetryerError correctly", async () => {
            const callback = async () => {
                throw new Error("Test error");
            };

            const retryableCallback = makeRetryableCallback("error-test", callback);

            await expect(withRetry(capabilities, retryableCallback)).rejects.toThrow();
            
            // Get the actual error that was thrown
            let caughtError;
            try {
                await withRetry(capabilities, retryableCallback);
            } catch (error) {
                caughtError = error;
            }

            expect(isRetryerError(caughtError)).toBe(true);
            expect(caughtError.message).toContain("Callback failed on attempt 1");
        });

        test("rejects non-RetryerError objects", () => {
            const regularError = new Error("Test");

            expect(isRetryerError(regularError)).toBe(false);
            expect(isRetryerError(null)).toBe(false);
            expect(isRetryerError(undefined)).toBe(false);
            expect(isRetryerError({})).toBe(false);
        });
    });

    describe("withRetry - Success scenarios", () => {
        test("executes callback that succeeds immediately", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                return null;
            };

            const retryableCallback = makeRetryableCallback("immediate-success-test", callback);

            await withRetry(capabilities, retryableCallback);

            expect(callCount).toBe(1);
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempt: 1,
                    totalAttempts: 1
                }),
                "Callback completed successfully, no retry needed"
            );
        });

        test("executes callback that succeeds after retries", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount < 3) {
                    return fromMilliseconds(100);
                }
                return null;
            };

            const retryableCallback = makeRetryableCallback("retry-success-test", callback);

            await withRetry(capabilities, retryableCallback);

            expect(callCount).toBe(3);
        });

        test("logs retry attempts correctly", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount === 1) {
                    return fromMilliseconds(50);
                }
                return null;
            };

            const retryableCallback = makeRetryableCallback("logging-test", callback);

            await withRetry(capabilities, retryableCallback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempt: 1,
                    retryDelay: "50ms"
                }),
                "Retryer scheduling retry after 50ms"
            );
        });
    });
});
