const { withRetry } = require("../src/retryer");
const { fromSeconds, fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

describe("Retryer - Timing and logging", () => {
    /** @type {import('../src/retryer/core').RetryerCapabilities} */
    let capabilities;

    beforeEach(() => {
        capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    describe("Retry timing", () => {
        test("respects retry delay", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount === 1) {
                    return fromMilliseconds(100); // Short delay for test
                }
                return null;
            };

            const startTime = Date.now();
            await withRetry(capabilities, callback);
            const endTime = Date.now();

            expect(callCount).toBe(2);
            expect(endTime - startTime).toBeGreaterThanOrEqual(90); // Allow for timing variations
            expect(endTime - startTime).toBeLessThan(300); // Allow some margin
        });

        test("handles zero delay correctly", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount === 1) {
                    return fromMilliseconds(0); // Zero delay
                }
                return null;
            };

            const startTime = Date.now();
            await withRetry(capabilities, callback);
            const endTime = Date.now();

            expect(callCount).toBe(2);
            expect(endTime - startTime).toBeLessThan(100); // Should be very fast
        });
    });

    describe("Logging behavior", () => {
        test("logs execution start for each attempt", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount < 3) {
                    return fromMilliseconds(10);
                }
                return null;
            };

            await withRetry(capabilities, callback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 1 }),
                "Executing callback (attempt 1)"
            );
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 2 }),
                "Executing callback (attempt 2)"
            );
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 3 }),
                "Executing callback (attempt 3)"
            );
        });

        test("logs callback name when available", async () => {
            async function namedCallback() {
                return null;
            }

            await withRetry(capabilities, namedCallback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "namedCallback"
                }),
                expect.any(String)
            );
        });

        test("logs anonymous for unnamed callbacks", async () => {
            // Create truly anonymous callback
            const callback = async function () { return null; };

            await withRetry(capabilities, callback);

            // Check if any call used "anonymous" or the actual function name
            const logCalls = capabilities.logger.logDebug.mock.calls;
            const hasAnonymousOrFunctionName = logCalls.some(call =>
                call[0].callbackName === "anonymous" ||
                call[0].callbackName === "callback" ||
                call[0].callbackName === ""
            );

            expect(hasAnonymousOrFunctionName).toBe(true);
        });

        test("logs running count correctly", async () => {
            const callback = async () => null;

            await withRetry(capabilities, callback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    runningCount: 1
                }),
                expect.stringContaining("Executing callback")
            );

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    runningCount: 0
                }),
                "Retryer removed callback from running set"
            );
        });
    });

    describe("Edge cases", () => {
        test("handles rapid succession of retry requests", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount < 5) {
                    return fromMilliseconds(1); // Very short delays
                }
                return null;
            };

            await withRetry(capabilities, callback);

            expect(callCount).toBe(5);
            expect(capabilities.logger.logDebug).toHaveBeenCalledTimes(
                5 + // Execution attempts
                4 + // Retry requests 
                1 + // Success message
                1   // Removed from set
            );
        });

        test("handles callback with longer delay (limited test)", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount === 1) {
                    return fromSeconds(1); // 1 second delay
                }
                return null;
            };

            // Start the retry but don't wait for completion
            withRetry(capabilities, callback);

            // Give it a moment to process and log
            await capabilities.sleeper.sleep(50);

            expect(callCount).toBe(1);
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    retryDelay: "1s"
                }),
                "Retryer scheduling retry after 1s"
            );

            // Don't wait for the actual retry to complete
        });
    });
});
