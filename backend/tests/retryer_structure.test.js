const { withRetry, makeRetryableCallback, isRetryableCallback } = require("../src/retryer");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

describe("Retryer - RetryableCallback structure", () => {
    /** @type {import('../src/retryer/core').RetryerCapabilities} */
    let capabilities;

    beforeEach(() => {
        capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    describe("makeRetryableCallback factory", () => {
        test("creates valid RetryableCallback structure", () => {
            const callback = async () => null;
            const retryableCallback = makeRetryableCallback("test-callback", callback);

            expect(retryableCallback).toEqual({
                name: "test-callback",
                callback: callback
            });

            expect(isRetryableCallback(retryableCallback)).toBe(true);
        });

        test("creates RetryableCallback with any callback function", () => {
            const asyncCallback = async () => fromMilliseconds(100);
            const retryableCallback = makeRetryableCallback("async-test", asyncCallback);

            expect(retryableCallback.name).toBe("async-test");
            expect(retryableCallback.callback).toBe(asyncCallback);
            expect(isRetryableCallback(retryableCallback)).toBe(true);
        });
    });

    describe("isRetryableCallback type guard", () => {
        test("returns true for valid RetryableCallback", () => {
            const callback = async () => null;
            const retryableCallback = makeRetryableCallback("valid", callback);

            expect(isRetryableCallback(retryableCallback)).toBe(true);
        });

        test("returns false for invalid objects", () => {
            expect(isRetryableCallback(null)).toBe(false);
            expect(isRetryableCallback(undefined)).toBe(false);
            expect(isRetryableCallback({})).toBe(false);
            expect(isRetryableCallback({ name: "test" })).toBe(false);
            expect(isRetryableCallback({ callback: () => {} })).toBe(false);
            expect(isRetryableCallback({ name: 123, callback: () => {} })).toBe(false);
            expect(isRetryableCallback({ name: "test", callback: "not-a-function" })).toBe(false);
        });

        test("returns false for regular functions", () => {
            const regularFunction = async () => null;
            expect(isRetryableCallback(regularFunction)).toBe(false);
        });
    });

    describe("Name-based deduplication", () => {
        test("prevents duplicate execution with same name", async () => {
            let call1Count = 0;
            let call2Count = 0;

            const callback1 = async () => {
                call1Count++;
                if (call1Count === 1) {
                    return fromMilliseconds(50); // Short delay for test
                }
                return null;
            };

            const callback2 = async () => {
                call2Count++;
                if (call2Count === 1) {
                    return fromMilliseconds(50); // Short delay for test
                }
                return null;
            };

            // Different callback functions but same name
            const retryableCallback1 = makeRetryableCallback("same-name", callback1);
            const retryableCallback2 = makeRetryableCallback("same-name", callback2);

            const promise1 = withRetry(capabilities, retryableCallback1);
            const promise2 = withRetry(capabilities, retryableCallback2);

            await Promise.all([promise1, promise2]);

            // Only one callback should execute
            expect(call1Count + call2Count).toBe(2); // 1 execution + 1 retry from the first callback
            expect(call2Count).toBe(0); // Second callback should be skipped

            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "same-name"
                }),
                "Retryer skipping execution - callback already running"
            );
        });

        test("allows execution with different names", async () => {
            let call1Count = 0;
            let call2Count = 0;

            const callback = async () => {
                call1Count++;
                call2Count++;
                return null;
            };

            // Same callback function but different names
            const retryableCallback1 = makeRetryableCallback("name1", callback);
            const retryableCallback2 = makeRetryableCallback("name2", callback);

            const promise1 = withRetry(capabilities, retryableCallback1);
            const promise2 = withRetry(capabilities, retryableCallback2);

            await Promise.all([promise1, promise2]);

            expect(call1Count).toBe(2); // Both callbacks executed
            expect(call2Count).toBe(2);
        });

        test("allows re-execution with same name after completion", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                return null;
            };

            const retryableCallback1 = makeRetryableCallback("reusable-name", callback);
            const retryableCallback2 = makeRetryableCallback("reusable-name", callback);

            await withRetry(capabilities, retryableCallback1);
            await withRetry(capabilities, retryableCallback2);

            expect(callCount).toBe(2); // Both should execute sequentially
        });
    });

    describe("Error handling with RetryableCallback", () => {
        test("properly handles callback errors with named callbacks", async () => {
            const callback = async () => {
                throw new Error("Test error");
            };

            const retryableCallback = makeRetryableCallback("error-test-callback", callback);

            await expect(withRetry(capabilities, retryableCallback)).rejects.toThrow("Callback failed on attempt 1: Test error");

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "error-test-callback",
                    error: "Test error"
                }),
                "Retryer stopping retry loop due to callback error"
            );
        });

        test("removes callback from running set after error", async () => {
            const callback = async () => {
                throw new Error("Test error");
            };

            const retryableCallback = makeRetryableCallback("cleanup-test-callback", callback);

            try {
                await withRetry(capabilities, retryableCallback);
            } catch (error) {
                // Expected error
            }

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({
                    callbackName: "cleanup-test-callback",
                    runningCount: 0
                }),
                "Retryer removed callback from running set"
            );
        });
    });

    describe("Integration with existing workflow", () => {
        test("maintains all existing retry behavior", async () => {
            let callCount = 0;
            const callback = async () => {
                callCount++;
                if (callCount < 3) {
                    return fromMilliseconds(10);
                }
                return null;
            };

            const retryableCallback = makeRetryableCallback("integration-test", callback);

            await withRetry(capabilities, retryableCallback);

            expect(callCount).toBe(3);

            // Verify all the expected log calls
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ callbackName: "integration-test", attempt: 1 }),
                "Executing callback (attempt 1)"
            );

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ callbackName: "integration-test", retryDelay: "10ms" }),
                "Retryer scheduling retry after 10ms"
            );

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ callbackName: "integration-test", totalAttempts: 3 }),
                "Callback completed successfully, no retry needed"
            );

            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                expect.objectContaining({ callbackName: "integration-test", runningCount: 0 }),
                "Retryer removed callback from running set"
            );
        });
    });
});
