/**
 * Tests for duplicate task handling in persisted state.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { transaction } = require("../src/runtime_state_storage");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("duplicate in state skipped", () => {
    test("craft file with duplicate names; load -> second skipped with WARN", async () => {
        const capabilities = getTestCapabilities();
        
        // Manually create state with duplicate task names
        await transaction(capabilities, async (storage) => {
            const currentState = await storage.getCurrentState();
            const duplicateState = {
                version: 2,
                startTime: currentState.startTime,
                tasks: [
                    {
                        name: "duplicate-task",
                        cronExpression: "0 * * * *",
                        retryDelayMs: 1000,
                    },
                    {
                        name: "duplicate-task", // Same name - should be skipped
                        cronExpression: "30 * * * *",
                        retryDelayMs: 2000,
                    },
                    {
                        name: "unique-task",
                        cronExpression: "0 12 * * *",
                        retryDelayMs: 1500,
                    },
                ]
            };
            storage.setState(duplicateState);
        });
        
        // Create scheduler which should load state and skip duplicate
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 10 });
        
        // Allow time for state loading
        await new Promise(resolve => setTimeout(resolve, 50));
        
        // Verify duplicate was logged as skipped
        expect(capabilities.logger.logWarning).toHaveBeenCalledWith(
            { name: "duplicate-task" },
            "DuplicateTaskSkipped"
        );
        
        // Verify only 2 tasks were loaded (first duplicate + unique)
        expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
            { taskCount: 2 },
            "SchedulerStateLoaded"
        );
        
        // Verify state after loading
        await transaction(capabilities, async (storage) => {
            const loadedState = await storage.getExistingState();
            // State should still have 3 tasks (duplicates not removed from storage)
            expect(loadedState.tasks).toHaveLength(3);
        });
        
        // Schedule callbacks for the loaded tasks
        const callback1 = jest.fn();
        const callback2 = jest.fn();
        
        scheduler.schedule("duplicate-task", "0 * * * *", callback1, fromMilliseconds(1000));
        scheduler.schedule("unique-task", "0 12 * * *", callback2, fromMilliseconds(1500));
        
        // Verify only 2 active tasks
        const tasks = scheduler.getTasks();
        expect(tasks).toHaveLength(2);
        expect(tasks.find(t => t.name === "duplicate-task")).toBeTruthy();
        expect(tasks.find(t => t.name === "unique-task")).toBeTruthy();
        
        scheduler.cancelAll();
    });
});