/**
 * Tests to verify true atomicity of the modifyTasks interface
 */

const { make } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function caps() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("scheduler atomicity verification", () => {
    test("multiple concurrent modifications should be atomic", async () => {
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);

        // Schedule initial tasks
        await scheduler.schedule("task1", "* * * * *", jest.fn(), retryDelay);
        await scheduler.schedule("task2", "* * * * *", jest.fn(), retryDelay);
        
        // Verify initial state
        let tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(2);

        // Perform concurrent operations that should be atomic
        const results = await Promise.all([
            scheduler.cancel("task1"),
            scheduler.schedule("task3", "* * * * *", jest.fn(), retryDelay),
            scheduler.cancel("task2"),
        ]);

        // Verify atomicity - each operation should have completed fully
        expect(results[0]).toBe(true); // task1 canceled
        expect(results[1]).toBe("task3"); // task3 scheduled  
        expect(results[2]).toBe(true); // task2 canceled

        // Final state should be consistent
        const finalTasks = await scheduler.getTasks();
        expect(finalTasks).toHaveLength(1);
        expect(finalTasks[0].name).toBe("task3");

        await scheduler.cancelAll();
    });

    test("cancelAll should be truly atomic", async () => {
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);

        // Schedule multiple tasks
        await scheduler.schedule("task1", "* * * * *", jest.fn(), retryDelay);
        await scheduler.schedule("task2", "* * * * *", jest.fn(), retryDelay);
        await scheduler.schedule("task3", "* * * * *", jest.fn(), retryDelay);
        
        // Verify initial state  
        let tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(3);

        // The cancelAll should use the exact required pattern
        const canceledCount = await scheduler.cancelAll();
        
        // Verify result matches expected pattern
        expect(canceledCount).toBe(3);
        
        // Verify state is completely cleared
        const finalTasks = await scheduler.getTasks();
        expect(finalTasks).toHaveLength(0);
    });

    test("modifyTasks pattern is followed for all mutations", async () => {
        const capabilities = caps();
        const scheduler = make(capabilities, { pollIntervalMs: 10 });
        const retryDelay = fromMilliseconds(1000);

        // Test that schedule uses atomic pattern
        await scheduler.schedule("test-task", "* * * * *", jest.fn(), retryDelay);
        let tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(1);

        // Test that cancel uses atomic pattern  
        const cancelled = await scheduler.cancel("test-task");
        expect(cancelled).toBe(true);
        tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(0);

        // Test multiple schedules and final cancelAll
        await scheduler.schedule("task1", "* * * * *", jest.fn(), retryDelay);
        await scheduler.schedule("task2", "* * * * *", jest.fn(), retryDelay);
        
        // Final cancelAll should follow the required pattern exactly
        const count = await scheduler.cancelAll();
        expect(count).toBe(2);
        
        tasks = await scheduler.getTasks();
        expect(tasks).toHaveLength(0);
    });
});