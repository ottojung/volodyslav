/**
 * Tests for scheduler registration validation error handling.
 * Focuses on testing various error classes and edge cases in registration validation.
 */

const { Duration } = require("luxon");
const { validateRegistrations, isScheduleDuplicateTaskError } = require("../src/scheduler/registration_validation");
const { getMockedRootCapabilities } = require("./spies");
const { stubLogger, stubEnvironment } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    return capabilities;
}

describe("scheduler registration validation error handling", () => {

    describe("RegistrationsNotArrayError scenarios", () => {
        test("should throw RegistrationsNotArrayError for non-array input", () => {
            const capabilities = getTestCapabilities();
            
            expect(() => validateRegistrations("not-array", capabilities)).toThrow("Registrations must be an array");
            expect(() => validateRegistrations(null, capabilities)).toThrow("Registrations must be an array");
            expect(() => validateRegistrations(undefined, capabilities)).toThrow("Registrations must be an array");
            expect(() => validateRegistrations(123, capabilities)).toThrow("Registrations must be an array");
            expect(() => validateRegistrations({}, capabilities)).toThrow("Registrations must be an array");
        });

        test("should accept empty array", () => {
            const capabilities = getTestCapabilities();
            expect(() => validateRegistrations([], capabilities)).not.toThrow();
        });
    });

    describe("RegistrationShapeError scenarios", () => {
        test("should throw RegistrationShapeError for non-array registration items", () => {
            const capabilities = getTestCapabilities();
            
            const invalidRegistrations = [
                "not-an-array",
                { name: "task", cron: "0 * * * *" },
                null,
                undefined,
                123
            ];

            invalidRegistrations.forEach((invalid, _index) => {
                expect(() => validateRegistrations([invalid], capabilities))
                    .toThrow(/Registration at index 0 must be an array of length 4/);
            });
        });

        test("should throw RegistrationShapeError for wrong array length", () => {
            const capabilities = getTestCapabilities();
            
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            // Too few elements
            expect(() => validateRegistrations([["task"]], capabilities))
                .toThrow(/Registration at index 0 must be an array of length 4/);
            
            expect(() => validateRegistrations([["task", "0 * * * *"]], capabilities))
                .toThrow(/Registration at index 0 must be an array of length 4/);
            
            expect(() => validateRegistrations([["task", "0 * * * *", callback]], capabilities))
                .toThrow(/Registration at index 0 must be an array of length 4/);
            
            // Too many elements
            expect(() => validateRegistrations([["task", "0 * * * *", callback, retryDelay, "extra"]], capabilities))
                .toThrow(/Registration at index 0 must be an array of length 4/);
        });

        test("should include registration details in error", () => {
            const capabilities = getTestCapabilities();
            
            expect(() => validateRegistrations(["invalid"], capabilities))
                .toThrow(expect.objectContaining({
                    name: "RegistrationShapeError",
                    details: expect.objectContaining({
                        index: 0,
                        registration: "invalid"
                    })
                }));
        });
    });

    describe("ScheduleDuplicateTaskError scenarios", () => {
        test("should throw ScheduleDuplicateTaskError for duplicate task names", () => {
            const capabilities = getTestCapabilities();
            const callback1 = jest.fn();
            const callback2 = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            const registrations = [
                ["duplicate-task", "0 * * * *", callback1, retryDelay],
                ["duplicate-task", "0 0 * * *", callback2, retryDelay]
            ];

            expect(() => validateRegistrations(registrations, capabilities))
                .toThrow('Task with name "duplicate-task" is already scheduled');
        });

        test("should provide isScheduleDuplicateTaskError type guard", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            const registrations = [
                ["task", "0 * * * *", callback, retryDelay],
                ["task", "0 0 * * *", callback, retryDelay]
            ];

            expect(() => validateRegistrations(registrations, capabilities))
                .toThrow(expect.objectContaining({
                    taskName: "task"
                }));

            // Verify error type with separate error capture
            let capturedError;
            try {
                validateRegistrations(registrations, capabilities);
            } catch (error) {
                capturedError = error;
            }
            expect(isScheduleDuplicateTaskError(capturedError)).toBe(true);
        });

        test("should allow same name in different validation calls", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            const registrations = [["task", "0 * * * *", callback, retryDelay]];

            // First call should succeed
            expect(() => validateRegistrations(registrations, capabilities)).not.toThrow();
            
            // Second call should also succeed (different validation session)
            expect(() => validateRegistrations(registrations, capabilities)).not.toThrow();
        });
    });

    describe("CronExpressionInvalidError scenarios", () => {
        test("should throw CronExpressionInvalidError for invalid cron expressions", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            const invalidCronExpressions = [
                "invalid-cron",
                "* * *", // Too few fields
                "* * * * * *", // Too many fields
                "60 * * * *", // Out of range minute
                "* 24 * * *", // Out of range hour
                "* * 0 * *", // Out of range day
                "* * * 0 *", // Out of range month
                "* * * * 7", // Out of range weekday
                "*/0 * * * *", // Slash syntax (now invalid)
                "1-0 * * * *", // Invalid range
            ];

            invalidCronExpressions.forEach(invalidCron => {
                expect(() => validateRegistrations([["task", invalidCron, callback, retryDelay]], capabilities))
                    .toThrow(/invalid cron expression/);
            });
        });

        test("should include cron expression details in error", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            expect(() => validateRegistrations([["task", "invalid-cron", callback, retryDelay]], capabilities))
                .toThrow(expect.objectContaining({
                    name: "CronExpressionInvalidError",
                    details: expect.objectContaining({
                        value: "invalid-cron"
                    })
                }));
        });
    });

    describe("CallbackTypeError scenarios", () => {
        test("should throw CallbackTypeError for non-function callbacks", () => {
            const capabilities = getTestCapabilities();
            const retryDelay = Duration.fromMillis(5000);
            
            const invalidCallbacks = [
                null,
                undefined,
                "string",
                123,
                {},
                [],
                true
            ];

            invalidCallbacks.forEach(invalidCallback => {
                expect(() => validateRegistrations([["task", "0 * * * *", invalidCallback, retryDelay]], capabilities))
                    .toThrow(/callback must be a function/);
            });
        });

        test("should accept valid function callbacks", () => {
            const capabilities = getTestCapabilities();
            const retryDelay = Duration.fromMillis(5000);
            
            const validCallbacks = [
                jest.fn(),
                async () => {},
                function() {},
                () => {},
                function namedFunction() {}
            ];

            validCallbacks.forEach((validCallback, index) => {
                expect(() => validateRegistrations([[`task-${index}`, "0 * * * *", validCallback, retryDelay]], capabilities))
                    .not.toThrow();
            });
        });
    });

    describe("NegativeRetryDelayError scenarios", () => {
        test("should throw NegativeRetryDelayError for negative retry delays", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            
            // Create a mock Duration that returns negative milliseconds
            const negativeRetryDelay = {
                toMillis: () => -1000
            };

            expect(() => validateRegistrations([["task", "0 * * * *", callback, negativeRetryDelay]], capabilities))
                .toThrow(/retryDelay cannot be negative/);
        });

        test("should include retry delay details in error", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            
            const negativeRetryDelay = {
                toMillis: () => -5000
            };

            expect(() => validateRegistrations([["task", "0 * * * *", callback, negativeRetryDelay]], capabilities))
                .toThrow(expect.objectContaining({
                    name: "NegativeRetryDelayError",
                    details: expect.objectContaining({
                        retryMs: -5000
                    })
                }));
        });
    });

    describe("complex validation scenarios", () => {
        test("should validate multiple registrations and report first error", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            const registrations = [
                ["valid-task", "0 * * * *", callback, retryDelay],
                ["invalid-task", "invalid-cron", callback, retryDelay], // This should cause error
                ["another-task", "0 0 * * *", callback, retryDelay]
            ];

            // Should throw error for the first invalid registration
            expect(() => validateRegistrations(registrations, capabilities))
                .toThrow(/invalid cron expression/);
        });

        test("should include correct index in error messages", () => {
            const capabilities = getTestCapabilities();
            const callback = jest.fn();
            const retryDelay = Duration.fromMillis(5000);
            
            const registrations = [
                ["task1", "0 * * * *", callback, retryDelay],
                ["task2", "0 0 * * *", callback, retryDelay],
                ["task3", null, callback, retryDelay] // Error at index 2
            ];

            expect(() => validateRegistrations(registrations, capabilities))
                .toThrow(/Registration at index 2/);
        });
    });
});