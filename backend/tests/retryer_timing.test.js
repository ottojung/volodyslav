const { withRetry, makeRetryableCallback } = require("../src/retryer");
const { fromMilliseconds } = require("../src/time_duration");
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

            const retryableCallback = makeRetryableCallback("test-delay-callback", callback);

            const startTime = Date.now();
            await withRetry(capabilities, retryableCallback);
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

            const retryableCallback = makeRetryableCallback("test-zero-delay-callback", callback);

            const startTime = Date.now();
            await withRetry(capabilities, retryableCallback);
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

            const retryableCallback = makeRetryableCallback("test-logging-callback", callback);

            await withRetry(capabilities, retryableCallback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 1 }),
                "Executing callback \"test-logging-callback\" (attempt 1)"
            );
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 2 }),
                "Executing callback \"test-logging-callback\" (attempt 2)"
            );
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 3 }),
                "Executing callback \"test-logging-callback\" (attempt 3)"
            );
        });

        test("logs callback name when available", async () => {
            async function namedCallback() {
                return null;
            }

            const retryableCallback = makeRetryableCallback("namedCallback", namedCallback);

            await withRetry(capabilities, retryableCallback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "namedCallback"
                }),
                expect.any(String)
            );
        });

        test("logs custom name for callbacks", async () => {
            // Create callback with custom name
            const callback = async function () { return null; };

            const retryableCallback = makeRetryableCallback("custom-named-callback", callback);

            await withRetry(capabilities, retryableCallback);

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "custom-named-callback"
                }),
                expect.any(String)
            );
        });

        test("logs running count correctly", async () => {
            const callback = async () => null;

            const retryableCallback = makeRetryableCallback("test-running-count-callback", callback);

            await withRetry(capabilities, retryableCallback);

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
                "Retryer removed callback \"test-running-count-callback\" from running set"
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

            const retryableCallback = makeRetryableCallback("test-rapid-succession-callback", callback);

            await withRetry(capabilities, retryableCallback);

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
                    return fromMilliseconds(50); // Short delay for testing
                }
                return null;
            };

            const retryableCallback = makeRetryableCallback("test-longer-delay-callback", callback);

            // Execute and wait for completion to avoid hanging
            await withRetry(capabilities, retryableCallback);

            expect(callCount).toBe(2);
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    retryDelay: "50ms"
                }),
                "Retryer scheduling retry of \"test-longer-delay-callback\" after 50ms"
            );
        });
    });
});
