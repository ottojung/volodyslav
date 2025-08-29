/**
 * Tests for duplicate task name validation in scheduler.
 * Tests the ScheduleDuplicateTaskError behavior comprehensively.
 */

const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler } = require("./stubs");
const { isScheduleDuplicateTaskError } = require("../src/scheduler");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("schedule validation duplicate task names", () => {
    describe("ScheduleDuplicateTaskError behavior", () => {
        test("throws ScheduleDuplicateTaskError for duplicate task names", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            const registrationsWithDuplicate = [
                ["task-name", "0 * * * *", taskCallback, retryDelay],
                ["task-name", "30 * * * *", taskCallback, retryDelay]  // Same name, different schedule
            ];
            
            await expect(async () => {
                await capabilities.scheduler.initialize(registrationsWithDuplicate);
            }).rejects.toThrow();
        });

        test("error message contains the duplicate task name", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            const registrationsWithDuplicate = [
                ["specific-task-name", "0 * * * *", taskCallback, retryDelay],
                ["specific-task-name", "30 * * * *", taskCallback, retryDelay]
            ];
            
            await expect(capabilities.scheduler.initialize(registrationsWithDuplicate))
                .rejects.toThrow('Task with name "specific-task-name" is already scheduled');
        });

        test("error has correct taskName property", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            const registrationsWithDuplicate = [
                ["my-task", "0 * * * *", taskCallback, retryDelay],
                ["my-task", "30 * * * *", taskCallback, retryDelay]
            ];
            
            await expect(async () => {
                await capabilities.scheduler.initialize(registrationsWithDuplicate);
            }).rejects.toThrow();
            
            // Verify error properties by catching it
            let caughtError = null;
            try {
                await capabilities.scheduler.initialize(registrationsWithDuplicate);
            } catch (error) {
                caughtError = error;
            }
            
            expect(caughtError).not.toBeNull();
            expect(isScheduleDuplicateTaskError(caughtError)).toBe(true);
            expect(caughtError.taskName).toBe("my-task");
        });

        test("first duplicate is detected (second occurrence throws error)", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            // Place duplicate at different positions to ensure it's the second occurrence that triggers the error
            const registrationsWithDuplicate = [
                ["unique-task-1", "0 * * * *", taskCallback, retryDelay],
                ["duplicate-task", "15 * * * *", taskCallback, retryDelay],   // First occurrence
                ["unique-task-2", "30 * * * *", taskCallback, retryDelay],
                ["duplicate-task", "45 * * * *", taskCallback, retryDelay]    // Second occurrence - should trigger error
            ];
            
            await expect(capabilities.scheduler.initialize(registrationsWithDuplicate))
                .rejects.toThrow('Task with name "duplicate-task" is already scheduled');
        });
    });

    describe("edge cases", () => {
        test("multiple different duplicates throw error for first duplicate found", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            const registrationsWithMultipleDuplicates = [
                ["task-a", "0 * * * *", taskCallback, retryDelay],
                ["task-b", "15 * * * *", taskCallback, retryDelay],
                ["task-a", "30 * * * *", taskCallback, retryDelay],  // First duplicate found
                ["task-b", "45 * * * *", taskCallback, retryDelay]   // Would be second duplicate, but error thrown before this
            ];
            
            // Should throw for task-a since it's the first duplicate encountered
            await expect(capabilities.scheduler.initialize(registrationsWithMultipleDuplicates))
                .rejects.toThrow('Task with name "task-a" is already scheduled');
        });

        test("case-sensitive duplicate detection", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            // Different case should be treated as different tasks
            const registrationsWithDifferentCase = [
                ["Task-Name", "0 * * * *", taskCallback, retryDelay],
                ["task-name", "30 * * * *", taskCallback, retryDelay],  // Different case
                ["TASK-NAME", "45 * * * *", taskCallback, retryDelay]   // Different case
            ];
            
            // Should succeed since task names are case-sensitive
            await expect(capabilities.scheduler.initialize(registrationsWithDifferentCase))
                .resolves.toBeUndefined();
                
            await capabilities.scheduler.stop();
        });

        test("whitespace differences treated as different task names", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            const registrationsWithWhitespace = [
                ["task-name", "0 * * * *", taskCallback, retryDelay],
                [" task-name", "30 * * * *", taskCallback, retryDelay],   // Leading space
                ["task-name ", "45 * * * *", taskCallback, retryDelay]    // Trailing space
            ];
            
            // Should succeed since whitespace makes them different names
            await expect(capabilities.scheduler.initialize(registrationsWithWhitespace))
                .resolves.toBeUndefined();
                
            await capabilities.scheduler.stop();
        });

        test("exact duplicate detection - same name exactly", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            const registrationsWithExactDuplicate = [
                ["exact-duplicate", "0 * * * *", taskCallback, retryDelay],
                ["exact-duplicate", "0 * * * *", taskCallback, retryDelay]  // Exactly the same
            ];
            
            await expect(capabilities.scheduler.initialize(registrationsWithExactDuplicate))
                .rejects.toThrow('Task with name "exact-duplicate" is already scheduled');
        });
    });

    describe("interaction with other validation", () => {
        test("duplicate validation occurs after name validation", async () => {
            const capabilities = getTestCapabilities();
            const retryDelay = fromMilliseconds(1000);
            const taskCallback = jest.fn();
            
            // First registration has invalid empty name, should fail before duplicate check
            const registrationsWithInvalidName = [
                ["", "0 * * * *", taskCallback, retryDelay],  // Invalid empty name
                ["", "30 * * * *", taskCallback, retryDelay]  // Would be duplicate if name validation passed
            ];
            
            // Should throw ScheduleInvalidNameError, not ScheduleDuplicateTaskError
            await expect(capabilities.scheduler.initialize(registrationsWithInvalidName))
                .rejects.toThrow("Task name must be a non-empty string");
        });

        test("duplicate validation occurs after structure validation", async () => {
            const capabilities = getTestCapabilities();
            
            // Invalid registration structure should fail before duplicate check
            const registrationsWithInvalidStructure = [
                ["valid-task", "0 * * * *"],  // Missing callback and retryDelay
                ["duplicate-task", "30 * * * *", jest.fn(), fromMilliseconds(1000)],
                ["duplicate-task", "45 * * * *", jest.fn(), fromMilliseconds(1000)]  // Would be duplicate
            ];
            
            // Should throw RegistrationShapeError, not ScheduleDuplicateTaskError
            await expect(capabilities.scheduler.initialize(registrationsWithInvalidStructure))
                .rejects.toThrow("Registration at index 0 must be an array of length 4");
        });
    });

    describe("type guard function", () => {
        test("isScheduleDuplicateTaskError correctly identifies the error", async () => {
            const capabilities = getTestCapabilities();
            
            // Create a duplicate error by triggering the actual error
            let duplicateError = null;
            try {
                await capabilities.scheduler.initialize([
                    ["duplicate", "0 * * * *", async () => {}, fromMilliseconds(1000)],
                    ["duplicate", "0 * * * *", async () => {}, fromMilliseconds(1000)]
                ]);
            } catch (error) {
                duplicateError = error;
            }
            
            const otherError = new Error("Other error");
            
            expect(duplicateError).not.toBeNull();
            expect(isScheduleDuplicateTaskError(duplicateError)).toBe(true);
            expect(isScheduleDuplicateTaskError(otherError)).toBe(false);
            expect(isScheduleDuplicateTaskError(null)).toBe(false);
            expect(isScheduleDuplicateTaskError(undefined)).toBe(false);
            expect(isScheduleDuplicateTaskError({})).toBe(false);
        });
    });
});