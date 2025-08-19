/**
 * Tests for polling scheduler state management and persistence edge cases.
 * Focuses on transaction behavior, state corruption, and recovery scenarios.
 */

const { makePollingScheduler } = require("../src/cron/polling_scheduler");
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

describe("polling scheduler state management edge cases", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe("transaction edge cases", () => {
        test("should handle transaction failures during state persistence", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Mock transaction to fail on write
            let transactionCallCount = 0;
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    transactionCallCount++;
                    if (transactionCallCount > 2) {
                        throw new Error("Transaction failed");
                    }
                    
                    const mockStorage = {
                        getExistingState: jest.fn(() => null),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn(() => {
                            if (transactionCallCount > 2) {
                                throw new Error("State write failed");
                            }
                        })
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should schedule successfully (first transaction)
            await scheduler.schedule("test-task", "* * * * *", taskCallback, retryDelay);
            
            // Should schedule another task successfully (second transaction)
            await scheduler.schedule("test-task-2", "* * * * *", taskCallback, retryDelay);
            
            // Third operation should fail but not crash
            await expect(scheduler.schedule("test-task-3", "* * * * *", taskCallback, retryDelay))
                .rejects.toThrow("Transaction failed");
            
            // Scheduler should still be functional for existing tasks
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalled();
            
            jest.unmock("../src/runtime_state_storage");
        });

        test("should handle partial state writes", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Mock transaction to simulate partial write
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    let setStateCallCount = 0;
                    const mockStorage = {
                        getExistingState: jest.fn(() => null),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn((_state) => {
                            setStateCallCount++;
                            if (setStateCallCount > 1) {
                                // Simulate partial write by modifying state incompletely
                                throw new Error("Disk full - partial write");
                            }
                        })
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // First task should succeed
            await scheduler.schedule("task-1", "* * * * *", taskCallback, retryDelay);
            
            // Second task should fail due to partial write
            await expect(scheduler.schedule("task-2", "* * * * *", taskCallback, retryDelay))
                .rejects.toThrow("Disk full");
            
            // Scheduler should continue working despite write failure
            await scheduler._poll();
            
            jest.unmock("../src/runtime_state_storage");
        });

        test("should handle concurrent state access", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule multiple tasks concurrently
            const schedulePromises = [
                scheduler.schedule("concurrent-1", "* * * * *", taskCallback, retryDelay),
                scheduler.schedule("concurrent-2", "* * * * *", taskCallback, retryDelay),
                scheduler.schedule("concurrent-3", "* * * * *", taskCallback, retryDelay)
            ];
            
            // All should complete successfully
            const results = await Promise.all(schedulePromises);
            expect(results).toHaveLength(3);
            expect(results).toEqual(["concurrent-1", "concurrent-2", "concurrent-3"]);
            
            // All tasks should be present
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(3);
            
            await scheduler.cancelAll();
        });

        test("should handle git operation failures during persistence", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Mock git command to fail
            const originalGit = capabilities.git;
            capabilities.git = {
                ...originalGit,
                execute: jest.fn(() => {
                    throw new Error("Git operation failed");
                })
            };
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should handle git failures gracefully (not crash the scheduler)
            await scheduler.schedule("git-fail-test", "* * * * *", taskCallback, retryDelay);
            
            // Scheduler should continue working despite git failures
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalled();
            
            // Restore original git
            capabilities.git = originalGit;
            
            await scheduler.cancelAll();
        });
    });

    describe("state corruption recovery", () => {
        test("should recover from completely corrupted state file", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Mock storage to return completely invalid data
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    const mockStorage = {
                        getExistingState: jest.fn(() => {
                            throw new Error("JSON parse error - corrupted file");
                        }),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn()
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should start with empty state despite corruption
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(0);
            
            // Should be able to schedule new tasks
            await scheduler.schedule("recovery-test", "* * * * *", taskCallback, retryDelay);
            
            const newTasks = await scheduler.getTasks();
            expect(newTasks).toHaveLength(1);
            
            jest.unmock("../src/runtime_state_storage");
        });

        test("should handle state with invalid version", async () => {
            const capabilities = caps();
            
            // Mock storage to return state with invalid version
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    const mockStorage = {
                        getExistingState: jest.fn(() => ({
                            version: 999, // Invalid version
                            startTime: capabilities.datetime.now(),
                            tasks: [{
                                name: "version-test",
                                cronExpression: "* * * * *",
                                retryDelayMs: 5000
                            }]
                        })),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn()
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should handle invalid version gracefully
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1); // Task should still be loaded
            
            jest.unmock("../src/runtime_state_storage");
        });

        test("should handle state with mixed valid and invalid tasks", async () => {
            const capabilities = caps();
            
            // Mock storage with mixed valid/invalid tasks
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    const mockStorage = {
                        getExistingState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: [
                                {
                                    name: "valid-task",
                                    cronExpression: "* * * * *",
                                    retryDelayMs: 5000
                                },
                                {
                                    name: "invalid-cron",
                                    cronExpression: "invalid expression",
                                    retryDelayMs: 5000
                                },
                                {
                                    // Missing name
                                    cronExpression: "* * * * *",
                                    retryDelayMs: 5000
                                },
                                {
                                    name: "another-valid",
                                    cronExpression: "0 * * * *",
                                    retryDelayMs: 3000
                                }
                            ]
                        })),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn()
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should load only valid tasks
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(2);
            expect(tasks.map(t => t.name)).toEqual(["valid-task", "another-valid"]);
            
            jest.unmock("../src/runtime_state_storage");
        });

        test("should handle state with circular references", async () => {
            const capabilities = caps();
            
            // Mock storage to return state with circular reference
            jest.doMock("../src/runtime_state_storage", () => ({
                transaction: jest.fn(async (caps, callback) => {
                    const circularTask = {
                        name: "circular-task",
                        cronExpression: "* * * * *",
                        retryDelayMs: 5000
                    };
                    circularTask.self = circularTask; // Circular reference
                    
                    const mockStorage = {
                        getExistingState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: [circularTask]
                        })),
                        getCurrentState: jest.fn(() => ({
                            version: 2,
                            startTime: capabilities.datetime.now(),
                            tasks: []
                        })),
                        setState: jest.fn()
                    };
                    return callback(mockStorage);
                })
            }));
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should handle circular references gracefully
            const tasks = await scheduler.getTasks();
            // Depending on implementation, might load the task or skip it
            // The important thing is that it doesn't crash
            expect(Array.isArray(tasks)).toBe(true);
            
            jest.unmock("../src/runtime_state_storage");
        });
    });

    describe("large state scenarios", () => {
        test("should handle very large number of tasks", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule 1000 tasks
            const schedulePromises = [];
            for (let i = 0; i < 1000; i++) {
                const callback = jest.fn();
                schedulePromises.push(
                    scheduler.schedule(`task-${i}`, "* * * * *", callback, retryDelay)
                );
            }
            
            // All should complete
            await Promise.all(schedulePromises);
            
            // Verify all tasks are present
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1000);
            
            // Performance test - getting tasks should be reasonable
            const startTime = Date.now();
            await scheduler.getTasks();
            const endTime = Date.now();
            expect(endTime - startTime).toBeLessThan(1000); // Under 1 second
            
            await scheduler.cancelAll();
        });

        test("should handle tasks with very long names and expressions", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Very long task name
            const longName = "x".repeat(10000);
            
            await scheduler.schedule(longName, "* * * * *", taskCallback, retryDelay);
            
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].name).toBe(longName);
            
            await scheduler.cancelAll();
        });

        test("should handle rapid schedule/cancel cycles", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Rapidly schedule and cancel tasks
            for (let cycle = 0; cycle < 100; cycle++) {
                const taskName = `cycle-task-${cycle}`;
                const callback = jest.fn();
                
                await scheduler.schedule(taskName, "* * * * *", callback, retryDelay);
                
                // Immediately cancel
                const cancelled = await scheduler.cancel(taskName);
                expect(cancelled).toBe(true);
            }
            
            // Should end up with no tasks
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(0);
        });

        test("should handle state serialization of complex task states", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task and execute to create complex state
            let callCount = 0;
            const complexCallback = jest.fn(() => {
                callCount++;
                if (callCount <= 2) {
                    throw new Error(`Failure ${callCount}`);
                }
            });
            
            await scheduler.schedule("complex-state", "* * * * *", complexCallback, retryDelay);
            
            // Execute multiple times to build up state history
            await scheduler._poll(); // First execution - failure
            
            // Advance time for retry
            jest.setSystemTime(new Date("2024-01-15T12:05:01Z"));
            await scheduler._poll(); // Retry - failure
            
            // Advance time for another retry
            jest.setSystemTime(new Date("2024-01-15T12:10:02Z"));
            await scheduler._poll(); // Success
            
            // Verify complex state
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].lastSuccessTime).toBeTruthy();
            expect(tasks[0].lastFailureTime).toBeTruthy();
            expect(tasks[0].lastAttemptTime).toBeTruthy();
            expect(tasks[0].pendingRetryUntil).toBeFalsy(); // Should be cleared after success
            
            await scheduler.cancelAll();
        });
    });

    describe("memory and resource management", () => {
        test("should not leak memory with frequent operations", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            const initialMemory = process.memoryUsage();
            
            // Perform many operations
            for (let i = 0; i < 1000; i++) {
                const taskName = `memory-test-${i}`;
                const callback = jest.fn();
                
                await scheduler.schedule(taskName, "* * * * *", callback, retryDelay);
                await scheduler.cancel(taskName);
                
                // Occasional poll to exercise execution paths
                if (i % 100 === 0) {
                    await scheduler._poll();
                }
            }
            
            // Force garbage collection if available
            if (global.gc) {
                global.gc();
            }
            
            const finalMemory = process.memoryUsage();
            
            // Memory usage should not grow excessively
            const heapGrowth = finalMemory.heapUsed - initialMemory.heapUsed;
            expect(heapGrowth).toBeLessThan(50 * 1024 * 1024); // Less than 50MB growth
            
            await scheduler.cancelAll();
        });

        test("should handle resource exhaustion gracefully", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Mock filesystem to simulate resource exhaustion
            const originalCreator = capabilities.creator;
            capabilities.creator = {
                ...originalCreator,
                createFile: jest.fn(() => {
                    throw new Error("ENOSPC: no space left on device");
                })
            };
            
            const taskCallback = jest.fn();
            
            // Should handle resource exhaustion during state persistence
            await scheduler.schedule("resource-test", "* * * * *", taskCallback, retryDelay);
            
            // Scheduler should continue functioning despite storage issues
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalled();
            
            // Restore original creator
            capabilities.creator = originalCreator;
            
            await scheduler.cancelAll();
        });

        test("should handle very frequent state updates", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(100); // Very short retry delay
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
            
            // Task that fails frequently, causing frequent state updates
            let failureCount = 0;
            const frequentFailureCallback = jest.fn(() => {
                failureCount++;
                if (failureCount < 10) {
                    throw new Error(`Failure ${failureCount}`);
                }
            });
            
            await scheduler.schedule("frequent-updates", "* * * * *", frequentFailureCallback, retryDelay);
            
            // Run many polls to trigger frequent state updates
            for (let i = 0; i < 15; i++) {
                await scheduler._poll();
                jest.advanceTimersByTime(150); // Advance past retry delay
            }
            
            // Should eventually succeed
            expect(frequentFailureCallback).toHaveBeenCalledTimes(10);
            
            // Final state should be consistent
            const tasks = await scheduler.getTasks();
            expect(tasks[0].lastSuccessTime).toBeTruthy();
            
            await scheduler.cancelAll();
        });
    });

    describe("edge cases in state transitions", () => {
        test("should handle task state changes during polling", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            const taskCallback = jest.fn();
            
            await scheduler.schedule("state-transition", "* * * * *", taskCallback, retryDelay);
            
            // Start a poll operation
            const pollPromise = scheduler._poll();
            
            // While poll is running, try to cancel the task
            const cancelPromise = scheduler.cancel("state-transition");
            
            // Both operations should complete without error
            await Promise.all([pollPromise, cancelPromise]);
            
            // Task should be cancelled
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(0);
        });

        test("should handle scheduler restart during task execution", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            
            // Simulate long-running task
            const longTask = jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 10000)); // 10 seconds
            });
            
            const scheduler1 = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler1.schedule("long-task", "* * * * *", longTask, retryDelay);
            
            // Start task execution but don't wait for completion
            scheduler1._poll(); // Don't await
            
            // Simulate scheduler restart before task completion
            await scheduler1.cancelAll();
            
            // Create new scheduler instance
            const scheduler2 = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Re-register the task (simulating application restart)
            await scheduler2.schedule("long-task", "* * * * *", longTask, retryDelay);
            
            // Should be able to operate normally
            const tasks = await scheduler2.getTasks();
            expect(tasks).toHaveLength(1);
            
            await scheduler2.cancelAll();
        });

        test("should handle duplicate task registration edge cases", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            
            // Schedule first task
            await scheduler.schedule("duplicate-test", "* * * * *", callback1, retryDelay);
            
            // Try to schedule duplicate - should fail
            await expect(
                scheduler.schedule("duplicate-test", "0 * * * *", callback2, retryDelay)
            ).rejects.toThrow("duplicate");
            
            // Original task should still work
            await scheduler._poll();
            expect(callback1).toHaveBeenCalled();
            expect(callback2).not.toHaveBeenCalled();
            
            await scheduler.cancelAll();
        });
    });
});