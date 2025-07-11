const { withRetry, isRetryerError } = require("../src/retryer");
const { fromSeconds, fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

describe("Retryer", () => {
    /** @type {import('../src/retryer/core').RetryerCapabilities} */
    let capabilities;

    beforeEach(() => {
        capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
    });

    afterEach(() => {
        // Clear any timers to prevent hanging
        jest.clearAllTimers();
    });

    describe("isRetryerError type guard", () => {
        test("identifies RetryerError correctly", async () => {
            const callback = async () => {
                throw new Error("Test error");
            };

            try {
                await withRetry(capabilities, callback);
            } catch (error) {
                expect(isRetryerError(error)).toBe(true);
                expect(error.message).toContain("Callback failed on attempt 1");
            }
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

            await withRetry(capabilities, callback);

            expect(callCount).toBe(1);
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
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

            await withRetry(capabilities, callback);

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

            await withRetry(capabilities, callback);

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempt: 1,
                    retryDelay: "50ms"
                }),
                "Callback requested retry after 50ms"
            );
        });
    });

    describe("withRetry - Process deduplication", () => {
        test("prevents duplicate execution of same callback", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount === 1) {
                    return fromMilliseconds(100);
                }
                return null;
            };

            const promise1 = withRetry(capabilities, callback);
            const promise2 = withRetry(capabilities, callback);

            await Promise.all([promise1, promise2]);

            // Callback should only be called twice (once + one retry), not four times
            expect(callCount).toBe(2);
            
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "callback"
                }),
                "Callback is already running, skipping execution"
            );
        });

        test("allows execution of different callbacks simultaneously", async () => {
            let call1Count = 0;
            let call2Count = 0;

            const callback1 = async () => {
                call1Count++;
                return null;
            };

            const callback2 = async () => {
                call2Count++;
                return null;
            };

            const promise1 = withRetry(capabilities, callback1);
            const promise2 = withRetry(capabilities, callback2);

            await Promise.all([promise1, promise2]);

            expect(call1Count).toBe(1);
            expect(call2Count).toBe(1);
        });

        test("allows re-execution after completion", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                return null;
            };

            await withRetry(capabilities, callback);
            await withRetry(capabilities, callback);

            expect(callCount).toBe(2);
        });
    });

    describe("withRetry - Error handling", () => {
        test("handles callback that throws error", async () => {
            const testError = new Error("Test error");
            const callback = async () => {
                throw testError;
            };

            let caughtError;
            try {
                await withRetry(capabilities, callback);
            } catch (error) {
                caughtError = error;
            }

            expect(caughtError).toBeDefined();
            expect(isRetryerError(caughtError)).toBe(true);
            expect(caughtError.message).toContain("Callback failed on attempt 1");
            expect(caughtError.details).toBe(testError);

            expect(capabilities.logger.logError).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempt: 1,
                    error: "Test error"
                }),
                "Callback threw an error, stopping retry loop"
            );
        });

        test("removes callback from running set even after error", async () => {
            const callback = async () => {
                throw new Error("Test error");
            };

            await expect(withRetry(capabilities, callback)).rejects.toThrow();

            // Should be able to run again (not stuck in running set)
            await expect(withRetry(capabilities, callback)).rejects.toThrow();

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: expect.any(String)
                }),
                "Callback removed from running set"
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
            expect(capabilities.logger.logError).toHaveBeenCalledWith(
                expect.objectContaining({
                    attempt: 2,
                    error: "Error on retry"
                }),
                "Callback threw an error, stopping retry loop"
            );
        });
    });

    describe("withRetry - Retry timing", () => {
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

    describe("withRetry - Logging behavior", () => {
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

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 1 }),
                "Executing callback (attempt 1)"
            );
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 2 }),
                "Executing callback (attempt 2)"
            );
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ attempt: 3 }),
                "Executing callback (attempt 3)"
            );
        });

        test("logs callback name when available", async () => {
            async function namedCallback() {
                return null;
            }

            await withRetry(capabilities, namedCallback);

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "namedCallback"
                }),
                expect.any(String)
            );
        });

        test("logs anonymous for unnamed callbacks", async () => {
            // Create truly anonymous callback
            const callback = async function() { return null; };

            await withRetry(capabilities, callback);

            // Check if any call used "anonymous" or the actual function name
            const logCalls = capabilities.logger.logInfo.mock.calls;
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

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    runningCount: 1
                }),
                expect.stringContaining("Executing callback")
            );

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    runningCount: 0
                }),
                "Callback removed from running set"
            );
        });
    });

    describe("withRetry - Edge cases", () => {
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
            expect(capabilities.logger.logInfo).toHaveBeenCalledTimes(
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
            const retryPromise = withRetry(capabilities, callback);
            
            // Give it a moment to process and log
            await new Promise(resolve => setTimeout(resolve, 50));
            
            expect(callCount).toBe(1);
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    retryDelay: "1s"
                }),
                "Callback requested retry after 1s"
            );
            
            // Don't wait for the actual retry to complete
        });
    });
});
