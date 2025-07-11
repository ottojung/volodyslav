const { withRetry } = require("../src/retryer");
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

        const promise1 = withRetry(capabilities, callback);
        const promise2 = withRetry(capabilities, callback);

        await Promise.all([promise1, promise2]);

        // Callback should only be called twice (once + one retry), not four times
        expect(callCount).toBe(2);

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                callbackName: "callback"
            }),
            "Retryer skipping execution - callback already running"
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
