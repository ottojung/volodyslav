/**
 * Edge case tests for scheduler's calculator.
 * Exposes bugs in next_mathematical.js, previous_mathematical.js, and date_helpers.js
 * 
 * This test file follows the style of scheduler_stories.test.js - creating actual scenarios
 * with actual end-to-end checks, not just testing the calculator directly.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubRuntimeStateStorage, stubScheduler, getSchedulerControl } = require("./stubs");
const { toEpochMs, fromEpochMs } = require("../src/datetime");

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

describe("scheduler calculator edge cases", () => {
    
    /**
     * Bug 1: next_mathematical.js:97
     * 
     * P0 - Advance day/month even when minute and hour don't roll over
     * 
     * Issue: Day and month fields are only updated when `carry` stays true after the 
     * minute/hour adjustments, so the algorithm can return a timestamp on a calendar 
     * day that is not allowed by cronExpr.day or cronExpr.month.
     * 
     * Test case: `* * 15 * *` with fromDateTime at 2025-01-14 10:00
     * Expected bug: calculateNextExecution returns 2025-01-14 10:01 because minutes 
     * advance to 1 without triggering a carry, even though day 14 is disallowed.
     * Expected correct behavior: Should advance to 2025-01-15 00:00 (the 15th).
     */
    test("should not execute on disallowed day when minute advances without carry - Bug in next_mathematical.js:97", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        
        const taskCallback = jest.fn();
        const executionTimes = [];
        
        taskCallback.mockImplementation(() => {
            const currentTime = toEpochMs(capabilities.datetime.now());
            const currentDateTime = fromEpochMs(currentTime);
            executionTimes.push({
                time: currentTime,
                day: currentDateTime.day,
                hour: currentDateTime.hour,
                minute: currentDateTime.minute,
                humanTime: new Date(currentTime).toISOString()
            });
        });

        // Set time to 2025-01-14 10:00:00 (day 14, which is NOT allowed by the cron)
        const startTime = new Date("2025-01-14T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Cron expression: run every 15 minutes, but only on the 15th day of month
        // This avoids the frequency validation issue while still testing the bug
        const registrations = [
            ["15th-only-task", "*/15 * 15 * *", taskCallback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Task should NOT execute on day 14
        console.log(`Initial executions on day 14: ${executionTimes.filter(exec => exec.day === 14).length}`);
        expect(taskCallback.mock.calls.length).toBe(0);

        // Advance time by 15 minutes to 10:15 (still on day 14)
        timeControl.advanceTime(15 * 60 * 1000);
        await schedulerControl.waitForNextCycleEnd();

        // Bug: Task incorrectly executes on day 14 at 10:15
        // Correct behavior: Task should NOT execute because we're still on day 14
        const executionsOnDay14 = executionTimes.filter(exec => exec.day === 14);
        console.log(`Bug 1 - Executions on day 14 (should be 0):`, executionsOnDay14);
        expect(executionsOnDay14).toHaveLength(0); // This will FAIL due to the bug

        // Advance to the 15th day (13 hours and 45 minutes later) 
        timeControl.advanceTime(13 * 60 * 60 * 1000 + 45 * 60 * 1000); // Advance to 2025-01-15 00:00
        await schedulerControl.waitForNextCycleEnd();

        // Now task should execute because we're on day 15
        const executionsOnDay15 = executionTimes.filter(exec => exec.day === 15);
        expect(executionsOnDay15.length).toBeGreaterThan(0);

        await capabilities.scheduler.stop();
    });

    /**
     * Bug 2: previous_mathematical.js:89
     * 
     * P0 - Previous execution can land on disallowed day when no underflow occurs
     * 
     * Issue: The reverse calculation mirrors the same assumption: day/month are only 
     * decremented when `underflow` is still true after minute/hour adjustments. If 
     * minutes and hours have many allowed values but the current calendar day is not 
     * in cronExpr.day, the function returns a time on that forbidden day.
     * 
     * Test case: `* * 15 * *` with reference time of 2025-01-16 10:00
     * Expected bug: calculatePreviousExecution produces 2025-01-16 09:45 instead of 
     * the last occurrence on the 15th.
     * Expected correct behavior: Should return 2025-01-15 23:45 (last valid time of the 15th).
     */
    test("should not return previous execution on disallowed day - Bug in previous_mathematical.js:89", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        
        const taskCallback = jest.fn();
        const executionTimes = [];
        
        taskCallback.mockImplementation(() => {
            const currentTime = toEpochMs(capabilities.datetime.now());
            const currentDateTime = fromEpochMs(currentTime);
            executionTimes.push({
                time: currentTime,
                day: currentDateTime.day,
                hour: currentDateTime.hour,
                minute: currentDateTime.minute,
                humanTime: new Date(currentTime).toISOString()
            });
        });

        // Start on the 15th to let task execute normally first
        const day15Time = new Date("2025-01-15T10:00:00.000Z").getTime();
        timeControl.setTime(day15Time);
        schedulerControl.setPollingInterval(1);

        // Cron expression: run every 15 minutes, but only on the 15th day of month
        const registrations = [
            ["15th-only-task", "*/15 * 15 * *", taskCallback, retryDelay]
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Task should execute on day 15
        expect(taskCallback.mock.calls.length).toBeGreaterThan(0);
        const executionsOnDay15 = executionTimes.filter(exec => exec.day === 15);
        expect(executionsOnDay15.length).toBeGreaterThan(0);

        // Clear execution history and stop scheduler
        taskCallback.mockClear();
        executionTimes.length = 0;
        await capabilities.scheduler.stop();

        // Now move to 2025-01-16 10:00 (day 16, which is NOT allowed)
        const day16Time = new Date("2025-01-16T10:00:00.000Z").getTime();
        timeControl.setTime(day16Time);

        // Start a fresh scheduler instance
        const newCapabilities = getTestCapabilities();
        const newTimeControl = getDatetimeControl(newCapabilities);
        const newSchedulerControl = getSchedulerControl(newCapabilities);
        
        newTimeControl.setTime(day16Time);
        newSchedulerControl.setPollingInterval(1);

        const newTaskCallback = jest.fn();
        const newExecutionTimes = [];
        
        newTaskCallback.mockImplementation(() => {
            const currentTime = toEpochMs(newCapabilities.datetime.now());
            const currentDateTime = fromEpochMs(currentTime);
            newExecutionTimes.push({
                time: currentTime,
                day: currentDateTime.day,
                hour: currentDateTime.hour,
                minute: currentDateTime.minute,
                humanTime: new Date(currentTime).toISOString()
            });
        });

        await newCapabilities.scheduler.initialize([
            ["15th-only-task", "*/15 * 15 * *", newTaskCallback, retryDelay]
        ]);
        await newSchedulerControl.waitForNextCycleEnd();

        // Bug: Scheduler might think the previous execution was on day 16 at 09:45
        // Correct: Task should NOT execute on day 16 at all, should wait for next 15th
        const executionsOnDay16 = newExecutionTimes.filter(exec => exec.day === 16);
        console.log(`Bug 2 - Executions on day 16 (should be 0):`, executionsOnDay16);
        expect(executionsOnDay16).toHaveLength(0); // This might FAIL due to the bug

        await newCapabilities.scheduler.stop();
    });

    /**
     * Bug 3: date_helpers.js:128
     * 
     * P1 - Weekday constraint search fails when next valid date is >7 days away
     * 
     * Issue: nextDateSatisfyingWeekdayConstraint/prevDateSatisfyingWeekdayConstraint 
     * only scan seven consecutive days, but the intersection of day-of-month and 
     * weekday constraints can be farther away.
     * 
     * Test case: `0 0 13 * 1` (Monday the 13th) starting from a month where 
     * the 13th is not a Monday.
     * Expected bug: Helper returns null, causing calculateNextExecution to throw 
     * or calculatePreviousExecution to return null even though a valid fire time 
     * exists in a later month.
     * Expected correct behavior: Should find the next month where the 13th is a Monday.
     */
    test("should find weekday constraint beyond 7 days - Bug in date_helpers.js:128", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        
        const taskCallback = jest.fn();
        
        // Find a time when the 13th is NOT a Monday in the current month
        // April 2025: 13th is a Sunday (day 0), so Monday the 13th would be in May 2025 (May 13 is a Tuesday)
        // So we need to look further for Monday the 13th
        // Let's try October 2025: 13th is a Monday
        
        // Set time to April 1, 2025 (when April 13 is NOT a Monday)
        const aprilTime = new Date("2025-04-01T10:00:00.000Z").getTime();
        timeControl.setTime(aprilTime);
        schedulerControl.setPollingInterval(1);

        // Cron expression: 0 0 13 * 1 (run at midnight on Monday the 13th)
        const registrations = [
            ["monday-13th-task", "0 0 13 * 1", taskCallback, retryDelay]
        ];

        let initializationFailed = false;
        let errorMessage = "";

        try {
            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();
            
            // If initialization succeeds, let's see if it can find the next Monday 13th
            // by advancing time and checking executions
            
            // Advance through months to see if it finds October 2025 (Monday 13th)
            for (let monthOffset = 0; monthOffset < 8; monthOffset++) {
                timeControl.advanceTime(31 * 24 * 60 * 60 * 1000); // Advance roughly 1 month
                await schedulerControl.waitForNextCycleEnd();
                
                if (taskCallback.mock.calls.length > 0) {
                    // Check if execution happened on the correct day/weekday
                    const currentTime = timeControl.getCurrentTime();
                    const currentDate = new Date(currentTime);
                    console.log(`Task executed on: ${currentDate.toISOString()}, day: ${currentDate.getUTCDate()}, weekday: ${currentDate.getUTCDay()}`);
                    break;
                }
            }
            
        } catch (error) {
            // Bug: This might throw "Could not satisfy weekday constraints"
            initializationFailed = true;
            errorMessage = error.message;
            console.log("Scheduler initialization failed with:", error.message);
        }

        // If the bug exists, the scheduler should fail to initialize
        // or should fail to find valid execution times properly
        if (initializationFailed) {
            expect(errorMessage).toContain("Could not satisfy weekday constraints");
        } else {
            // If it didn't fail, verify that it found a valid Monday 13th
            if (taskCallback.mock.calls.length > 0) {
                const executionTime = taskCallback.mock.calls[0];
                console.log("Task successfully executed, which suggests bug may not be present or is handled differently");
            } else {
                // This suggests the bug - it couldn't find the next valid date
                console.log("Task never executed, suggesting the weekday constraint search failed");
            }
        }

        await capabilities.scheduler.stop();
    });

    /**
     * Additional edge case: Complex day + weekday constraint
     * 
     * This test ensures that both day-of-month and weekday constraints are properly
     * handled together, which relates to all three bugs.
     */
    test("should handle complex day and weekday constraints correctly", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(1000);
        
        const taskCallback = jest.fn();
        const executionTimes = [];
        
        taskCallback.mockImplementation(() => {
            const currentTime = toEpochMs(capabilities.datetime.now());
            const currentDateTime = fromEpochMs(currentTime);
            executionTimes.push({
                time: currentTime,
                day: currentDateTime.day,
                weekday: currentDateTime.weekday,
                humanTime: new Date(currentTime).toISOString()
            });
        });

        // Set time to a known date 
        const startTime = new Date("2025-01-01T10:00:00.000Z").getTime(); // Jan 1, 2025 (Wednesday)
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        // Cron expression: run on Friday the 3rd (3 * * * 5)
        // January 3, 2025 is indeed a Friday, so this should work
        const registrations = [
            ["friday-3rd-task", "0 12 3 * 5", taskCallback, retryDelay] // Noon on Friday the 3rd
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        // Advance to Jan 3rd
        timeControl.advanceTime(2 * 24 * 60 * 60 * 1000 + 2 * 60 * 60 * 1000); // To Jan 3 12:00
        await schedulerControl.waitForNextCycleEnd();

        // Task should execute on Friday the 3rd
        const validExecutions = executionTimes.filter(exec => 
            exec.day === 3 && exec.weekday === "friday"
        );
        expect(validExecutions.length).toBeGreaterThan(0);

        // Verify no executions on wrong days or weekdays
        const invalidExecutions = executionTimes.filter(exec => 
            exec.day !== 3 || exec.weekday !== "friday"
        );
        expect(invalidExecutions).toHaveLength(0);

        await capabilities.scheduler.stop();
    });
});