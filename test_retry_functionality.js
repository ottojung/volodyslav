/**
 * Test script to verify retry functionality works correctly.
 * This script demonstrates the retry behavior when tasks fail.
 */

const { make } = require('./backend/src/cron');
const { fromSeconds } = require('./backend/src/time_duration');

async function testRetryFunctionality() {
    console.log('Testing retry functionality...');

    // Create mock capabilities with simple logger
    const logCalls = [];
    const mockCapabilities = {
        logger: {
            logError: (data, message) => {
                logCalls.push({ data, message });
                console.log('ERROR LOGGED:', message);
            }
        }
    };

    // Create cron scheduler
    const cron = make(mockCapabilities);

    // Create a callback that fails a few times then succeeds
    let callCount = 0;
    const flakyCallback = () => {
        callCount++;
        console.log(`Task executed, attempt ${callCount}`);

        if (callCount < 3) {
            console.log('Task failed, will retry...');
            throw new Error(`Simulated failure #${callCount}`);
        } else {
            console.log('Task succeeded!');
        }
    };

    // Schedule a task that runs every minute with 2-second retry delay
    const retryDelay = fromSeconds(2);
    console.log('Scheduling task with 2-second retry delay...');

    cron.schedule("test", "* * * * *", flakyCallback, retryDelay);
    

    // Let it run for a bit
    console.log('Waiting 10 seconds to observe retry behavior...');
    await new Promise(resolve => setTimeout(resolve, 10000));

    // Check if errors were logged
    console.log('\nLogger calls:');
    console.log('logError calls:', logCalls.length);
    if (logCalls.length > 0) {
        console.log('First error log:', logCalls[0]);
    }

    // Clean up
    cron.cancelAll();
    console.log('Test completed - cleanup done');
}

testRetryFunctionality().catch(console.error);
