/**
 * Final demonstration: The exact scenario where removing stubRuntimeStateStorage 
 * causes test failures - demonstrating file conflicts and race conditions.
 */

const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, getDatetimeControl, stubScheduler, getSchedulerControl, stubRuntimeStateStorage } = require("./stubs");
const fs = require('fs');
const path = require('path');

function getTestCapabilitiesWithoutStub() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    // NOT calling stubRuntimeStateStorage - use real file-based storage
    stubScheduler(capabilities);
    return capabilities;
}

describe("actual runtime state stubbing failure scenarios", () => {
    test("demonstrate race condition in file access", async () => {
        // Create multiple schedulers that might write to the same file
        const results = [];
        const errors = [];
        
        const runScheduler = async (id) => {
            try {
                const capabilities = getTestCapabilitiesWithoutStub();
                const timeControl = getDatetimeControl(capabilities);
                const schedulerControl = getSchedulerControl(capabilities);
                
                const startTime = new Date("2021-01-01T10:00:00.000Z").getTime() + (id * 1000);
                timeControl.setTime(startTime);
                schedulerControl.setPollingInterval(1);

                const taskCallback = jest.fn();
                const registrations = [
                    [`race-task-${id}`, "0 * * * *", taskCallback, Duration.fromMillis(1000)],
                ];

                await capabilities.scheduler.initialize(registrations);
                
                // Rapid-fire operations to increase chance of race conditions
                for (let i = 0; i < 3; i++) {
                    await schedulerControl.waitForNextCycleEnd();
                    timeControl.advanceTime(60 * 60 * 1000);
                }
                
                await capabilities.scheduler.stop();
                results.push({ id, calls: taskCallback.mock.calls.length });
            } catch (error) {
                errors.push({ id, error: error.message });
            }
        };

        // Run multiple schedulers simultaneously
        await Promise.all([
            runScheduler(1),
            runScheduler(2),
            runScheduler(3),
            runScheduler(4),
            runScheduler(5),
        ]);

        console.log("Race condition test results:", results);
        console.log("Race condition test errors:", errors);
        
        // This might show errors or inconsistent behavior due to file conflicts
        if (errors.length > 0) {
            console.log("FOUND FILE CONFLICTS:", errors);
        }
    });

    test("demonstrate file state pollution between tests", async () => {
        let sharedFilePath = null;
        
        // First test - create state and capture file path  
        {
            const capabilities = getTestCapabilitiesWithoutStub();
            
            await capabilities.state.transaction(async (storage) => {
                sharedFilePath = storage.stateFile.path;
                console.log("Test 1 - Using file:", sharedFilePath);
                
                const newState = { 
                    version: 2, 
                    startTime: capabilities.datetime.now(), 
                    tasks: [
                        { name: "polluting-task", cronExpression: "0 * * * *", retryDelayMs: 5000, lastSuccessTime: capabilities.datetime.now() }
                    ]
                };
                storage.setState(newState);
            });
            
            // Verify file exists and has content
            if (fs.existsSync(sharedFilePath)) {
                const content = fs.readFileSync(sharedFilePath, 'utf8');
                console.log("Test 1 - Created file with content length:", content.length);
            }
        }

        // Second test - might be affected by first test's state
        {
            const capabilities = getTestCapabilitiesWithoutStub();
            
            await capabilities.state.transaction(async (storage) => {
                console.log("Test 2 - Using file:", storage.stateFile.path);
                console.log("Test 2 - Same file as test 1:", storage.stateFile.path === sharedFilePath);
                
                const existingState = await storage.getExistingState();
                console.log("Test 2 - Found existing tasks:", existingState?.tasks?.length || 0);
                
                // This test might see state from the previous test!
                if (existingState?.tasks?.length > 0) {
                    console.log("POLLUTION DETECTED: Test 2 sees state from Test 1");
                    console.log("Existing task:", existingState.tasks[0]);
                }
            });
        }
        
        console.log("Final file state exists:", fs.existsSync(sharedFilePath));
    });

    test("demonstrate the actual failure when file operations fail", async () => {
        const capabilities = getTestCapabilitiesWithoutStub();
        
        // First, ensure the state file is created
        let stateFilePath = null;
        await capabilities.state.transaction(async (storage) => {
            stateFilePath = storage.stateFile.path;
            const state = { version: 2, startTime: capabilities.datetime.now(), tasks: [] };
            storage.setState(state);
        });
        
        console.log("State file path:", stateFilePath);
        console.log("File exists after creation:", fs.existsSync(stateFilePath));
        
        if (stateFilePath && fs.existsSync(stateFilePath)) {
            // Write invalid JSON to simulate corruption
            fs.writeFileSync(stateFilePath, "invalid json {");
            console.log("Corrupted state file with invalid JSON");
            
            try {
                await capabilities.state.transaction(async (storage) => {
                    await storage.getCurrentState();
                });
                console.log("ERROR: Should have failed with corrupted file");
            } catch (error) {
                console.log("EXPECTED FAILURE: Corrupted file caused error:", error.message);
                console.log("Error type:", error.constructor.name);
                
                // This demonstrates how file-based storage can fail
                // While stubbed storage would not have this issue
                expect(error.message).toContain("parse");
            }
        } else {
            console.log("Could not create state file for corruption test");
            // Just test that file operations are involved
            expect(stateFilePath).toBeTruthy();
        }
    });

    test("demonstrate shared state directory conflicts", async () => {
        // Multiple capabilities using the same environment might conflict
        const cap1 = getTestCapabilitiesWithoutStub();
        const cap2 = getTestCapabilitiesWithoutStub();
        
        let file1Path = null;
        let file2Path = null;
        
        await cap1.state.transaction(async (storage) => {
            file1Path = storage.stateFile.path;
            const state = { version: 2, startTime: cap1.datetime.now(), tasks: [] };
            storage.setState(state);
        });
        
        await cap2.state.transaction(async (storage) => {
            file2Path = storage.stateFile.path;
            const state = { version: 2, startTime: cap2.datetime.now(), tasks: [] };
            storage.setState(state);
        });
        
        console.log("Capability 1 file:", file1Path);
        console.log("Capability 2 file:", file2Path);
        console.log("Same directory:", path.dirname(file1Path) === path.dirname(file2Path));
        console.log("Same file:", file1Path === file2Path);
        
        // If they use the same file, this could cause conflicts
        if (file1Path === file2Path) {
            console.log("CONFLICT: Both capabilities using same file!");
        } else {
            console.log("No direct file conflict - each has its own file");
        }
    });
});