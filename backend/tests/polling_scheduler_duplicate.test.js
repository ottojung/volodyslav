/**
 * Tests for declarative scheduler duplicate task handling.
 */

const { ScheduleDuplicateTaskError } = require("../src/cron");
const { fromMilliseconds } = require("../src/time_duration");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    return capabilities;
}

describe("declarative scheduler duplicate task handling", () => {
    test("allows idempotent initialization with same registrations", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(0);
        const taskCallback = jest.fn();
        
        const registrations = [
            ["task-a", "0 * * * *", taskCallback, retryDelay] // Every hour - compatible with any polling interval
        ];
        
        // First initialization should succeed
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60000 })) // 1 minute polling
            .resolves.toBeUndefined();
            
        // Second initialization with same registrations should be idempotent
        await expect(capabilities.scheduler.initialize(registrations, { pollIntervalMs: 60000 }))
            .resolves.toBeUndefined();
            
        await capabilities.scheduler.stop();
    });

    test("detects duplicate tasks within same registration set", async () => {
        const capabilities = getTestCapabilities();
        const retryDelay = fromMilliseconds(0);
        const taskCallback = jest.fn();
        
        // Try to register the same task twice in one initialization
        const registrationsWithDuplicate = [
            ["task-a", "0 * * * *", taskCallback, retryDelay],
            ["task-a", "0 * * * *", taskCallback, retryDelay]  // Duplicate name
        ];
        
        // This should fail because there are duplicate task names in the registrations
        await expect(capabilities.scheduler.initialize(registrationsWithDuplicate, { pollIntervalMs: 60000 }))
            .rejects.toThrow(ScheduleDuplicateTaskError);
    });
});

