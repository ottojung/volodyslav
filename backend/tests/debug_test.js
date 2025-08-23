/**
 * Debug test for runtime state capability
 */

const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubRuntimeStateStorage } = require("./stubs");

function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubRuntimeStateStorage(capabilities);
    return capabilities;
}

async function testStateTransaction() {
    const capabilities = getTestCapabilities();
    
    console.log("Testing capabilities.state.transaction...");
    
    try {
        const result = await capabilities.state.transaction(async (storage) => {
            console.log("Inside transaction");
            console.log("storage methods:", Object.keys(storage));
            return "test result";
        });
        
        console.log("Transaction result:", result);
    } catch (error) {
        console.error("Transaction error:", error);
    }
}

testStateTransaction().catch(console.error);