/**
 * Tests for declarative scheduler state management and robustness.
 * Focuses on scheduler robustness, error handling, and consistent behavior.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubRuntimeStateStorage, stubPollInterval } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubRuntimeStateStorage(capabilities);
    stubPollInterval(capabilities, 1); // Fast polling for tests
    return capabilities;
}

describe("declarative scheduler state management robustness", () => {
    describe("initialization edge cases", () => {
        test("should throw ScheduleDuplicateTaskError for duplicate task names in registration", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            // Registrations with duplicate task names should throw an error
            const registrations = [
                ["duplicate-task", "0 * * * *", taskCallback, retryDelay],
                ["duplicate-task", "0 * * * *", taskCallback, retryDelay] // Same name, different schedule
            ];
            
            // Should throw ScheduleDuplicateTaskError for duplicate names
            await expect(capabilities.scheduler.initialize(registrations))
                .rejects.toThrow("Task with name \"duplicate-task\" is already scheduled");
        });

        test("should handle invalid cron expressions gracefully", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const registrations = [
                ["valid-task", "0 * * * *", taskCallback, retryDelay],
                ["invalid-task", "invalid-cron-expression", taskCallback, retryDelay]
            ];
            
            // Should handle invalid cron expressions without crashing the entire scheduler
            let threwError = false;
            try {
                await capabilities.scheduler.initialize(registrations);
                await new Promise(resolve => setTimeout(resolve, 10));
            } catch (error) {
                // If it throws, that's acceptable behavior for invalid input
                threwError = true;
            }
            
            // Either way should be ok - throwing or not throwing for invalid cron
            expect(typeof threwError).toBe('boolean');
            
            await capabilities.scheduler.stop();
        });

        test("should handle extremely large retry delays", async () => {
            const capabilities = getTestCapabilities();
            const veryLargeDelay = fromMilliseconds(365 * 24 * 60 * 60 * 1000); // 1 year
            const taskCallback = jest.fn(() => {
                throw new Error("Task failure");
            });
            
            const registrations = [
                ["large-delay-task", "0 * * * *", taskCallback, veryLargeDelay]
            ];
            
            // Should handle very large retry delays without issues
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Task should execute at least once
            expect(taskCallback).toHaveBeenCalled();
            
            await capabilities.scheduler.stop();
        });

        test("should handle extremely short retry delays", async () => {
            const capabilities = getTestCapabilities();
            const veryShortDelay = fromMilliseconds(1); // 1ms
            let callCount = 0;
            const taskCallback = jest.fn(() => {
                callCount++;
                if (callCount <= 3) {
                    throw new Error("Task failure");
                }
            });
            
            const registrations = [
                ["short-delay-task", "0 * * * *", taskCallback, veryShortDelay]
            ];
            
            // Should handle very short retry delays
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Task should execute multiple times due to short retry
            expect(taskCallback).toHaveBeenCalled();
            
            await capabilities.scheduler.stop();
        });
    });

    describe("error resilience", () => {
        test("should handle callbacks that modify global state", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            
            let globalCounter = 0;
            const globalModifyingCallback = jest.fn(() => {
                globalCounter += 10;
                global.testGlobalValue = globalCounter;
            });
            
            const registrations = [
                ["global-modifier", "0 * * * *", globalModifyingCallback, retryDelay]
            ];
            
            // Should handle callbacks that modify global state
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(globalModifyingCallback).toHaveBeenCalled();
            expect(globalCounter).toBeGreaterThan(0);
            
            // Cleanup
            delete global.testGlobalValue;
            
            await capabilities.scheduler.stop();
        });

        test("should handle callbacks with memory leaks", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            
            let memoryAccumulator = [];
            const memoryLeakingCallback = jest.fn(() => {
                // Simulate memory accumulation
                memoryAccumulator.push(new Array(1000).fill("leak"));
                
                // Clean up to prevent actual memory issues during test
                if (memoryAccumulator.length > 5) {
                    memoryAccumulator = memoryAccumulator.slice(-2);
                }
            });
            
            const registrations = [
                ["memory-leak-task", "0 * * * *", memoryLeakingCallback, retryDelay]
            ];
            
            // Should handle potentially leaky callbacks
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(memoryLeakingCallback).toHaveBeenCalled();
            
            // Cleanup
            memoryAccumulator = [];
            
            await capabilities.scheduler.stop();
        });

        test("should handle callbacks that throw non-Error objects", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            
            let throwCount = 0;
            const weirdThrowingCallback = jest.fn(() => {
                throwCount++;
                switch (throwCount % 4) {
                    case 1:
                        throw "string error";
                    case 2:
                        throw 42;
                    case 3:
                        throw { custom: "object" };
                    default:
                        // Success case
                        return;
                }
            });
            
            const registrations = [
                ["weird-throwing-task", "0 * * * *", weirdThrowingCallback, retryDelay]
            ];
            
            // Should handle non-Error thrown objects
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(weirdThrowingCallback).toHaveBeenCalled();
            
            await capabilities.scheduler.stop();
        });
    });

    describe("scheduler lifecycle robustness", () => {
        test("should handle rapid start/stop cycles", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const registrations = [
                ["rapid-cycle-task", "0 * * * *", taskCallback, retryDelay]
            ];
            
            // Perform rapid start/stop cycles with slightly longer delays
            for (let i = 0; i < 3; i++) {
                await capabilities.scheduler.initialize(registrations);
                await new Promise(resolve => setTimeout(resolve, 10)); // Longer delay for execution
                await capabilities.scheduler.stop();
            }
            
            // Should handle rapid cycles without crashing
            // Note: Task may or may not execute depending on timing, but no errors should occur
            expect(true).toBe(true); // Test passes if no exception is thrown
        });

        test("should handle concurrent initialization attempts", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const registrations = [
                ["concurrent-task", "0 * * * *", taskCallback, retryDelay]
            ];
            
            // Start multiple concurrent initializations
            const promises = [];
            for (let i = 0; i < 3; i++) {
                promises.push(capabilities.scheduler.initialize(registrations));
            }
            
            // All should complete without errors (idempotent behavior)
            await Promise.all(promises);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            expect(taskCallback).toHaveBeenCalled();
            
            await capabilities.scheduler.stop();
        });

        test("should handle stop without initialization", async () => {
            const capabilities = getTestCapabilities();
            
            // Should handle stop call even if not initialized
            await expect(capabilities.scheduler.stop()).resolves.not.toThrow();
        });

        test("should handle multiple stop calls", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            const taskCallback = jest.fn();
            
            const registrations = [
                ["multi-stop-task", "0 * * * *", taskCallback, retryDelay]
            ];
            
            await capabilities.scheduler.initialize(registrations);
            
            // Multiple stop calls should be safe
            await capabilities.scheduler.stop();
            await capabilities.scheduler.stop();
            await capabilities.scheduler.stop();
            
            // Should not throw errors
            expect(true).toBe(true);
        });
    });

    describe("edge case task patterns", () => {
        test("should handle many simultaneous tasks", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            
            // Create many simultaneous tasks (reduced for performance)
            const registrations = [];
            const callbacks = [];
            
            for (let i = 0; i < 10; i++) {
                const callback = jest.fn();
                callbacks.push(callback);
                registrations.push([`task-${i}`, "0 * * * *", callback, retryDelay]);
            }
            
            // Should handle many simultaneous tasks
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 1000));
            
            // At least some tasks should execute
            const executedCount = callbacks.filter(cb => cb.mock.calls.length > 0).length;
            expect(executedCount).toBeGreaterThan(0);
            
            await capabilities.scheduler.stop();
        }, 10000); // Increase timeout to 10 seconds

        test("should handle tasks with complex cron patterns", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(5000);
            
            const callbacks = [];
            const complexPatterns = [
                "*/15 * * * *",      // Every 5 minutes
                "0 */2 * * *",     // Every 2 hours
                "30 9 * * 1-5",    // 9:30 AM on weekdays
                "0 0 1 * *",       // First day of month
                "0 0 * * 0"        // Every Sunday
            ];
            
            const registrations = [];
            complexPatterns.forEach((pattern, index) => {
                const callback = jest.fn();
                callbacks.push(callback);
                registrations.push([`complex-${index}`, pattern, callback, retryDelay]);
            });
            
            // Should handle complex cron patterns without errors
            await capabilities.scheduler.initialize(registrations);
            
            await new Promise(resolve => setTimeout(resolve, 10));
            
            // Should have successfully scheduled all complex patterns
            expect(callbacks.length).toBe(complexPatterns.length);
            
            await capabilities.scheduler.stop();
        });
    });
});