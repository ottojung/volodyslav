/**
 * Tests for daily tasks functionality.
 * 
 * This module wraps the volodyslavDailyTasks executable and provides:
 * 1. Error handling for unavailable executables
 * 2. Logging of stdout/stderr output
 * 3. Graceful degradation when executable is missing
 */

const {
    executeDailyTasks,
    ensureDailyTasksAvailable,
    isDailyTasksUnavailable,
    DailyTasksUnavailable
} = require("../src/scheduler/daily_tasks");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    return capabilities;
}

describe("Daily Tasks", () => {
    describe("DailyTasksUnavailable Error", () => {
        test("is a constructor function", () => {
            expect(typeof DailyTasksUnavailable).toBe("function");
        });

        test("creates error instance with name property", () => {
            const error = new DailyTasksUnavailable();
            expect(error.name).toBe("DailyTasksUnavailable");
        });

        test("creates error instance with message property", () => {
            const error = new DailyTasksUnavailable();
            expect(typeof error.message).toBe("string");
            expect(error.message.length).toBeGreaterThan(0);
        });

        test("type guard function exists and is callable", () => {
            expect(typeof isDailyTasksUnavailable).toBe("function");
        });

        test("type guard returns boolean", () => {
            const error = new DailyTasksUnavailable();
            const result = isDailyTasksUnavailable(error);
            expect(typeof result).toBe("boolean");
        });

        test("type guard returns true for DailyTasksUnavailable instances", () => {
            const error = new DailyTasksUnavailable();
            expect(isDailyTasksUnavailable(error)).toBe(true);
        });

        test("type guard returns false for other error types", () => {
            const error = new Error("other error");
            expect(isDailyTasksUnavailable(error)).toBe(false);
        });

        test("type guard returns false for non-error objects", () => {
            expect(isDailyTasksUnavailable({})).toBe(false);
            expect(isDailyTasksUnavailable(null)).toBe(false);
            expect(isDailyTasksUnavailable(undefined)).toBe(false);
        });
    });

    describe("ensureDailyTasksAvailable", () => {
        test("function exists and is callable", () => {
            expect(typeof ensureDailyTasksAvailable).toBe("function");
        });

        test("returns a promise", () => {
            const result = ensureDailyTasksAvailable();
            expect(result).toBeInstanceOf(Promise);
            
            // Don't await the promise to avoid hanging - just verify it's a promise
            // Clean up by adding a catch handler without awaiting
            result.catch(() => {});
        });
    });

    describe("executeDailyTasks", () => {
        test("function exists and is callable", () => {
            expect(typeof executeDailyTasks).toBe("function");
        });

        test("returns a promise when called with capabilities", () => {
            const capabilities = getTestCapabilities();
            const result = executeDailyTasks(capabilities);
            expect(result).toBeInstanceOf(Promise);

            // Don't await the promise to avoid hanging - just verify it's a promise
            // Clean up by adding a catch handler without awaiting
            result.catch(() => {});
        });

        test("calls logger functions during execution", async () => {
            const capabilities = getTestCapabilities();

            await executeDailyTasks(capabilities);

            // Should call at least one logger function during execution
            const loggerCalled = (
                capabilities.logger.logInfo.mock.calls.length > 0 ||
                capabilities.logger.logWarning.mock.calls.length > 0 ||
                capabilities.logger.logError.mock.calls.length > 0
            );

            expect(loggerCalled).toBe(true);
        });

        test("completes without throwing", async () => {
            const capabilities = getTestCapabilities();

            // The function should handle all internal errors gracefully
            await expect(executeDailyTasks(capabilities)).resolves.toBeUndefined();
        });
    });
});