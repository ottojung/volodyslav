const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubEventLogRepository } = require("./stubs");
const { transaction } = require("../src/event_log_storage");
const { getConfig } = require("../src/config_api");

describe("Config Debug Test", () => {
    test("debug config storage and retrieval", async () => {
        console.log('=== DEBUG CONFIG TEST ===');
        
        // Set up capabilities
        const capabilities = getMockedRootCapabilities();
        stubEnvironment(capabilities);
        stubLogger(capabilities);
        stubDatetime(capabilities);
        await stubEventLogRepository(capabilities);
        
        console.log('1. Capabilities set up');
        
        // Check repository status before setting config
        const gitDir = capabilities.environment.eventLogRepository();
        console.log('2. Repository path:', gitDir);
        
        // Set config
        console.log('3. Setting config via transaction...');
        await transaction(capabilities, async (storage) => {
            console.log('3a. Inside transaction, calling setConfig...');
            storage.setConfig({
                help: "test config",
                shortcuts: [
                    ["\\bw\\b", "WORK"]
                ]
            });
            console.log('3b. setConfig called');
        });
        console.log('3c. Transaction completed');
        
        // Check if config was committed by looking at git log
        const { execFile } = require("child_process");
        const { promisify } = require("node:util");
        const callSubprocess = promisify(execFile);
        
        try {
            // First check if we have any refs
            const refsResult = await callSubprocess("git", ["show-ref"], {
                cwd: gitDir,
            });
            console.log('4a. Git refs:', refsResult.stdout);
        } catch (error) {
            console.log('4a. Error getting git refs:', error.message);
        }
        
        try {
            const result = await callSubprocess("git", ["log", "--oneline", "-3"], {
                cwd: gitDir,
            });
            console.log('4b. Recent commits:', result.stdout);
        } catch (error) {
            console.log('4b. Error getting git log:', error.message);
        }
        
        // Try to read config
        console.log('5. Reading config via getConfig...');
        // Add debugging inside the transaction to see which branch we're on
        await transaction(capabilities, async (storage) => {
            const workTree = await storage.capabilities.creator.createTemporaryDirectory(storage.capabilities);
            try {
                const branchResult = await callSubprocess("git", ["branch", "--show-current"], {
                    cwd: workTree,
                });
                console.log('5a. Current branch in transaction:', branchResult.stdout.trim());
            } catch (error) {
                console.log('5a. Error getting current branch:', error.message);
            }
            return null;
        });
        
        const config = await getConfig(capabilities);
        console.log('6. getConfig returned:', config);
        
        console.log('=== END DEBUG TEST ===');
        
        expect(config).not.toBeNull();
    });
});
