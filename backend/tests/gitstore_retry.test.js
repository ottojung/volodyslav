const fs = require("fs").promises;
const path = require("path");
const { transaction } = require("../src/gitstore");
const { PushError, isPushError } = require("../src/gitstore/wrappers");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubEventLogRepository, stubDatetime, stubLogger } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubDatetime(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

describe("gitstore retry functionality", () => {
    test("PushError type guard works correctly", () => {
        const pushError = new PushError("test error", "/test/path");
        const regularError = new Error("regular error");

        expect(isPushError(pushError)).toBe(true);
        expect(isPushError(regularError)).toBe(false);
        expect(isPushError(null)).toBe(false);
        expect(isPushError(undefined)).toBe(false);
        expect(isPushError("string")).toBe(false);
    });

    test("PushError contains expected properties", () => {
        const cause = new Error("underlying error");
        const pushError = new PushError("test error", "/test/path", cause);

        expect(pushError.name).toBe("PushError");
        expect(pushError.message).toBe("test error");
        expect(pushError.workDirectory).toBe("/test/path");
        expect(pushError.cause).toBe(cause);
    });

    test("transaction succeeds on first attempt without retry", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        const result = await transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");
            await fs.writeFile(testFile, "success content");
            await store.commit("Test commit");
            return "success";
        });

        expect(result).toBe("success");

        // Verify logger was called for attempt 1 but not for retries
        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 1,
                maxAttempts: 5
            }),
            expect.stringContaining("Gitstore transaction attempt 1/5")
        );

        // Should not log retry messages
        expect(capabilities.logger.logInfo).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("succeeded on attempt")
        );
    });

    test("transaction retries on push failure and eventually succeeds", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Mock git command to fail on first two push attempts, succeed on third
        let pushAttempts = 0;
        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            // Check if this is a push command
            if (args.includes("push")) {
                pushAttempts++;
                if (pushAttempts <= 2) {
                    throw new Error("Simulated push failure");
                }
            }
            // For all other git commands, use original behavior
            return originalGitCall.apply(capabilities.git, args);
        });

        const result = await transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");
            await fs.writeFile(testFile, "retry test content");
            await store.commit("Test commit");
            return "retry success";
        });

        expect(result).toBe("retry success");
        expect(pushAttempts).toBe(3);

        // Verify retry logging
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 1,
                maxAttempts: 5
            }),
            expect.stringContaining("Gitstore push failed on attempt 1 - retrying after")
        );

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 2,
                maxAttempts: 5
            }),
            expect.stringContaining("Gitstore push failed on attempt 2 - retrying after")
        );

        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 3,
                totalAttempts: 3
            }),
            expect.stringContaining("Gitstore transaction succeeded on attempt 3 after previous failures")
        );
    });

    test("transaction fails after exhausting all retry attempts", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Mock git command to always fail on push
        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            if (args.includes("push")) {
                throw new Error("Persistent push failure");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        const retryOptions = { maxAttempts: 3, baseDelayMs: 10 }; // Fast test

        await expect(
            transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
                const workTree = await store.getWorkTree();
                const testFile = path.join(workTree, "test.txt");
                await fs.writeFile(testFile, "fail test content");
                await store.commit("Test commit");
                return "should not succeed";
            }, retryOptions)
        ).rejects.toThrow(PushError);

        // Verify all attempts were made and logged
        const retryLogCalls = capabilities.logger.logInfo.mock.calls.filter(call =>
            call[1] && call[1].includes("retrying after")
        );
        expect(retryLogCalls).toHaveLength(2); // 2 retry messages
        expect(capabilities.logger.logError).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 3,
                maxAttempts: 3
            }),
            expect.stringContaining("Gitstore transaction failed after 3 attempts - giving up")
        );
    });

    test("transaction does not retry non-push errors", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        await expect(
            transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (_store) => {
                throw new Error("Non-push error");
            })
        ).rejects.toThrow("Non-push error");

        // Should not have retry logs, only the debug log about not retrying
        expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 1,
                errorType: "Error"
            }),
            expect.stringContaining("Gitstore transaction failed with non-push error - not retrying")
        );

        expect(capabilities.logger.logInfo).not.toHaveBeenCalledWith(
            expect.anything(),
            expect.stringContaining("retrying after")
        );
    });

    test("transaction uses custom retry options", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Mock git command to always fail on push
        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            if (args.includes("push")) {
                throw new Error("Custom retry test failure");
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        const customRetryOptions = { maxAttempts: 2, baseDelayMs: 50 };

        await expect(
            transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
                const workTree = await store.getWorkTree();
                const testFile = path.join(workTree, "test.txt");
                await fs.writeFile(testFile, "custom retry test");
                await store.commit("Test commit");
                return "should not succeed";
            }, customRetryOptions)
        ).rejects.toThrow(PushError);

        // Verify custom maxAttempts was used
        expect(capabilities.logger.logError).toHaveBeenCalledWith(
            expect.objectContaining({
                attempt: 2,
                maxAttempts: 2
            }),
            expect.stringContaining("Gitstore transaction failed after 2 attempts - giving up")
        );
    });

    test("transaction calculates flat backoff correctly", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities);

        // Mock sleeper to capture delay values
        const sleepDelays = [];
        capabilities.sleeper.sleep = jest.fn().mockImplementation((delayMs) => {
            sleepDelays.push(delayMs);
            return Promise.resolve();
        });

        // Mock git command to fail multiple times
        let pushAttempts = 0;
        const originalGitCall = capabilities.git.call;
        capabilities.git.call = jest.fn().mockImplementation((...args) => {
            if (args.includes("push")) {
                pushAttempts++;
                if (pushAttempts <= 3) {
                    throw new Error("Backoff test failure");
                }
            }
            return originalGitCall.apply(capabilities.git, args);
        });

        const baseDelayMs = 100;
        await transaction(capabilities, "working-git-repository", { url: capabilities.environment.eventLogRepository() }, async (store) => {
            const workTree = await store.getWorkTree();
            const testFile = path.join(workTree, "test.txt");
            await fs.writeFile(testFile, "backoff test");
            await store.commit("Test commit");
            return "backoff success";
        }, { maxAttempts: 5, delayMs: baseDelayMs });

        expect(sleepDelays).toEqual([100, 100, 100]);
    });
});
