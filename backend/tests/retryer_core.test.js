const { withRetry } = require("../src/retryer");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    return capabilities;
}

describe("Retryer - Core functionality", () => {
    describe("error handling", () => {
        test("propagates callback errors", async () => {
            const capabilities = getTestCapabilities();
    
            const retryableCallback = async () => {
                throw new Error("Test error");
            };

            await expect(withRetry(capabilities, "error-test", retryableCallback)).rejects.toThrow("Test error");
        });
    });

    describe("withRetry - Success scenarios", () => {
        test("executes callback that succeeds immediately", async () => {
            const capabilities = getTestCapabilities();

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
            const capabilities = getTestCapabilities();

            let callCount = 0;
            const callback = async ({ _attempt, retry }) => {
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
            const capabilities = getTestCapabilities();

            let callCount = 0;
            const callback = async ({ _attempt, retry }) => {
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
