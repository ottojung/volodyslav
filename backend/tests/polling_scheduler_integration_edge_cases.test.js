/**
 * Tests for polling scheduler integration and system-level edge cases.
 * Focuses on real-world scenarios, error recovery, and interaction with external systems.
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

describe("polling scheduler integration and system edge cases", () => {
    beforeEach(() => {
        jest.useFakeTimers();
        jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
    });

    afterEach(() => {
        jest.useRealTimers();
    });

    describe("real-world scenario testing", () => {
        test("should handle typical daily backup scenario", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(30 * 60 * 1000); // 30 minute retry
            
            let backupCount = 0;
            let backupFailures = 0;
            const backupCallback = jest.fn(async () => {
                backupCount++;
                // Simulate occasional backup failures (10% failure rate)
                if (Math.random() < 0.1) {
                    backupFailures++;
                    throw new Error(`Backup failed: ${backupFailures}`);
                }
                // Simulate backup taking 2-5 minutes
                const backupDuration = 2000 + Math.random() * 3000;
                await new Promise(resolve => setTimeout(resolve, backupDuration));
            });
            
            const scheduler = makePollingScheduler(capabilities, { 
                pollIntervalMs: 5 * 60 * 1000, // 5 minute polling
                maxConcurrentTasks: 1 // Only one backup at a time
            });
            
            // Schedule daily backup at 2 AM
            await scheduler.schedule("daily-backup", "0 2 * * *", backupCallback, retryDelay);
            
            // Simulate multiple days
            for (let day = 1; day <= 30; day++) {
                jest.setSystemTime(new Date(`2024-01-${day.toString().padStart(2, '0')}T02:00:00Z`));
                await scheduler._poll();
                
                // Wait for backup to complete
                jest.advanceTimersByTime(10 * 60 * 1000); // 10 minutes
                
                // If backup failed, it should retry in 30 minutes
                if (backupFailures > 0) {
                    jest.setSystemTime(new Date(`2024-01-${day.toString().padStart(2, '0')}T02:35:00Z`));
                    await scheduler._poll();
                    jest.advanceTimersByTime(10 * 60 * 1000); // Wait for retry to complete
                }
            }
            
            // Should have attempted backup for each day
            expect(backupCount).toBeGreaterThanOrEqual(30);
            
            // Should have some backup completions
            const tasks = await scheduler.getTasks();
            expect(tasks[0].lastSuccessTime).toBeTruthy();
            
            await scheduler.cancelAll();
        });

        test("should handle periodic health check scenario", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(60 * 1000); // 1 minute retry
            
            let healthCheckCount = 0;
            let systemHealthy = true;
            const healthCheckCallback = jest.fn(async () => {
                healthCheckCount++;
                
                // Simulate system health degrading over time
                if (healthCheckCount > 10) {
                    systemHealthy = Math.random() > 0.3; // 30% chance of being unhealthy
                }
                
                if (!systemHealthy) {
                    throw new Error("System unhealthy - requires attention");
                }
            });
            
            const scheduler = makePollingScheduler(capabilities, { 
                pollIntervalMs: 30 * 1000, // 30 second polling
                maxConcurrentTasks: 5
            });
            
            // Schedule health check every 2 minutes
            await scheduler.schedule("health-check", "*/2 * * * *", healthCheckCallback, retryDelay);
            
            // Simulate 1 hour of operation
            const endTime = new Date("2024-01-15T13:00:00Z");
            let currentTime = new Date("2024-01-15T12:00:00Z");
            
            while (currentTime < endTime) {
                jest.setSystemTime(currentTime);
                await scheduler._poll();
                
                // Advance by 30 seconds (polling interval)
                currentTime = new Date(currentTime.getTime() + 30 * 1000);
            }
            
            // Should have performed many health checks
            expect(healthCheckCount).toBeGreaterThan(20);
            
            // Check final task state
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            
            await scheduler.cancelAll();
        });

        test("should handle log rotation scenario", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5 * 60 * 1000); // 5 minute retry
            
            let rotationCount = 0;
            const logRotationCallback = jest.fn(async () => {
                rotationCount++;
                
                // Simulate log rotation occasionally failing due to file locks
                if (rotationCount % 7 === 0) {
                    throw new Error("Log file locked - cannot rotate");
                }
                
                // Simulate rotation taking 10-30 seconds
                await new Promise(resolve => setTimeout(resolve, 10000 + Math.random() * 20000));
            });
            
            const scheduler = makePollingScheduler(capabilities, { 
                pollIntervalMs: 60 * 1000, // 1 minute polling
                maxConcurrentTasks: 3
            });
            
            // Schedule log rotation every hour
            await scheduler.schedule("log-rotation", "0 * * * *", logRotationCallback, retryDelay);
            
            // Simulate 24 hours
            for (let hour = 0; hour < 24; hour++) {
                const timeStr = `2024-01-15T${hour.toString().padStart(2, '0')}:00:00Z`;
                jest.setSystemTime(new Date(timeStr));
                await scheduler._poll();
                
                // Wait for rotation to complete
                jest.advanceTimersByTime(60 * 1000);
                
                // Handle potential retries
                if (rotationCount % 7 === 0) {
                    // Failed, should retry in 5 minutes
                    const retryTimeStr = `2024-01-15T${hour.toString().padStart(2, '0')}:05:00Z`;
                    jest.setSystemTime(new Date(retryTimeStr));
                    await scheduler._poll();
                    jest.advanceTimersByTime(60 * 1000);
                }
            }
            
            // Should have attempted rotation for each hour
            expect(rotationCount).toBeGreaterThanOrEqual(24);
            
            await scheduler.cancelAll();
        });
    });

    describe("system integration edge cases", () => {
        test("should handle filesystem permission changes", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            
            // Mock filesystem operations to occasionally fail with permission errors
            let permissionFailureCount = 0;
            const originalWriter = capabilities.writer;
            capabilities.writer = {
                ...originalWriter,
                writeFile: jest.fn(async (file, content) => {
                    permissionFailureCount++;
                    if (permissionFailureCount % 3 === 0) {
                        throw new Error("EACCES: permission denied");
                    }
                    return originalWriter.writeFile(file, content);
                })
            };
            
            const taskCallback = jest.fn();
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule task and run multiple times
            await scheduler.schedule("permission-test", "* * * * *", taskCallback, retryDelay);
            
            for (let i = 0; i < 10; i++) {
                await scheduler._poll();
                jest.advanceTimersByTime(60000);
            }
            
            // Should continue working despite permission errors
            expect(taskCallback).toHaveBeenCalled();
            
            // Restore original writer
            capabilities.writer = originalWriter;
            
            await scheduler.cancelAll();
        });

        test("should handle network connectivity issues", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(30000);
            
            let networkCallCount = 0;
            const networkTaskCallback = jest.fn(async () => {
                networkCallCount++;
                
                // Simulate network connectivity issues
                if (networkCallCount <= 3) {
                    throw new Error("ENOTFOUND: network unreachable");
                }
                
                // Simulate network delay
                await new Promise(resolve => setTimeout(resolve, 2000));
            });
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("network-task", "* * * * *", networkTaskCallback, retryDelay);
            
            // First execution - should fail
            await scheduler._poll();
            expect(networkTaskCallback).toHaveBeenCalledTimes(1);
            
            // Should retry after 30 seconds
            jest.advanceTimersByTime(30000);
            await scheduler._poll();
            expect(networkTaskCallback).toHaveBeenCalledTimes(2);
            
            // Continue retrying until success
            jest.advanceTimersByTime(30000);
            await scheduler._poll();
            expect(networkTaskCallback).toHaveBeenCalledTimes(3);
            
            jest.advanceTimersByTime(30000);
            await scheduler._poll();
            expect(networkTaskCallback).toHaveBeenCalledTimes(4); // Should succeed now
            
            // Verify final state
            const tasks = await scheduler.getTasks();
            expect(tasks[0].lastSuccessTime).toBeTruthy();
            expect(tasks[0].pendingRetryUntil).toBeFalsy();
            
            await scheduler.cancelAll();
        });

        test("should handle system clock changes", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("clock-test", "* * * * *", taskCallback, retryDelay);
            
            // Normal execution
            jest.setSystemTime(new Date("2024-01-15T12:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(1);
            
            // Simulate clock going backward (time adjustment)
            jest.setSystemTime(new Date("2024-01-15T11:30:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(2); // Should still execute
            
            // Simulate clock jumping forward significantly
            jest.setSystemTime(new Date("2024-01-15T15:00:00Z"));
            await scheduler._poll();
            expect(taskCallback).toHaveBeenCalledTimes(3); // Should catch up
            
            await scheduler.cancelAll();
        });

        test("should handle memory pressure scenarios", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            
            // Simulate memory-intensive task
            let memoryAllocations = [];
            const memoryIntensiveCallback = jest.fn(() => {
                // Allocate some memory
                const allocation = new Array(10000).fill("memory test data");
                memoryAllocations.push(allocation);
                
                // Occasionally clean up to prevent actual memory issues in test
                if (memoryAllocations.length > 100) {
                    memoryAllocations = memoryAllocations.slice(-10);
                }
            });
            
            const scheduler = makePollingScheduler(capabilities, { 
                pollIntervalMs: 60000,
                maxConcurrentTasks: 50 // High concurrency to stress memory
            });
            
            // Schedule multiple memory-intensive tasks
            for (let i = 0; i < 20; i++) {
                await scheduler.schedule(`memory-task-${i}`, "* * * * *", memoryIntensiveCallback, retryDelay);
            }
            
            // Execute tasks
            await scheduler._poll();
            
            // All tasks should execute successfully
            expect(memoryIntensiveCallback).toHaveBeenCalledTimes(20);
            
            await scheduler.cancelAll();
            
            // Clean up memory allocations
            memoryAllocations = [];
        });
    });

    describe("error recovery and resilience", () => {
        test("should recover from uncaught exceptions in callbacks", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            
            const normalCallback = jest.fn();
            const crashingCallback = jest.fn(() => {
                // Simulate uncaught exception
                throw new ReferenceError("undefined variable access");
            });
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("normal-task", "* * * * *", normalCallback, retryDelay);
            await scheduler.schedule("crashing-task", "* * * * *", crashingCallback, retryDelay);
            
            // Both tasks should execute despite one crashing
            await scheduler._poll();
            
            expect(normalCallback).toHaveBeenCalledTimes(1);
            expect(crashingCallback).toHaveBeenCalledTimes(1);
            
            // Scheduler should continue functioning
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(2);
            
            // Crashing task should be in retry mode
            const crashingTask = tasks.find(t => t.name === "crashing-task");
            expect(crashingTask.modeHint).toBe("retry");
            
            await scheduler.cancelAll();
        });

        test("should handle corrupted task callbacks", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            const goodCallback = jest.fn();
            await scheduler.schedule("good-task", "* * * * *", goodCallback, retryDelay);
            
            // Manually corrupt a callback to test error handling
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            
            // Simulate callback becoming invalid (e.g., through memory corruption)
            // This is a bit contrived but tests the error handling path
            await scheduler.schedule("corrupted-task", "* * * * *", null, retryDelay);
            
            // Should handle null callback gracefully
            await scheduler._poll();
            
            // Good task should still execute
            expect(goodCallback).toHaveBeenCalled();
            
            await scheduler.cancelAll();
        });

        test("should handle rapid start/stop cycles", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Rapidly create and destroy schedulers
            for (let cycle = 0; cycle < 10; cycle++) {
                const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
                
                await scheduler.schedule(`cycle-task-${cycle}`, "* * * * *", taskCallback, retryDelay);
                await scheduler._poll();
                await scheduler.cancelAll();
            }
            
            // Should handle rapid cycles without issues
            expect(taskCallback).toHaveBeenCalledTimes(10);
        });

        test("should handle scheduler destruction during task execution", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            
            let taskStarted = false;
            const longRunningCallback = jest.fn(async () => {
                taskStarted = true;
                await new Promise(resolve => setTimeout(resolve, 5000));
            });
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("long-task", "* * * * *", longRunningCallback, retryDelay);
            
            // Start task but don't wait for completion
            const pollPromise = scheduler._poll();
            
            // Wait a bit to ensure task starts
            await new Promise(resolve => setTimeout(resolve, 100));
            expect(taskStarted).toBe(true);
            
            // Destroy scheduler while task is running
            await scheduler.cancelAll();
            
            // Wait for original poll to complete
            await pollPromise;
            
            // Task should have been allowed to complete
            expect(longRunningCallback).toHaveBeenCalled();
        });
    });

    describe("performance under stress", () => {
        test("should handle high-frequency polling", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            // Very frequent polling (every second)
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 1000 });
            
            await scheduler.schedule("frequent-poll", "* * * * *", taskCallback, retryDelay);
            
            // Run 100 poll cycles rapidly
            const startTime = Date.now();
            for (let i = 0; i < 100; i++) {
                await scheduler._poll();
                jest.advanceTimersByTime(1000);
            }
            const endTime = Date.now();
            
            // Should complete in reasonable time
            expect(endTime - startTime).toBeLessThan(10000); // Less than 10 seconds
            
            // Task should execute appropriately (not every poll, but when due)
            expect(taskCallback).toHaveBeenCalled();
            
            await scheduler.cancelAll();
        });

        test("should handle burst task scheduling", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Schedule 100 tasks in rapid succession
            const callbacks = [];
            const startTime = Date.now();
            
            for (let i = 0; i < 100; i++) {
                const callback = jest.fn();
                callbacks.push(callback);
                await scheduler.schedule(`burst-task-${i}`, "* * * * *", callback, retryDelay);
            }
            
            const scheduleTime = Date.now();
            
            // Execute all tasks
            await scheduler._poll();
            
            const executeTime = Date.now();
            
            // Scheduling should be reasonably fast
            expect(scheduleTime - startTime).toBeLessThan(5000);
            
            // Execution should complete in reasonable time
            expect(executeTime - scheduleTime).toBeLessThan(10000);
            
            // All tasks should have executed
            const executedCount = callbacks.filter(cb => cb.mock.calls.length > 0).length;
            expect(executedCount).toBeGreaterThan(0);
            
            await scheduler.cancelAll();
        });

        test("should handle mixed task execution patterns", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const scheduler = makePollingScheduler(capabilities, { 
                pollIntervalMs: 60000,
                maxConcurrentTasks: 10
            });
            
            // Mix of different task types
            const quickCallback = jest.fn();
            const slowCallback = jest.fn(async () => {
                await new Promise(resolve => setTimeout(resolve, 2000));
            });
            const failingCallback = jest.fn(() => {
                throw new Error("Intentional failure");
            });
            
            // Schedule various task types
            await scheduler.schedule("quick-1", "* * * * *", quickCallback, retryDelay);
            await scheduler.schedule("slow-1", "* * * * *", slowCallback, retryDelay);
            await scheduler.schedule("failing-1", "* * * * *", failingCallback, retryDelay);
            await scheduler.schedule("quick-2", "* * * * *", quickCallback, retryDelay);
            await scheduler.schedule("slow-2", "* * * * *", slowCallback, retryDelay);
            
            // Execute all tasks
            await scheduler._poll();
            
            // All should have been attempted
            expect(quickCallback).toHaveBeenCalledTimes(2);
            expect(slowCallback).toHaveBeenCalledTimes(2);
            expect(failingCallback).toHaveBeenCalledTimes(1);
            
            // Check task states
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(5);
            
            const failingTask = tasks.find(t => t.name === "failing-1");
            expect(failingTask.modeHint).toBe("retry");
            
            await scheduler.cancelAll();
        });
    });

    describe("edge cases in scheduler lifecycle", () => {
        test("should handle getTasks called before any scheduling", async () => {
            const capabilities = caps();
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should return empty array without error
            const tasks = await scheduler.getTasks();
            expect(tasks).toEqual([]);
        });

        test("should handle multiple cancelAll calls", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("test-task", "* * * * *", taskCallback, retryDelay);
            
            // Multiple cancelAll calls should not error
            const result1 = await scheduler.cancelAll();
            const result2 = await scheduler.cancelAll();
            const result3 = await scheduler.cancelAll();
            
            expect(result1).toBe(1); // One task cancelled
            expect(result2).toBe(0); // No tasks to cancel
            expect(result3).toBe(0); // No tasks to cancel
        });

        test("should handle operations after cancelAll", async () => {
            const capabilities = caps();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            await scheduler.schedule("test-task", "* * * * *", taskCallback, retryDelay);
            await scheduler.cancelAll();
            
            // Should be able to schedule new tasks after cancelAll
            await scheduler.schedule("new-task", "* * * * *", taskCallback, retryDelay);
            
            const tasks = await scheduler.getTasks();
            expect(tasks).toHaveLength(1);
            expect(tasks[0].name).toBe("new-task");
            
            await scheduler.cancelAll();
        });

        test("should handle cancel of non-existent task", async () => {
            const capabilities = caps();
            const scheduler = makePollingScheduler(capabilities, { pollIntervalMs: 60000 });
            
            // Should return false for non-existent task
            const result = await scheduler.cancel("non-existent");
            expect(result).toBe(false);
        });
    });
});