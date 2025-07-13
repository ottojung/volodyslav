const { withRetry, makeRetryableCallback } = require("../src/retryer");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

describe("Retryer - Process deduplication", () => {
    /** @type {import('../src/retryer/core').RetryerCapabilities} */
    let capabilities;

    beforeEach(() => {
        capabilities = getMockedRootCapabilities();
        stubLogger(capabilities);
    });

    afterEach(() => {
        jest.clearAllTimers();
    });

    test("prevents duplicate execution of same callback", async () => {
        let callCount = 0;
        const callback = async () => {
            callCount++;
            if (callCount === 1) {
                return fromMilliseconds(100);
            }
            return null;
        };

        const retryableCallback = makeRetryableCallback("duplicate-test-callback", callback);

        const promise1 = withRetry(capabilities, retryableCallback);
        const promise2 = withRetry(capabilities, retryableCallback);

        await Promise.all([promise1, promise2]);

        // Callback should only be called twice (once + one retry), not four times
        expect(callCount).toBe(2);

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackName: "duplicate-test-callback"
            }),
            "Retryer skipping execution - callback \"duplicate-test-callback\" already running"
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

        const retryableCallback1 = makeRetryableCallback("callback1", callback1);
        const retryableCallback2 = makeRetryableCallback("callback2", callback2);

        const promise1 = withRetry(capabilities, retryableCallback1);
        const promise2 = withRetry(capabilities, retryableCallback2);

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

        const retryableCallback = makeRetryableCallback("re-execution-test-callback", callback);

        await withRetry(capabilities, retryableCallback);
        await withRetry(capabilities, retryableCallback);

        expect(callCount).toBe(2);
    });
});
