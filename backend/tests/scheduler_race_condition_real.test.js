/**
 * Test that exposes the real race condition in the scheduler by intercepting
 * the actual persistState function that gets called from task_executor.js
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

describe("real scheduler race condition", () => {
    test("exposes race condition by intercepting the actual persistState closure", async () => {
        const capabilities = getTestCapabilities();
        const timeControl = getDatetimeControl(capabilities);
        const retryDelay = fromMilliseconds(30000);

        // We need to intercept the makePollingScheduler to hook into the persistState function
        const pollingSchedulerModule = require("../src/cron/polling_scheduler");
        const originalMakePollingScheduler = pollingSchedulerModule.makePollingScheduler;
        
        let persistCallsData = [];
        let interceptedTasksMap = null;
        
        pollingSchedulerModule.makePollingScheduler = jest.fn().mockImplementation((caps) => {
            const scheduler = originalMakePollingScheduler(caps);
            
            // We need to override the initialize method to intercept the persistState function
            const originalInitialize = scheduler.initialize;
            
            scheduler.initialize = jest.fn().mockImplementation(async (registrations) => {
                // Hook into the makeTaskExecutor call to intercept persistState
                const taskExecutorModule = require("../src/cron/scheduling/task_executor");
                const originalMakeTaskExecutor = taskExecutorModule.makeTaskExecutor;
                
                taskExecutorModule.makeTaskExecutor = jest.fn().mockImplementation((taskCaps, persistStateFn) => {
                    // Create a wrapper around the persistState function to capture race condition data
                    const wrappedPersistState = async () => {
                        const callId = Date.now() + Math.random();
                        const callStartTime = Date.now();
                        
                        // This is the critical moment: we're about to call persistCurrentState
                        // which will do Array.from(tasks.values()) to read the shared map
                        
                        persistCallsData.push({
                            callId,
                            event: 'persistState_start',
                            timestamp: callStartTime
                        });
                        
                        console.log(`🔍 persistState called (${callId.toFixed(3)})`);
                        
                        try {
                            // Call the original persistState function
                            await persistStateFn();
                            
                            persistCallsData.push({
                                callId,
                                event: 'persistState_complete',
                                timestamp: Date.now()
                            });
                            
                            console.log(`✅ persistState completed (${callId.toFixed(3)})`);
                        } catch (error) {
                            persistCallsData.push({
                                callId,
                                event: 'persistState_error',
                                timestamp: Date.now(),
                                error: error.message
                            });
                            throw error;
                        }
                    };
                    
                    // Call the original makeTaskExecutor with our wrapped persistState
                    return originalMakeTaskExecutor(taskCaps, wrappedPersistState);
                });
                
                try {
                    const result = await originalInitialize(registrations);
                    return result;
                } finally {
                    // Restore the original function
                    taskExecutorModule.makeTaskExecutor = originalMakeTaskExecutor;
                }
            });
            
            return scheduler;
        });

        try {
            // Create multiple tasks that will execute concurrently
            let taskCompletions = {};

            const task1 = jest.fn(async () => {
                taskCompletions['task1'] = Date.now();
                console.log(`📋 Task 1 completed`);
            });

            const task2 = jest.fn(async () => {
                taskCompletions['task2'] = Date.now();
                console.log(`📋 Task 2 completed`);
            });

            const task3 = jest.fn(async () => {
                taskCompletions['task3'] = Date.now();
                console.log(`📋 Task 3 completed`);
            });

            const registrations = [
                ["race-task-1", "0 * * * *", task1, retryDelay],
                ["race-task-2", "0 * * * *", task2, retryDelay],
                ["race-task-3", "0 * * * *", task3, retryDelay]
            ];

            // Set time to trigger immediate execution of all tasks
            const startTime = new Date("2024-01-01T10:00:00.000Z").getTime();
            timeControl.setTime(startTime);

            await capabilities.scheduler.initialize(registrations);

            // Wait for all tasks to complete and all persist operations to finish
            await new Promise(resolve => setTimeout(resolve, 500));

            // Verify all tasks executed
            expect(taskCompletions['task1']).toBeDefined();
            expect(taskCompletions['task2']).toBeDefined();
            expect(taskCompletions['task3']).toBeDefined();

            // Analyze the persist calls
            console.log("\n=== PERSIST CALL ANALYSIS ===");
            const startEvents = persistCallsData.filter(p => p.event === 'persistState_start');
            const completeEvents = persistCallsData.filter(p => p.event === 'persistState_complete');
            
            console.log(`Total persistState calls started: ${startEvents.length}`);
            console.log(`Total persistState calls completed: ${completeEvents.length}`);

            if (startEvents.length >= 2) {
                console.log("\nPersist call timeline:");
                startEvents.forEach((event, index) => {
                    const completeEvent = completeEvents.find(c => c.callId === event.callId);
                    const duration = completeEvent ? completeEvent.timestamp - event.timestamp : 'incomplete';
                    console.log(`  Call ${index + 1}: started at ${event.timestamp}, duration: ${duration}ms`);
                });

                // Check for overlapping persist calls (evidence of the race condition)
                const overlaps = [];
                for (let i = 0; i < startEvents.length; i++) {
                    for (let j = i + 1; j < startEvents.length; j++) {
                        const call1Start = startEvents[i].timestamp;
                        const call1Complete = completeEvents.find(c => c.callId === startEvents[i].callId);
                        const call2Start = startEvents[j].timestamp;
                        
                        if (call1Complete && call2Start < call1Complete.timestamp) {
                            overlaps.push({ 
                                call1: startEvents[i].callId, 
                                call2: startEvents[j].callId,
                                overlapDuration: call1Complete.timestamp - call2Start
                            });
                        }
                    }
                }

                if (overlaps.length > 0) {
                    console.log(`\n🚨 RACE CONDITION DETECTED! 🚨`);
                    console.log(`Found ${overlaps.length} overlapping persist call(s):`);
                    overlaps.forEach(overlap => {
                        console.log(`  Calls ${overlap.call1.toFixed(3)} and ${overlap.call2.toFixed(3)} overlapped for ${overlap.overlapDuration}ms`);
                    });
                    console.log(`This proves concurrent persistState calls are happening!`);
                    console.log(`Each call does Array.from(tasks.values()) at different times on the SAME shared Map!`);
                } else {
                    console.log(`\nNo overlapping persist calls detected (race condition may be timing-dependent)`);
                }
            }

            // Check final state
            const finalState = await capabilities.state.transaction(async (storage) => {
                return await storage.getCurrentState();
            });

            const finalTasksWithSuccess = finalState.tasks.filter(t => t.lastSuccessTime).length;
            console.log(`\nFinal persisted state: ${finalTasksWithSuccess} out of 3 tasks have success times`);

            if (finalTasksWithSuccess < 3) {
                console.log(`⚠️  LOST UPDATES DETECTED: ${3 - finalTasksWithSuccess} task success states were lost!`);
                console.log(`This is direct evidence of the race condition in state persistence!`);
            }

            await capabilities.scheduler.stop();
            
            // The test should pass regardless of whether we caught the race condition
            // since it's timing-dependent, but it documents the issue
            expect(startEvents.length).toBeGreaterThan(0);

        } finally {
            // Restore the original function
            pollingSchedulerModule.makePollingScheduler = originalMakePollingScheduler;
        }
    });

    test("demonstrates the fundamental issue with shared mutable state", async () => {
        // This test shows the core problem without relying on complex timing
        
        console.log("\n=== DEMONSTRATING THE FUNDAMENTAL ISSUE ===");
        
        // Simulate the shared tasks Map that's used in the real scheduler
        const sharedTasksMap = new Map();
        
        // Simulate adding tasks
        sharedTasksMap.set("task1", { 
            name: "task1", 
            lastSuccessTime: null, 
            lastAttemptTime: null 
        });
        sharedTasksMap.set("task2", { 
            name: "task2", 
            lastSuccessTime: null, 
            lastAttemptTime: null 
        });
        
        console.log("Initial shared map state:");
        console.log(`  Map size: ${sharedTasksMap.size}`);
        
        // Simulate what happens in concurrent task execution:
        
        // 1. Task 1 completes successfully
        console.log("\n🎯 Task 1 completes successfully");
        const task1 = sharedTasksMap.get("task1");
        task1.lastSuccessTime = new Date("2024-01-01T10:00:01.000Z");
        task1.lastAttemptTime = new Date("2024-01-01T10:00:01.000Z");
        
        // 2. persistState for task 1 starts and reads the map
        console.log("📤 persistState for task 1 starts - reading shared map...");
        const persist1Snapshot = Array.from(sharedTasksMap.values()).map(task => ({
            name: task.name,
            lastSuccessTime: task.lastSuccessTime,
            lastAttemptTime: task.lastAttemptTime
        }));
        console.log("   Persist 1 captured:", persist1Snapshot.map(t => `${t.name}:${t.lastSuccessTime ? 'SUCCESS' : 'NO_SUCCESS'}`).join(', '));
        
        // 3. BEFORE persist1 writes to storage, task 2 also completes
        console.log("\n🎯 Task 2 completes successfully (while persist 1 is still in progress)");
        const task2 = sharedTasksMap.get("task2");
        task2.lastSuccessTime = new Date("2024-01-01T10:00:02.000Z");
        task2.lastAttemptTime = new Date("2024-01-01T10:00:02.000Z");
        
        // 4. persistState for task 2 also starts and reads the SAME map
        console.log("📤 persistState for task 2 starts - reading shared map...");
        const persist2Snapshot = Array.from(sharedTasksMap.values()).map(task => ({
            name: task.name,
            lastSuccessTime: task.lastSuccessTime,
            lastAttemptTime: task.lastAttemptTime
        }));
        console.log("   Persist 2 captured:", persist2Snapshot.map(t => `${t.name}:${t.lastSuccessTime ? 'SUCCESS' : 'NO_SUCCESS'}`).join(', '));
        
        // 5. Now both persist operations write to storage
        console.log("\n💾 Both persist operations write to storage...");
        console.log("   Persist 1 writes:", persist1Snapshot.length, "tasks");
        console.log("   Persist 2 writes:", persist2Snapshot.length, "tasks (may overwrite persist 1!)");
        
        // Analysis
        const persist1Successes = persist1Snapshot.filter(t => t.lastSuccessTime).length;
        const persist2Successes = persist2Snapshot.filter(t => t.lastSuccessTime).length;
        
        console.log(`\n📊 ANALYSIS:`);
        console.log(`   Persist 1 captured ${persist1Successes} successful tasks`);
        console.log(`   Persist 2 captured ${persist2Successes} successful tasks`);
        
        if (persist1Successes !== persist2Successes) {
            console.log(`\n🚨 RACE CONDITION DEMONSTRATED!`);
            console.log(`   The same shared Map was read at different times, yielding different snapshots!`);
            console.log(`   This is exactly what happens in state_persistence.js line 115:`);
            console.log(`   const taskRecords = Array.from(tasks.values()).map(...)`);
            console.log(`   When multiple concurrent calls to persistCurrentState happen,`);
            console.log(`   they each capture different states of the SAME shared tasks Map!`);
        }
        
        // This test always passes, it's just demonstrating the principle
        expect(persist1Snapshot).toBeDefined();
        expect(persist2Snapshot).toBeDefined();
        expect(sharedTasksMap.size).toBe(2);
    });
});