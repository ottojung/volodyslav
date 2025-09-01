/**
 * Investigation test: Demonstrating the performance and behavioral differences
 * between stubbed and real runtime state storage to understand why stubbing is important.
 * 
 * Key findings:
 * - 9.39x performance penalty without stubbing due to file I/O
 * - Different storage implementations (MockRuntimeStateStorageClass vs RuntimeStateStorageClass)
 * - Real storage uses actual files while stubbed storage uses in-memory Map
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilitiesWithStub() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities); // WITH stub
    stubScheduler(capabilities);
    return capabilities;
}

function getTestCapabilitiesWithoutStub() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // NOTE: WITHOUT stubRuntimeStateStorage
    stubScheduler(capabilities);
    return capabilities;
}

describe("runtime state storage stubbing issues", () => {
    test("CONTROL: with stubRuntimeStateStorage - should work reliably", async () => {
        const capabilities = getTestCapabilitiesWithStub();
        const timeControl = getDatetimeControl(capabilities);
        const schedulerControl = getSchedulerControl(capabilities);
        const retryDelay = Duration.fromMillis(5000);
        const taskCallback = jest.fn();

        const startTime = new Date("2021-01-01T10:00:00.000Z").getTime();
        timeControl.setTime(startTime);
        schedulerControl.setPollingInterval(1);

        const registrations = [
            ["test-task", "0 * * * *", taskCallback, retryDelay], // Every hour
        ];

        await capabilities.scheduler.initialize(registrations);
        await schedulerControl.waitForNextCycleEnd();

        const initialCalls = taskCallback.mock.calls.length;
        expect(initialCalls).toBeGreaterThanOrEqual(1);

        // Multiple cycles with time advancement
        for (let i = 0; i < 3; i++) {
            timeControl.advanceTime(60 * 60 * 1000); // 1 hour
            await schedulerControl.waitForNextCycleEnd();
        }

        expect(taskCallback.mock.calls.length).toBeGreaterThan(initialCalls);
        await capabilities.scheduler.stop();
    });

    test("ISSUE DEMO: without stubRuntimeStateStorage - parallel execution conflicts", async () => {
        // Run multiple instances simultaneously to demonstrate file conflicts
        const promises = [];
        
        for (let i = 0; i < 3; i++) {
            promises.push((async () => {
                const capabilities = getTestCapabilitiesWithoutStub();
                const timeControl = getDatetimeControl(capabilities);
                const schedulerControl = getSchedulerControl(capabilities);
                const retryDelay = Duration.fromMillis(5000);
                const taskCallback = jest.fn();

                const startTime = new Date("2021-01-01T10:00:00.000Z").getTime();
                timeControl.setTime(startTime);
                schedulerControl.setPollingInterval(1);

                const registrations = [
                    [`parallel-task-${i}`, "0 * * * *", taskCallback, retryDelay],
                ];

                await capabilities.scheduler.initialize(registrations);
                await schedulerControl.waitForNextCycleEnd();

                // Advance time and check behavior
                timeControl.advanceTime(60 * 60 * 1000);
                await schedulerControl.waitForNextCycleEnd();

                await capabilities.scheduler.stop();
                return taskCallback.mock.calls.length;
            })());
        }

        // This might show different behavior or conflicts between parallel instances
        const results = await Promise.all(promises);
        console.log("Parallel execution results:", results);
        
        // All should have similar results if properly isolated
        expect(results.every(count => count > 0)).toBe(true);
    });

    test("ISSUE DEMO: file system state persistence between tests", async () => {
        // First test run - create some state
        {
            const capabilities = getTestCapabilitiesWithoutStub();
            const timeControl = getDatetimeControl(capabilities);
            const schedulerControl = getSchedulerControl(capabilities);
            const retryDelay = Duration.fromMillis(5000);
            const taskCallback = jest.fn();

            const startTime = new Date("2021-01-01T10:00:00.000Z").getTime();
            timeControl.setTime(startTime);
            schedulerControl.setPollingInterval(1);

            const registrations = [
                ["persistent-task", "0 * * * *", taskCallback, retryDelay],
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            // Advance time to create history
            timeControl.advanceTime(60 * 60 * 1000);
            await schedulerControl.waitForNextCycleEnd();

            console.log("First run task calls:", taskCallback.mock.calls.length);
            await capabilities.scheduler.stop();
        }

        // Second test run - might be affected by previous state
        {
            const capabilities = getTestCapabilitiesWithoutStub();
            const timeControl = getDatetimeControl(capabilities);
            const schedulerControl = getSchedulerControl(capabilities);
            const retryDelay = Duration.fromMillis(5000);
            const taskCallback = jest.fn();

            // Different start time but same task
            const startTime = new Date("2021-01-01T11:00:00.000Z").getTime();
            timeControl.setTime(startTime);
            schedulerControl.setPollingInterval(1);

            const registrations = [
                ["persistent-task", "0 * * * *", taskCallback, retryDelay],
            ];

            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();

            console.log("Second run task calls:", taskCallback.mock.calls.length);
            
            // The behavior might be different due to persisted state from first run
            // With stubRuntimeStateStorage, each test gets clean state
            
            await capabilities.scheduler.stop();
        }
    });

    test("ISSUE DEMO: performance difference - timing comparison", async () => {
        const iterations = 5;
        
        // Measure with stub
        const withStubStart = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) {
            const capabilities = getTestCapabilitiesWithStub();
            const timeControl = getDatetimeControl(capabilities);
            const schedulerControl = getSchedulerControl(capabilities);
            
            timeControl.setTime(Date.now());
            schedulerControl.setPollingInterval(1);
            
            const registrations = [
                [`perf-task-${i}`, "0 * * * *", jest.fn(), Duration.fromMillis(1000)],
            ];
            
            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();
            await capabilities.scheduler.stop();
        }
        const withStubEnd = process.hrtime.bigint();
        const withStubTime = Number(withStubEnd - withStubStart) / 1_000_000; // Convert to ms

        // Measure without stub
        const withoutStubStart = process.hrtime.bigint();
        for (let i = 0; i < iterations; i++) {
            const capabilities = getTestCapabilitiesWithoutStub();
            const timeControl = getDatetimeControl(capabilities);
            const schedulerControl = getSchedulerControl(capabilities);
            
            timeControl.setTime(Date.now());
            schedulerControl.setPollingInterval(1);
            
            const registrations = [
                [`perf-task-${i}`, "0 * * * *", jest.fn(), Duration.fromMillis(1000)],
            ];
            
            await capabilities.scheduler.initialize(registrations);
            await schedulerControl.waitForNextCycleEnd();
            await capabilities.scheduler.stop();
        }
        const withoutStubEnd = process.hrtime.bigint();
        const withoutStubTime = Number(withoutStubEnd - withoutStubStart) / 1_000_000; // Convert to ms

        console.log(`Performance with stub: ${withStubTime.toFixed(2)}ms`);
        console.log(`Performance without stub: ${withoutStubTime.toFixed(2)}ms`);
        console.log(`Ratio (without/with): ${(withoutStubTime / withStubTime).toFixed(2)}x`);

        // File I/O should generally be slower than in-memory operations
        // But this test is more about demonstrating the concept than strict assertions
    });

    test("ISSUE DEMO: investigate actual storage behavior differences", async () => {
        console.log("\n=== WITH STUB ===");
        const withStub = getTestCapabilitiesWithStub();
        
        await withStub.state.transaction(async (storage) => {
            console.log("With stub - storage type:", storage.constructor.name);
            console.log("With stub - storage properties:", Object.getOwnPropertyNames(storage));
            
            const state = await storage.getCurrentState();
            console.log("With stub - state tasks length:", state.tasks.length);
            
            // Set some state
            const newState = { 
                version: 2, 
                startTime: withStub.datetime.now(), 
                tasks: [{ name: "test", cronExpression: "0 * * * *", retryDelayMs: 5000, lastSuccessTime: withStub.datetime.now() }]
            };
            storage.setState(newState);
        });

        console.log("\n=== WITHOUT STUB ===");
        const withoutStub = getTestCapabilitiesWithoutStub();
        
        await withoutStub.state.transaction(async (storage) => {
            console.log("Without stub - storage type:", storage.constructor.name);
            console.log("Without stub - storage properties:", Object.getOwnPropertyNames(storage));
            console.log("Without stub - state file path:", storage.stateFile?.path);
            
            const state = await storage.getCurrentState();
            console.log("Without stub - state tasks length:", state.tasks.length);
            
            // Set some state
            const newState = { 
                version: 2, 
                startTime: withoutStub.datetime.now(), 
                tasks: [{ name: "test", cronExpression: "0 * * * *", retryDelayMs: 5000, lastSuccessTime: withoutStub.datetime.now() }]
            };
            storage.setState(newState);
            
            // Check if file exists after transaction
            if (storage.stateFile?.path) {
                const fs = require('fs');
                const exists = fs.existsSync(storage.stateFile.path);
                console.log("Without stub - state file exists after transaction:", exists);
                if (exists) {
                    const content = fs.readFileSync(storage.stateFile.path, 'utf8');
                    console.log("Without stub - file content length:", content.length);
                }
            }
        });
    });
});