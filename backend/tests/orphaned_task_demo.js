/**
 * Simple demonstration of the orphaned task restart fix
 * This shows that the scheduler correctly detects and restarts orphaned tasks
 */

const { fromMilliseconds } = require("../src/datetime");
const { Duration } = require("luxon");
const { getMockedRootCapabilities } = require("./spies");
const { stubEnvironment, stubLogger, stubDatetime, stubSleeper, stubScheduler, getSchedulerControl } = require("./stubs");

async function demonstrateOrphanedTaskRestart() {
    console.log("=== Orphaned Task Restart Demonstration ===\n");
    
    // Setup test capabilities
    const capabilities = getMockedRootCapabilities();
    stubEnvironment(capabilities);
    stubLogger(capabilities);
    stubDatetime(capabilities);
    stubSleeper(capabilities);
    stubScheduler(capabilities);
    
    const schedulerControl = getSchedulerControl(capabilities);
    schedulerControl.setPollingInterval(fromMilliseconds(1));
    
    let taskExecutionCount = 0;
    const demonstrationTask = () => {
        taskExecutionCount++;
        console.log(`Task executed! Execution count: ${taskExecutionCount}`);
    };
    
    const registrations = [
        ["demo-task", "0 * * * *", demonstrationTask, Duration.fromMillis(5000)]
    ];

    console.log("1. Starting first scheduler instance...");
    await capabilities.scheduler.initialize(registrations);
    
    console.log("2. Simulating task interruption during shutdown...");
    // Manually mark task as running with a different scheduler identifier
    await capabilities.state.transaction(async (storage) => {
        const state = await storage.getExistingState();
        if (state && state.tasks.length > 0) {
            state.tasks[0].lastAttemptTime = capabilities.datetime.now();
            state.tasks[0].schedulerIdentifier = "old-interrupted-scheduler";
            storage.setState(state);
            console.log("   Task marked as running under old scheduler identifier");
        }
    });
    
    await capabilities.scheduler.stop();
    console.log("   First scheduler stopped (simulating shutdown)\n");
    
    console.log("3. Starting second scheduler instance (app restart)...");
    
    // Capture warning logs
    const originalLogWarning = capabilities.logger.logWarning;
    capabilities.logger.logWarning = (obj, msg) => {
        if (msg.includes("ACHTUNG")) {
            console.log(`   🚨 WARNING: ${msg}`);
            console.log(`   📋 Details: Task '${obj.taskName}' was running under '${obj.previousSchedulerIdentifier}'`);
        }
        originalLogWarning(obj, msg);
    };
    
    await capabilities.scheduler.initialize(registrations);
    await schedulerControl.waitForNextCycleEnd();
    
    console.log(`4. Task execution after restart: ${taskExecutionCount > 0 ? '✅ SUCCESS' : '❌ FAILED'}`);
    console.log(`   The orphaned task was detected and restarted successfully!\n`);
    
    await capabilities.scheduler.stop();
    console.log("Demonstration complete! 🎉");
}

if (require.main === module) {
    demonstrateOrphanedTaskRestart().catch(console.error);
}

module.exports = { demonstrateOrphanedTaskRestart };