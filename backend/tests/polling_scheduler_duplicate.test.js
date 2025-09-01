/**
 * Tests for declarative scheduler duplicate task handling.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    return capabilities;
}

describe("declarative scheduler duplicate task handling", () => {
    test("allows idempotent initialization with same registrations", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = Duration.fromMillis(0);
        const taskCallback = jest.fn();
        
        const registrations = [
            ["task-a", "0 * * * *", taskCallback, retryDelay] // Every hour - compatible with any polling interval
        ];
        
        // First initialization should succeed
        await expect(capabilities.scheduler.initialize(registrations)) // 1 minute polling
            .resolves.toBeUndefined();
            
        // Second initialization with same registrations should be idempotent
        await expect(capabilities.scheduler.initialize(registrations))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("throws ScheduleDuplicateTaskError for duplicate task names within registration set", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = Duration.fromMillis(0);
        const taskCallback = jest.fn();
        
        // The declarative scheduler now strictly prohibits duplicate names
        // within the same registration array
        const registrationsWithDuplicate = [
            ["task-a", "0 * * * *", taskCallback, retryDelay],
            ["task-a", "0 * * * *", taskCallback, retryDelay]  // Duplicate name - should throw error
        ];
        
        // This should throw ScheduleDuplicateTaskError for duplicate names
        await expect(capabilities.scheduler.initialize(registrationsWithDuplicate))
            .rejects.toThrow("Task with name \"task-a\" is already scheduled");
        await capabilities.scheduler.stop();
    });
});

