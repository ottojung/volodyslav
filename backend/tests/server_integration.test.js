/**
 * Integration test to verify server can start with declarative scheduler.
 */

const { initialize } = require("../src/server");
const { getMockedRootCapabilities } = require("./spies");
const {
    stubLogger,
    stubEnvironment,
    stubAiTranscriber,
    stubNotifier,
    stubSleeper,
    stubDatetime,
    stubApp,
    stubEventLogRepository,
} = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    stubAiTranscriber(capabilities);
    stubNotifier(capabilities);
    stubSleeper(capabilities);
    stubDatetime(capabilities);
    
    // Mock the necessary methods that server initialization needs
    capabilities.environment.ensureEnvironmentIsInitialized = jest.fn().mockResolvedValue(undefined);
    capabilities.notifier.ensureNotificationsAvailable = jest.fn().mockResolvedValue(undefined);
    capabilities.git.ensureAvailable = jest.fn().mockResolvedValue(undefined);
    
    return capabilities;
}

describe("Server Integration with Declarative Scheduler", () => {

    test("server can initialize with declarative scheduler on first run", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities); // Required for server initialization
        const app = stubApp();

        // First-time server initialization should succeed (creates initial scheduler state)
        await expect(initialize(capabilities, app)).resolves.toBeUndefined();
        
        // Should have logged various initialization steps
        expect(capabilities.logger.logInfo).toHaveBeenCalled();
        
        // App should have been configured with middleware
        expect(app.use).toHaveBeenCalled();
    });

    test("server initialization is idempotent", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities); // Required for server initialization
        const app = stubApp();

        // First initialization
        await expect(initialize(capabilities, app)).resolves.toBeUndefined();
        
        // Second initialization should also succeed (idempotent)
        await expect(initialize(capabilities, app)).resolves.toBeUndefined();
        
        // Should have configured app at least once
        expect(app.use).toHaveBeenCalled();
    });

    test("server handles scheduler initialization errors gracefully", async () => {
        const capabilities = getTestCapabilities();
        const app = stubApp();
        
        // Simulate a scheduler error by making environment setup fail
        capabilities.environment.ensureEnvironmentIsInitialized.mockRejectedValue(
            new Error("Environment setup failed")
        );

        // Server initialization should fail gracefully
        await expect(initialize(capabilities, app)).rejects.toThrow("Environment setup failed");
    });

    test("server properly sets up all middleware even with scheduler", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities); // Required for server initialization
        const app = stubApp();

        await initialize(capabilities, app);

        // Verify that essential setup steps were attempted
        expect(capabilities.environment.ensureEnvironmentIsInitialized).toHaveBeenCalled();
        expect(capabilities.notifier.ensureNotificationsAvailable).toHaveBeenCalled();
        expect(capabilities.git.ensureAvailable).toHaveBeenCalled();
        
        // App configuration should have been set up
        expect(app.use).toHaveBeenCalled();
    });

    test("server logs appropriate messages during initialization", async () => {
        const capabilities = getTestCapabilities();
        await stubEventLogRepository(capabilities); // Required for server initialization
        const app = stubApp();

        await initialize(capabilities, app);

        // Should have logged initialization progress
        expect(capabilities.logger.logInfo).toHaveBeenCalled();
        
        // Check that logger was properly configured  
        const logInfoCalls = capabilities.logger.logInfo.mock.calls;
        expect(logInfoCalls.length).toBeGreaterThan(0);
    });

    test("server handles concurrent initialization attempts", async () => {
        const capabilities1 = getTestCapabilities();
        await stubEventLogRepository(capabilities1); // Required for server initialization
        const capabilities2 = getTestCapabilities();
        await stubEventLogRepository(capabilities2); // Required for server initialization
        const app1 = stubApp();
        const app2 = stubApp();

        // Start two initializations concurrently with separate capabilities
        const promise1 = initialize(capabilities1, app1);
        const promise2 = initialize(capabilities2, app2);

        // Both should succeed (separate working directories)
        await expect(Promise.all([promise1, promise2])).resolves.toEqual([undefined, undefined]);
        
        // Both apps should be configured
        expect(app1.use).toHaveBeenCalled();
        expect(app2.use).toHaveBeenCalled();
    });
});