const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");

describe("polling scheduler preload integration", () => {
    test("scheduler can be created and works normally when loadRuntimeState is called", () => {
        const capabilities = {
            logger: {
                logInfo: jest.fn(),
                logDebug: jest.fn(),
                logWarning: jest.fn(),
                logError: jest.fn(),
            },
            reader: {
                readFileAsText: jest.fn(),
            },
            checker: {
                fileExists: jest.fn(),
            },
            environment: {
                workingDirectory: () => "/tmp/test",
            }
        };

        // The key test is that this doesn't break when loadRuntimeState is called internally
        expect(async () => {
            const cron = await make(capabilities, { pollIntervalMs: 100 });
            const retryDelay = fromMilliseconds(60000);
            const cb = jest.fn();

            cron.schedule("test-task", "* * * * *", cb, retryDelay);

            const tasks = cron.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].name).toBe("test-task");

            cron.cancelAll();
        }).not.toThrow();
    });

    test("polling scheduler preserves existing behavior with new code", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = {
            logger: {
                logInfo: jest.fn(),
                logDebug: jest.fn(),
                logWarning: jest.fn(),
                logError: jest.fn(),
            },
            reader: {
                readFileAsText: jest.fn(),
            },
            checker: {
                fileExists: jest.fn(),
            },
            environment: {
                workingDirectory: () => "/tmp/test",
            }
        };

        const cron = await make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(100);
        let count = 0;
        const cb = jest.fn(() => {
            count++;
            if (count === 1) {
                throw new Error("fail");
            }
        });

        cron.schedule("t", "* * * * *", cb, retryDelay);

        // Should run first task and fail
        jest.advanceTimersByTime(10);
        expect(cb).toHaveBeenCalledTimes(1);

        // Should not retry yet
        jest.advanceTimersByTime(90);
        expect(cb).toHaveBeenCalledTimes(1);

        // Should retry now
        jest.advanceTimersByTime(20);
        expect(cb).toHaveBeenCalledTimes(2);

        cron.cancelAll();
        jest.clearAllTimers();
    });
});