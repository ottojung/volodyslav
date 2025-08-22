const { withRetry } = require("../src/retryer");
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

    describe("error handling", () => {
        test("propagates callback errors", async () => {
            const retryableCallback = async () => {
                throw new Error("Test error");
            };

            await expect(withRetry(capabilities, "error-test", retryableCallback)).rejects.toThrow("Test error");
        });
    });

    describe("withRetry - Success scenarios", () => {
        test("executes callback that succeeds immediately", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                return "ok";
            };

            const result = await withRetry(capabilities, "immediate-success-test", callback);

            expect(callCount).toBe(1);
            expect(result).toBe("ok");
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "immediate-success-test",
                    attempt: 1,
                    totalAttempts: 1
                }),
                "Callback \"immediate-success-test\" completed successfully"
            );
        });

        test("executes callback that succeeds after retries", async () => {
            let callCount = 0;
            const callback = async ({ attempt, retry }) => {
                callCount++;
                if (callCount < 3) {
                    // signal that we want another attempt
                    retry();
                    return undefined;
                }
                return "done";
            };

            const result = await withRetry(capabilities, "retry-success-test", callback);

            expect(callCount).toBe(3);
            expect(result).toBe("done");
        });

        test("logs execution attempts correctly", async () => {
            let callCount = 0;
            const callback = async ({ attempt, retry }) => {
                callCount++;
                if (callCount === 1) {
                    retry();
                    return undefined;
                }
                return "ok";
            };

            await withRetry(capabilities, "logging-test", callback);

            // First call should log the "Executing callback" message for attempt 1
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "logging-test",
                    attempt: 1
                }),
                'Executing callback "logging-test" (attempt 1)'
            );
            // Final success log must also be present
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "logging-test",
                    attempt: 2,
                    totalAttempts: 2
                }),
                'Callback "logging-test" completed successfully'
            );
        });
    });
});
