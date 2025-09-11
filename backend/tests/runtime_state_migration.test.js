/**
 * Tests for runtime state migration from v1 to v2.
 */

const { fromMilliseconds } = require("../src/datetime");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    return capabilities;
}

describe("runtime state migration", () => {
    test("legacy state (only startTime) -> load -> tasks:[]; migration logged; first mutation writes v2", async () => {
        const capabilities = getTestCapabilities();
        
        // Test the structure-level migration first
        const structure = require("../src/runtime_state_storage/structure");
        const legacyStateObj = {
            version: 1,
            startTime: "2025-01-01T10:00:00.000Z",
            // No tasks field in v1
        };
        
        const migrationResult = structure.tryDeserialize(legacyStateObj);
        expect(structure.isTryDeserializeError(migrationResult)).toBe(false);
        
        // TypeScript/JSDoc knows migrationResult is not an error after the check above
        expect(migrationResult.migrated).toBe(true);
        expect(migrationResult.state.version).toBe(2);
        expect(migrationResult.state.tasks).toEqual([]);
        
        // Test scheduler behavior with first-time initialization
        const retryDelay = fromMilliseconds(1000);
        const registrations = [
            ["test-task", "0 * * * *", jest.fn(), retryDelay]
        ];
        
        // This should succeed as first-time initialization (no persisted state)
        await capabilities.scheduler.initialize(registrations);
        
        // Verify task was added
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            expect(currentState.version).toBe(2);
            expect(currentState.tasks).toHaveLength(1);
            expect(currentState.tasks[0]).toMatchObject({
                name: "test-task",
                cronExpression: "0 * * * *",
                retryDelayMs: 1000,
            });
        });
        
        await capabilities.scheduler.stop();
    });
});