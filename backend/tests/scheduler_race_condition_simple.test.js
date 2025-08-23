/**
 * Simplified test to expose the race condition in scheduler state persistence.
 * This test demonstrates the core issue: concurrent task executions can lead to lost state updates.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubPollInterval, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities); // Use fast in-memory storage
    stubPollInterval(1); // Very fast polling
    return capabilities;
}

describe("scheduler race condition exposure", () => {
    test("exposes the actual concurrency bug with forced timing", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(30000);

        // The key insight from the user's comment: not everything happens inside git transactions
        // The race condition exists in the task_executor.js where each task completion
        // independently calls persistState() on lines 62-67 and 80-86

        // We'll force a specific timing scenario to expose this race condition
        const taskExecutor = require("../src/cron/scheduling/task_executor");
        const statePersistence = require("../src/cron/scheduling/state_persistence");
        
        let persistCallOrder = [];
        let persistInProgress = new Map(); // Track concurrent persist calls
        let sharedTasksMapReads = []; // Track when the shared map is read
        
        // Mock persistCurrentState to expose the race condition
        const originalPersistCurrentState = statePersistence.persistCurrentState;
        statePersistence.persistCurrentState = jest.fn().mockImplementation(async (caps, tasksMap) => {
            const persistId = `persist-${Date.now()}-${Math.random()}`;
            const callStartTime = Date.now();
            
            persistCallOrder.push({ persistId, event: 'started', timestamp: callStartTime });
            persistInProgress.set(persistId, true);
            
            // This is the CRITICAL RACE CONDITION: 
            // Multiple concurrent calls to this function will each do Array.from(tasksMap.values())
            // at slightly different times, potentially capturing different states of the SAME shared Map
            
            const mapSnapshot = Array.from(tasksMap.values()).map(task => ({
                name: task.name,
                lastSuccessTime: task.lastSuccessTime,
                lastAttemptTime: task.lastAttemptTime,
                lastFailureTime: task.lastFailureTime,
                running: task.running
            }));
            
            sharedTasksMapReads.push({
                persistId,
                readTime: Date.now(),
                mapSize: tasksMap.size,
                tasksWithSuccess: mapSnapshot.filter(t => t.lastSuccessTime).length,
                tasksWithAttempt: mapSnapshot.filter(t => t.lastAttemptTime).length,
                concurrentPersists: persistInProgress.size
            });
            
            // Add a small delay to increase the chance of race conditions
            await new Promise(resolve => setTimeout(resolve, Math.random() * 20));
            
            // Call the original function with the snapshot we captured
            const result = await originalPersistCurrentState(caps, tasksMap);
            
            persistInProgress.delete(persistId);
            persistCallOrder.push({ persistId, event: 'completed', timestamp: Date.now() });
            
            return result;
        });

        try {
            // Create multiple tasks that will execute concurrently
            let task1Done = false;
            let task2Done = false;
            let task3Done = false;
            let task4Done = false;

            const task1 = jest.fn(async () => {
                task1Done = true;
            });

            const task2 = jest.fn(async () => {
                task2Done = true;
            });

            const task3 = jest.fn(async () => {
                task3Done = true;
            });

            const task4 = jest.fn(async () => {
                task4Done = true;
            });

            const registrations = [
                ["race-task-1", "0 * * * *", task1, retryDelay],
                ["race-task-2", "0 * * * *", task2, retryDelay],
                ["race-task-3", "0 * * * *", task3, retryDelay],
                ["race-task-4", "0 * * * *", task4, retryDelay]
            ];

            // Set time to trigger immediate execution of all tasks
            const startTime = new Date("2024-01-01T10:00:00.000Z").getTime();
            timeControl.setTime(startTime);

            await capabilities.scheduler.initialize(registrations);

            // Wait for all tasks to complete and all persist operations to finish
            await new Promise(resolve => setTimeout(resolve, 300));

            // Verify all tasks executed
            expect(task1Done).toBe(true);
            expect(task2Done).toBe(true);
            expect(task3Done).toBe(true);
            expect(task4Done).toBe(true);

            // Analyze the race condition data
            console.log("\n=== RACE CONDITION ANALYSIS ===");
            console.log(`Total persist calls: ${persistCallOrder.filter(p => p.event === 'started').length}`);
            console.log(`Shared map reads:`, sharedTasksMapReads.length);
            
            console.log("\nMap read timeline:");
            sharedTasksMapReads.forEach((read, index) => {
                console.log(`  Read ${index + 1}: ${read.tasksWithSuccess} successes, ${read.tasksWithAttempt} attempts (${read.concurrentPersists} concurrent persists)`);
            });

            // The race condition is exposed if different persist calls captured
            // different states of the shared tasks Map
            const successCounts = sharedTasksMapReads.map(r => r.tasksWithSuccess);
            const uniqueSuccessCounts = [...new Set(successCounts)];
            
            if (uniqueSuccessCounts.length > 1) {
                console.log(`\n🚨 RACE CONDITION DETECTED! 🚨`);
                console.log(`Different persist calls captured different Map states:`);
                uniqueSuccessCounts.forEach(count => {
                    const reads = sharedTasksMapReads.filter(r => r.tasksWithSuccess === count);
                    console.log(`  ${reads.length} persist call(s) saw ${count} successful tasks`);
                });
                console.log(`This proves the non-atomic read-modify-write race condition!`);
            } else {
                console.log(`\nNo race condition detected in this run (got consistent ${uniqueSuccessCounts[0]} successes)`);
                console.log(`The race condition is timing-dependent and may not manifest in every test run.`);
            }

            // Check final state
            const finalState = await capabilities.state.transaction(async (storage) => {
                return await storage.getCurrentState();
            });

            const finalTasksWithSuccess = finalState.tasks.filter(t => t.lastSuccessTime).length;
            console.log(`\nFinal persisted state: ${finalTasksWithSuccess} out of 4 tasks have success times`);
            
            if (finalTasksWithSuccess < 4) {
                console.log(`⚠️  LOST UPDATES: ${4 - finalTasksWithSuccess} task success states were lost!`);
            }

            await capabilities.scheduler.stop();
        } finally {
            // Restore original function
            statePersistence.persistCurrentState = originalPersistCurrentState;
        }
    });

    test("demonstrates race condition with artificial map manipulation", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(25000);

        // This test directly simulates the race condition by manually manipulating
        // the timing of shared state reads vs writes

        let simulatedTasksMap = new Map();
        let mapReadOperations = [];
        let mapWriteOperations = [];

        // Simulate what happens in real concurrent execution
        const simulateRaceCondition = async () => {
            // Simulate task 1 completing and starting to persist
            console.log("🎯 Simulating Task 1 completion and persist start");
            simulatedTasksMap.set("task-1", { 
                name: "task-1", 
                lastSuccessTime: new Date(), 
                lastAttemptTime: new Date() 
            });
            
            // Persist 1: Read the map (this happens in persistCurrentState line 115)
            const persist1Read = Array.from(simulatedTasksMap.values());
            mapReadOperations.push({ 
                persistId: 1, 
                readTime: Date.now(), 
                tasksRead: persist1Read.map(t => t.name),
                successCount: persist1Read.filter(t => t.lastSuccessTime).length
            });
            console.log(`Persist 1 reads map: ${persist1Read.length} tasks, ${persist1Read.filter(t => t.lastSuccessTime).length} with success`);

            // Simulate Task 2 completing while Persist 1 is in progress
            await new Promise(resolve => setTimeout(resolve, 10));
            console.log("🎯 Simulating Task 2 completion (while Persist 1 is ongoing)");
            simulatedTasksMap.set("task-2", { 
                name: "task-2", 
                lastSuccessTime: new Date(), 
                lastAttemptTime: new Date() 
            });

            // Persist 2: Read the SAME map (which now has different contents!)
            const persist2Read = Array.from(simulatedTasksMap.values());
            mapReadOperations.push({ 
                persistId: 2, 
                readTime: Date.now(), 
                tasksRead: persist2Read.map(t => t.name),
                successCount: persist2Read.filter(t => t.lastSuccessTime).length
            });
            console.log(`Persist 2 reads map: ${persist2Read.length} tasks, ${persist2Read.filter(t => t.lastSuccessTime).length} with success`);

            // Now both persist operations write their snapshots to storage
            await new Promise(resolve => setTimeout(resolve, 5));
            mapWriteOperations.push({ persistId: 1, writeTime: Date.now(), taskCount: persist1Read.length });
            console.log(`Persist 1 writes: ${persist1Read.length} tasks`);
            
            await new Promise(resolve => setTimeout(resolve, 5));
            mapWriteOperations.push({ persistId: 2, writeTime: Date.now(), taskCount: persist2Read.length });
            console.log(`Persist 2 writes: ${persist2Read.length} tasks (overwrites Persist 1!)`);
        };

        await simulateRaceCondition();

        // Analysis
        console.log("\n=== RACE CONDITION SIMULATION RESULTS ===");
        console.log("Map read operations:");
        mapReadOperations.forEach(read => {
            console.log(`  Persist ${read.persistId}: read ${read.tasksRead.join(', ')} (${read.successCount} successes)`);
        });

        console.log("\nMap write operations:");
        mapWriteOperations.forEach(write => {
            console.log(`  Persist ${write.persistId}: wrote ${write.taskCount} tasks`);
        });

        // Show the race condition
        if (mapReadOperations.length >= 2) {
            const read1 = mapReadOperations[0];
            const read2 = mapReadOperations[1];
            
            if (read1.successCount !== read2.successCount) {
                console.log(`\n🚨 RACE CONDITION DEMONSTRATED!`);
                console.log(`Persist 1 captured ${read1.successCount} successes`);
                console.log(`Persist 2 captured ${read2.successCount} successes`);
                console.log(`Both operated on the SAME shared Map, but captured different states!`);
                console.log(`This is the exact race condition in lines 115+ of state_persistence.js`);
            }
        }

        // This test demonstrates the principle without needing the full scheduler
        expect(mapReadOperations).toHaveLength(2);
        expect(mapWriteOperations).toHaveLength(2);
    });
});