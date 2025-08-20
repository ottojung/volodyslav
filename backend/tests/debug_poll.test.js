/**
 * Debug test to see if polling works
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("debug poll test", () => {
    test("manual poll test", async () => {
        jest.useFakeTimers().setSystemTime(new Date("2020-01-01T00:00:00Z"));
        
        const capabilities = getTestCapabilities();
        
        // Create scheduler and schedule a task
        const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
        const retryDelay = fromMilliseconds(5000);
        const callback = jest.fn(() => {
            console.log("CALLBACK EXECUTED");
            throw new Error("Task failed");
        });
        
        console.log("Scheduling task...");
        await scheduler.schedule("test-task", "* * * * *", callback, retryDelay);
        
        console.log("Getting tasks before poll...");
        let tasks = await scheduler.getTasks();
        console.log("Tasks before poll:", tasks.length, tasks[0] ? tasks[0].modeHint : "no tasks");
        
        console.log("Calling manual poll...");
        await scheduler._poll();
        
        console.log("Getting tasks after poll...");
        tasks = await scheduler.getTasks();
        console.log("Tasks after poll:", tasks.length, tasks[0] ? tasks[0].modeHint : "no tasks");
        console.log("Callback call count:", callback.mock.calls.length);
        
        await scheduler.cancelAll();
        jest.useRealTimers();
    }, 10000);
});