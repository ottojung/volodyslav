/**
 * Example usage of the retryer system.
 * This demonstrates how to use withRetry for different scenarios.
 */

const { withRetry } = require("./core");
const { fromSeconds, fromMinutes } = require("../time_duration");

/**
 * Example 1: A task that eventually succeeds
 * @param {import('./core').RetryerCapabilities} capabilities
 */
async function exampleSuccessfulTask(capabilities) {
    let attempts = 0;

    const taskCallback = async () => {
        attempts++;
        capabilities.logger.logInfo(
            { attempt: attempts },
            `Task attempt ${attempts}`
        );

        // Succeed after 3 attempts
        if (attempts >= 3) {
            capabilities.logger.logInfo({}, "Task completed successfully!");
            return null; // Success - no retry needed
        }

        // Request retry with exponential backoff
        const delay = fromSeconds(Math.pow(2, attempts - 1)); // 1s, 2s, 4s...
        capabilities.logger.logInfo(
            { retryDelay: delay.toString() },
            `Task failed, retrying in ${delay.toString()}`
        );
        return delay;
    };

    await withRetry(capabilities, taskCallback);
}

/**
 * Example 2: A periodic health check that retries on failure
 * @param {import('./core').RetryerCapabilities} capabilities
 */
async function exampleHealthCheck(capabilities) {
    const healthCheckCallback = async () => {
        try {
            // Simulate health check logic
            const isHealthy = Math.random() > 0.3; // 70% success rate

            if (isHealthy) {
                capabilities.logger.logInfo({}, "Health check passed");
                return null; // Success
            } else {
                capabilities.logger.logWarning({}, "Health check failed, retrying");
                return fromMinutes(1); // Retry in 1 minute
            }
        } catch (error) {
            capabilities.logger.logError({ error }, "Health check threw error");
            return fromMinutes(5); // Retry in 5 minutes on error
        }
    };

    await withRetry(capabilities, healthCheckCallback);
}

/**
 * Example 3: A resource cleanup task that might need retries
 * @param {import('./core').RetryerCapabilities} capabilities
 */
async function exampleCleanupTask(capabilities) {
    const resources = ['resource1', 'resource2', 'resource3'];
    /** @type {string[]} */
    let cleanedUp = [];

    const cleanupCallback = async () => {
        try {
            // Simulate cleaning up resources
            for (const resource of resources) {
                if (!cleanedUp.includes(resource)) {
                    // Simulate random cleanup success/failure
                    if (Math.random() > 0.4) {
                        cleanedUp.push(resource);
                        capabilities.logger.logInfo(
                            { resource, cleaned: cleanedUp.length, total: resources.length },
                            `Cleaned up ${resource}`
                        );
                    }
                }
            }

            if (cleanedUp.length === resources.length) {
                capabilities.logger.logInfo({}, "All resources cleaned up successfully");
                return null; // Success
            } else {
                const remaining = resources.length - cleanedUp.length;
                capabilities.logger.logWarning(
                    { remaining, cleanedUp: cleanedUp.length },
                    `${remaining} resources still need cleanup`
                );
                return fromSeconds(30); // Retry in 30 seconds
            }
        } catch (error) {
            capabilities.logger.logError({ error }, "Cleanup task failed");
            return fromMinutes(2); // Retry in 2 minutes on error
        }
    };

    await withRetry(capabilities, cleanupCallback);
}

module.exports = {
    exampleSuccessfulTask,
    exampleHealthCheck,
    exampleCleanupTask,
};
