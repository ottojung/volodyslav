/**
 * Scheduler registration precedence stories.
 * Verifies that persisted task records missing configuration details
 * are repaired using the current registration.
 */

const { getMockedRootCapabilities } = require("./spies");
const {
    stubEnvironment,
    stubLogger,
    stubDatetime,
    stubSleeper,
    stubRuntimeStateStorage,
    stubScheduler,
    getSchedulerControl,
    getDatetimeControl,
} = require("./stubs");
const {
    fromMilliseconds,
    fromMinutes,
    fromISOString,
} = require("../src/datetime");
const { makeDefault } = require("../src/runtime_state_storage/structure");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("scheduler registration precedence stories", () => {
    test("should rebuild missing cronExpression from current registration", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const datetimeControl = getDatetimeControl(capabilities);

        const startTime = fromISOString("2025-09-28T00:00:00.000Z");
        datetimeControl.setDateTime(startTime);
        schedulerControl.setPollingInterval(fromMilliseconds(10));

        const stateStorage = capabilities.state._testStorage;
        const existingState = makeDefault(capabilities.datetime);
        const taskName = "cron-override-task";
        const lastSuccess = startTime.subtract(fromMinutes(45));
        const lastAttempt = startTime.subtract(fromMinutes(30));

        existingState.tasks.push({
            name: taskName,
            retryDelayMs: fromMinutes(30).toMillis(),
            lastSuccessTime: lastSuccess,
            lastAttemptTime: lastAttempt,
        });

        stateStorage.set("mock-runtime-state", existingState);

        const newRetryDelay = fromMinutes(5);
        const registrations = [
            [taskName, "15 * * * *", jest.fn(), newRetryDelay],
        ];

        try {
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            const finalState = await capabilities.state.transaction(async (storage) => {
                return await storage.getCurrentState();
            });

            expect(finalState.tasks).toHaveLength(1);
            const persistedTask = finalState.tasks.find((task) => task.name === taskName);
            if (!persistedTask) {
                throw new Error("Persisted task should exist after initialization");
            }

            expect(persistedTask.cronExpression).toBe("15 * * * *");
            expect(persistedTask.retryDelayMs).toBe(newRetryDelay.toMillis());
            expect(persistedTask.lastSuccessTime?.toISOString()).toBe(lastSuccess.toISOString());
            expect(persistedTask.lastAttemptTime?.toISOString()).toBe(lastAttempt.toISOString());
        } finally {
            await capabilities.scheduler.stop();
        }
    });

    test("should rebuild missing retryDelayMs from current registration", async () => {
        const capabilities = getTestCapabilities();
        const schedulerControl = getSchedulerControl(capabilities);
        const datetimeControl = getDatetimeControl(capabilities);

        const startTime = fromISOString("2025-09-28T01:00:00.000Z");
        datetimeControl.setDateTime(startTime);
        schedulerControl.setPollingInterval(fromMilliseconds(10));

        const stateStorage = capabilities.state._testStorage;
        const existingState = makeDefault(capabilities.datetime);
        const taskName = "retry-override-task";
        const lastFailure = startTime.subtract(fromMinutes(10));
        const pendingRetryUntil = startTime.subtract(fromMinutes(5));

        existingState.tasks.push({
            name: taskName,
            cronExpression: "0 * * * *",
            lastFailureTime: lastFailure,
            pendingRetryUntil,
        });

        stateStorage.set("mock-runtime-state", existingState);

        const newRetryDelay = fromMinutes(2);
        const registrations = [
            [taskName, "45 * * * *", jest.fn(), newRetryDelay],
        ];

        try {
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            const finalState = await capabilities.state.transaction(async (storage) => {
                return await storage.getCurrentState();
            });

            expect(finalState.tasks).toHaveLength(1);
            const persistedTask = finalState.tasks.find((task) => task.name === taskName);
            if (!persistedTask) {
                throw new Error("Persisted task should exist after initialization");
            }

            expect(persistedTask.cronExpression).toBe("45 * * * *");
            expect(persistedTask.retryDelayMs).toBe(newRetryDelay.toMillis());
            expect(persistedTask.lastFailureTime?.toISOString()).toBe(lastFailure.toISOString());
            expect(persistedTask.pendingRetryUntil?.toISOString()).toBe(pendingRetryUntil.toISOString());
        } finally {
            await capabilities.scheduler.stop();
        }
    });
});
