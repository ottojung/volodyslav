/**
 * Investigation test: Running scheduler stories with REAL capabilities
 * to understand what failures occur when no mocking is used at all.
 */

const { Duration } = require("luxon");
const rootCapabilities = require("../src/capabilities/root");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl } = require("./stubs");

function getTestCapabilitiesWithRealState() {
    // Start with completely real capabilities
    const realCapabilities = rootCapabilities.make();
    
    // Only stub the things we need for testing (datetime, environment, etc.)
    // but keep the real state storage
    stubEnvironment(realCapabilities);
    stubLogger(realCapabilities);
    // NOTE: Can't stubDatetime with real capabilities - it expects mocked functions!
    // stubDatetime(realCapabilities);
    stubSleeper(realCapabilities);
    stubScheduler(realCapabilities);
    // NOTE: NOT stubbing runtime state storage - using the real one
    
    return realCapabilities;
}

describe("scheduler stories with real state capabilities", () => {
    test("demonstrate dependency on mocked functions", async () => {
        const capabilities = getTestCapabilitiesWithRealState();
        
        console.log("State object type:", typeof capabilities.state);
        console.log("State.transaction type:", typeof capabilities.state.transaction);
        console.log("State.ensureAccessible type:", typeof capabilities.state.ensureAccessible);
        console.log("Is state.transaction a mock?", jest.isMockFunction && jest.isMockFunction(capabilities.state.transaction));
        console.log("Is state.ensureAccessible a mock?", jest.isMockFunction && jest.isMockFunction(capabilities.state.ensureAccessible));
        
        console.log("Datetime.now type:", typeof capabilities.datetime.now);
        console.log("Is datetime.now a mock?", jest.isMockFunction && jest.isMockFunction(capabilities.datetime.now));
        
        // Try to call stubDatetime on real capabilities - this should demonstrate the issue
        try {
            console.log("Attempting to stub datetime on real capabilities...");
            // Import the function here to make the test clearer
            const { stubDatetime } = require("./stubs");
            stubDatetime(capabilities);
            console.log("stubDatetime succeeded - this shouldn't happen with real capabilities!");
        } catch (error) {
            console.log("stubDatetime failed as expected:", error.message);
            // This is the expected behavior - stubDatetime expects mocked functions
        }
        
        // Test real state storage
        try {
            console.log("About to call ensureAccessible...");
            await capabilities.state.ensureAccessible();
            console.log("ensureAccessible succeeded");
        } catch (error) {
            console.log("ensureAccessible failed:", error.message, error.constructor.name);
            throw error;
        }
        
        try {
            console.log("About to start transaction...");
            await capabilities.state.transaction(async (storage) => {
                console.log("In transaction - storage type:", typeof storage);
                console.log("Storage constructor:", storage.constructor.name);
                console.log("Storage properties:", Object.getOwnPropertyNames(storage));
                
                const currentState = await storage.getCurrentState();
                console.log("Current state retrieved:", currentState);
            });
            console.log("Transaction completed successfully");
        } catch (error) {
            console.log("Transaction failed:", error.message, error.constructor.name);
            console.log("Error stack:", error.stack);
            throw error;
        }
    });

    test("investigate what scheduler needs to work", async () => {
        const capabilities = getTestCapabilitiesWithRealState();
        
        try {
            console.log("Testing scheduler without time control...");
            
            const retryDelay = Duration.fromMillis(5000);
            const taskCallback = jest.fn();

            const registrations = [
                ["test-task", "* * * * *", taskCallback, retryDelay] // Every minute
            ];

            console.log("About to initialize scheduler...");
            await capabilities.scheduler.initialize(registrations);
            console.log("Scheduler initialized successfully");

            // Since we can't control time, just wait a bit and see what happens
            await new Promise(resolve => setTimeout(resolve, 100));

            console.log("Task calls after 100ms:", taskCallback.mock.calls.length);

            await capabilities.scheduler.stop();
            console.log("Scheduler stopped successfully");
        } catch (error) {
            console.log("Scheduler test failed:", error.message, error.constructor.name);
            console.log("Error stack:", error.stack);
            throw error;
        }
    });
});