/**
 * State-level debug test to understand the task state issues
 */

const { parseCronExpression } = require("../src/scheduler/expression");
const { getMostRecentExecution } = require("../src/scheduler/calculator");
const { stubDatetime, getDatetimeControl, stubEnvironment, stubLogger, stubSleeper, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");
const { getMockedRootCapabilities } = require("./spies");
const { Duration } = require("luxon");

describe("scheduler state debug", () => {
    test("debug task state management", async () => {
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        stubDatetime(capabilities);
        stubSleeper(capabilities);
        stubRuntimeStateStorage(capabilities);
        stubScheduler(capabilities);
        
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(500);

        let every2HourTaskCalls = 0;
        let every4HourTaskCalls = 0;
        let every2HourTaskErrors = [];
        let every4HourTaskErrors = [];
        
        const every2HourTask = jest.fn(() => { 
            try {
                every2HourTaskCalls++; 
            } catch (e) {
                every2HourTaskErrors.push(e);
                throw e;
            }
        });
        const every4HourTask = jest.fn(() => { 
            try {
                every4HourTaskCalls++; 
            } catch (e) {
                every4HourTaskErrors.push(e);
                throw e;
            }
        });

        // Start at exactly midnight
        const startTime = new Date("2021-01-01T00:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["every-2h", "0 */2 * * *", every2HourTask, retryDelay],
            ["every-4h", "0 */4 * * *", every4HourTask, retryDelay],
        ];

        console.log("=== Initializing scheduler ===");
        await capabilities.scheduler.initialize(registrations);
        
        console.log("=== Initial polling ===");
        await schedulerControl.waitForNextCycleEnd();

        console.log(`Initial calls: 2h=${every2HourTaskCalls}, 4h=${every4HourTaskCalls}`);
        console.log(`Initial errors: 2h=${every2HourTaskErrors.length}, 4h=${every4HourTaskErrors.length}`);

        // Now let's examine the internal state directly
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            console.log("=== Task state after initial execution ===");
            for (const task of state.tasks) {
                console.log(`Task ${task.name}:`);
                console.log(`  cronExpression: ${task.cronExpression}`);
                console.log(`  lastAttemptTime: ${task.lastAttemptTime || 'undefined'}`);
                console.log(`  lastSuccessTime: ${task.lastSuccessTime || 'undefined'}`);
                console.log(`  lastFailureTime: ${task.lastFailureTime || 'undefined'}`);
            }
        });

        // Advance to 02:00:00
        console.log("=== Advancing to 02:00:00 ===");
        timeControl.advanceTime(2 * 60 * 60 * 1000);
        
        // Before polling, let's manually check what should happen
        const now = capabilities.datetime.now();
        const dt = capabilities.datetime;
        
        const cronExpr2h = parseCronExpression("0 */2 * * *");
        const result2h = getMostRecentExecution(cronExpr2h, now, dt, undefined);
        console.log(`At 02:00:00 - 2h task lastScheduledFire: ${result2h.lastScheduledFire ? dt.toNativeDate(result2h.lastScheduledFire).toISOString() : 'null'}`);
        
        const cronExpr4h = parseCronExpression("0 */4 * * *");
        const result4h = getMostRecentExecution(cronExpr4h, now, dt, undefined);
        console.log(`At 02:00:00 - 4h task lastScheduledFire: ${result4h.lastScheduledFire ? dt.toNativeDate(result4h.lastScheduledFire).toISOString() : 'null'}`);

        console.log("=== Polling at 02:00:00 ===");
        await schedulerControl.waitForNextCycleEnd();

        console.log(`After 2h advance: 2h=${every2HourTaskCalls}, 4h=${every4HourTaskCalls}`);
        console.log(`Errors after 2h advance: 2h=${every2HourTaskErrors.length}, 4h=${every4HourTaskErrors.length}`);

        // Check state again
        await capabilities.state.transaction(async (storage) => {
            const state = await storage.getExistingState();
            console.log("=== Task state after 02:00:00 ===");
            for (const task of state.tasks) {
                console.log(`Task ${task.name}:`);
                console.log(`  lastAttemptTime: ${task.lastAttemptTime || 'undefined'}`);
                console.log(`  lastSuccessTime: ${task.lastSuccessTime || 'undefined'}`);
                console.log(`  lastFailureTime: ${task.lastFailureTime || 'undefined'}`);
            }
        });

        await capabilities.scheduler.stop();
    });
});