/**
 * Tests for the new declarative scheduler functionality.
 */

const {
    stubLogger,
    stubEnvironment,
    stubSleeper,
    stubDatetime,
    stubScheduler,
    getSchedulerControl,
    getDatetimeControl,
    stubRuntimeStateStorage,
} = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { Duration } = require("luxon");
const { fromISOString, fromMilliseconds } = require("../src/datetime");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubSleeper(capabilities);
    stubDatetime(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("Declarative Scheduler", () => {

    describe("initialize", () => {
        test("succeeds with non-empty registrations for first-time initialization", async () => {
            // This test verifies that first-time initialization works
            const capabilities = getTestCapabilities();
            const registrations = [
                ["test-task", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            // Non-empty registrations should succeed on first-time setup (empty persisted state)
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop();
        });

        test("succeeds with empty registrations when no persisted state exists", async () => {
            // This test verifies the basic functionality when there's no state
            const capabilities = getTestCapabilities();
            const registrations = [];

            // Empty registrations should succeed (idempotent call does nothing)
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop();
        });

        test("is idempotent - multiple calls have no additional effect", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            // First call should succeed
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            // Second call should also succeed and do nothing
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            // Third call should also succeed and do nothing
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when tasks differ from registrations", async () => {
            const capabilities = getTestCapabilities();

            // First, set up some initial persisted state by calling initialize
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Now try to initialize with different tasks using SAME capabilities (same working directory)
            const differentRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})], // same
                ["task3", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})], // different name
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(differentRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    removedTasks: ["task2"], // task2 was removed
                    addedTasks: ["task3"], // task3 was added
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when cron expression differs", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with different cron expression using same capabilities
            const changedRegistrations = [
                ["task1", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 5})], // different cron
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(changedRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for modified task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    modifiedTasks: [
                        expect.objectContaining({
                            name: "task1",
                            field: "cronExpression",
                            from: "0 * * * *",
                            to: "0 0 * * *"
                        })
                    ]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when retry delay differs", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with different retry delay using same capabilities
            const changedRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 10})], // different retry delay
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(changedRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for modified task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    modifiedTasks: [
                        expect.objectContaining({
                            name: "task1",
                            field: "retryDelayMs",
                            from: 300000, // 5 minutes in ms
                            to: 600000    // 10 minutes in ms
                        })
                    ]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when tasks differ from registrations after restart", async () => {
            const capabilities = getTestCapabilities();

            // First, set up some initial persisted state by calling initialize
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);
            await capabilities.scheduler.stop();

            // Now try to initialize with different tasks using SAME capabilities (same working directory)
            const differentRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})], // same
                ["task3", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})], // different name
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(differentRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    removedTasks: ["task2"], // task2 was removed
                    addedTasks: ["task3"], // task3 was added
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when cron expression differs after restart", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);
            await capabilities.scheduler.stop();

            // Try with different cron expression using same capabilities
            const changedRegistrations = [
                ["task1", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 5})], // different cron
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(changedRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for modified task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    modifiedTasks: [
                        expect.objectContaining({
                            name: "task1",
                            field: "cronExpression",
                            from: "0 * * * *",
                            to: "0 0 * * *"
                        })
                    ]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when retry delay differs after restart", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);
            await capabilities.scheduler.stop();

            // Try with different retry delay using same capabilities
            const changedRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 10})], // different retry delay
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(changedRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for modified task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    modifiedTasks: [
                        expect.objectContaining({
                            name: "task1",
                            field: "retryDelayMs",
                            from: 300000, // 5 minutes in ms
                            to: 600000    // 10 minutes in ms
                        })
                    ]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when task is missing from registrations", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state with two tasks
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with only one task (missing task2) using same capabilities
            const missingTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(missingTaskRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for removed task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    removedTasks: ["task2"]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when extra task is in registrations", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state with one task
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Try with extra task using same capabilities
            const extraTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})], // extra task
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(extraTaskRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for added task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    addedTasks: ["task2"]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when task is missing from registrations after restart", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state with two tasks
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            await capabilities.scheduler.stop();

            // Try with only one task (missing task2) using same capabilities
            const missingTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(missingTaskRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for removed task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    removedTasks: ["task2"]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("overrides persisted state when extra task is in registrations after restart", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state with one task
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            await capabilities.scheduler.stop();

            // Try with extra task using same capabilities
            const extraTaskRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})], // extra task
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(extraTaskRegistrations)).resolves.toBeUndefined();
            
            // Verify override was logged for added task
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    addedTasks: ["task2"]
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("provides detailed override information when applying complex changes", async () => {
            const capabilities = getTestCapabilities();

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            // Create complex mismatch scenario using same capabilities
            const mismatchedRegistrations = [
                ["task1", "0 0,2,4,6,8,10,12,14,16,18,20,22 * * *", jest.fn(), Duration.fromObject({minutes: 30})], // different cron + retry delay
                ["task3", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})], // extra task (task2 is missing)
            ];

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(mismatchedRegistrations)).resolves.toBeUndefined();

            // Verify detailed override information was logged
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    removedTasks: ["task2"],
                    addedTasks: ["task3"],
                    modifiedTasks: expect.arrayContaining([
                        expect.objectContaining({
                            name: "task1",
                            field: "cronExpression",
                            from: "0 * * * *",
                            to: "0 0,2,4,6,8,10,12,14,16,18,20,22 * * *"
                        }),
                        expect.objectContaining({
                            name: "task1",
                            field: "retryDelayMs",
                            from: Duration.fromObject({minutes: 5}).toMillis(),
                            to: Duration.fromObject({minutes: 30}).toMillis()
                        })
                    ]),
                    totalChanges: 4 // 1 removed + 1 added + 2 modified fields
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            await capabilities.scheduler.stop();
        });

        test("provides detailed override information when applying complex changes after restart", async () => {
            const capabilities = getTestCapabilities();
            const dateControl = getDatetimeControl(capabilities);
            const schedulerControl = getSchedulerControl(capabilities);

            // Speed up scheduler polling for test
            schedulerControl.setPollingInterval(fromMilliseconds(100));
            dateControl.setDateTime(fromISOString("2021-01-01T00:00:00.000Z"));

            const callback1 = jest.fn();
            const callback2 = jest.fn();
            const callback3 = jest.fn();            

            // Set up initial state
            const initialRegistrations = [
                ["task1", "0 * * * *", callback1, Duration.fromObject({minutes: 5})],
                ["task2", "0 * * * *", callback2, Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(initialRegistrations);

            expect(callback1).not.toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            expect(callback3).not.toHaveBeenCalled();

            await schedulerControl.waitForNextCycleEnd();

            expect(callback1).toHaveBeenCalledTimes(1);
            expect(callback2).toHaveBeenCalledTimes(1);
            expect(callback3).not.toHaveBeenCalled();

            // Create complex mismatch scenario using same capabilities
            const mismatchedRegistrations = [
                ["task1", "0 0 * * *", callback1, Duration.fromObject({minutes: 30})], // different cron + retry delay
                ["task3", "0 * * * *", callback3, Duration.fromObject({minutes: 10})], // extra task (task2 is missing)
            ];

            await capabilities.scheduler.stop();
            dateControl.advanceByDuration(Duration.fromObject({ days: 1 }));

            // This should now succeed (override behavior) instead of throwing
            await expect(capabilities.scheduler.initialize(mismatchedRegistrations)).resolves.toBeUndefined();

            // Verify detailed override information was logged
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({
                    removedTasks: ["task2"],
                    addedTasks: ["task3"],
                    modifiedTasks: expect.arrayContaining([
                        expect.objectContaining({
                            name: "task1",
                            field: "cronExpression",
                            from: "0 * * * *",
                            to: "0 0 * * *"
                        }),
                        expect.objectContaining({
                            name: "task1",
                            field: "retryDelayMs",
                            from: Duration.fromObject({minutes: 5}).toMillis(),
                            to: Duration.fromObject({minutes: 30}).toMillis()
                        })
                    ]),
                    totalChanges: 4 // 1 removed + 1 added + 2 modified fields
                }),
                "Scheduler state override: registrations differ from persisted state, applying changes"
            );
            
            // No additional calls at initialization time.
            expect(callback1).toHaveBeenCalledTimes(1);
            expect(callback2).toHaveBeenCalledTimes(1);
            expect(callback3).not.toHaveBeenCalled();

            await schedulerControl.waitForNextCycleEnd();

            // task2 should NOT run again because its missing from registrations.
            expect(callback1).toHaveBeenCalledTimes(2);
            expect(callback2).toHaveBeenCalledTimes(1);
            expect(callback3).toHaveBeenCalledTimes(1);

            await capabilities.scheduler.stop();
        });

        test("handles empty registrations with empty persisted state", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [];

            // Should succeed with no tasks
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();

            // Should be idempotent
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop();
        });

        test("logs appropriate messages for first-time initialization", async () => {
            const capabilities = getTestCapabilities();
            const registrations = [
                ["task1", "0 * * * *", jest.fn(), Duration.fromObject({minutes: 5})],
                ["task2", "0 0 * * *", jest.fn(), Duration.fromObject({minutes: 10})],
            ];

            await capabilities.scheduler.initialize(registrations);

            // Should log first-time initialization message
            expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                {
                    registeredTaskCount: 2,
                    taskNames: ["task1", "task2"]
                },
                "First-time scheduler initialization: registering initial tasks"
            );

            await capabilities.scheduler.stop();
        });
    });

    describe("task execution behavior during initialize", () => {
        // Use real timers for these tests as they test actual scheduler polling behavior

        test("initialize sets up scheduler to execute tasks at proper times", async () => {
            const taskCallback = jest.fn().mockResolvedValue(undefined);

            const registrations = [
                // Task that should run every 15 minutes
                ["test-task", "0,15,30,45 * * * *", taskCallback, Duration.fromObject({minutes: 5})],
            ];

            const capabilities = getTestCapabilities();
            const control = getSchedulerControl(capabilities);
            const timeControl = getDatetimeControl(capabilities);
            
            // Set time to 00:05:00 to avoid immediate execution (task runs at 0, 15, 30, 45 minutes)
            const startTime = fromISOString("2021-01-01T00:05:00.000Z"); // 2021-01-01T00:05:00.000Z
            timeControl.setDateTime(startTime);
            control.setPollingInterval(fromMilliseconds(1));

            // Initialize the scheduler with very short poll interval for testing
            await capabilities.scheduler.initialize(registrations);

            // Wait for at least one poll cycle to execute
            await control.waitForNextCycleEnd();

            // Task should NOT have been executed on first startup (new behavior)
            expect(taskCallback).not.toHaveBeenCalled();
            await capabilities.scheduler.stop();
        });

        test("initialize is idempotent - can be called multiple times safely", async () => {
            const taskCallback = jest.fn().mockResolvedValue(undefined);

            const registrations = [
                ["test-task", "0 * * * *", taskCallback, Duration.fromObject({minutes: 5})],
            ];

            const capabilities = getTestCapabilities();
            const control = getSchedulerControl(capabilities);
            const timeControl = getDatetimeControl(capabilities);
            
            // Set time to 00:30:00 to avoid immediate execution (task runs at 0 minutes of each hour)
            const startTime = fromISOString("2021-01-01T00:30:00.000Z");
            timeControl.setDateTime(startTime);
            control.setPollingInterval(fromMilliseconds(1));

            // First call to initialize
            await capabilities.scheduler.initialize(registrations);

            // Wait for initial execution
            await control.waitForNextCycleEnd();

            // Task should NOT have been called on first startup (new behavior)
            expect(taskCallback).not.toHaveBeenCalled();

            // Second call to initialize with same capabilities - should be idempotent
            // This should not cause errors or duplicate scheduling issues
            await expect(capabilities.scheduler.initialize(registrations)).resolves.toBeUndefined();
            await capabilities.scheduler.stop();
        });
    });
});
