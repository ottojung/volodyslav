/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("../cron");
const cronScheduler = require("../cron");
const { mutateTasks } = require("../cron/scheduling");
const memconst = require("../memconst");

const {
    ScheduleTaskError,
    StopSchedulerError,
} = require("./errors");

const {
    validateTasksAgainstPersistedStateInner,
    validateRegistrations,
} = require("./validation");

/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */
/** @typedef {import('./types').Capabilities} Capabilities */
/** @typedef {import('./types').ParsedRegistrations} ParsedRegistrations */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @param {() => Capabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {ReturnType<cronScheduler.make> | null} */
    let pollingScheduler = null;

    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations) {
        // Validate input parameters
        const capabilities = getCapabilitiesMemo();
        validateRegistrations(registrations, capabilities);

        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        async function getStorage(storage) {
            return await storage.getExistingState();
        }

        const currentState = await capabilities.state.transaction(getStorage);
        const persistedTasks = currentState?.tasks;

        // Always validate registrations against persisted state (unless first-time with empty state)
        if (persistedTasks === undefined) {
            capabilities.logger.logInfo(
                {
                    registeredTaskCount: registrations.length,
                    taskNames: registrations.map(([name]) => name)
                },
                "First-time scheduler initialization: registering initial tasks"
            );
        } else {
            // Validate registrations match persisted state
            capabilities.logger.logDebug(
                {
                    persistedTaskCount: persistedTasks.length,
                    registrationCount: registrations.length
                },
                "Validating task registrations against persisted state"
            );
            validateTasksAgainstPersistedStateInner(registrations, persistedTasks);
        }

        // Handle polling scheduler lifecycle
        if (pollingScheduler !== null) {
            // Scheduler already running
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized"
            );
            return;
        }

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        /** @type {ParsedRegistrations} */
        const parsedRegistrations = new Map();
        registrations.forEach(([name, cronExpression, callback, retryDelay]) =>
            parsedRegistrations.set(name, {
                name,
                parsedCron: parseCronExpression(cronExpression),
                callback,
                retryDelay
            }));

        if (persistedTasks === undefined) {
            await mutateTasks(capabilities, parsedRegistrations, async () => undefined);
        }

        pollingScheduler = cronScheduler.make(capabilities, parsedRegistrations);

        let scheduledCount = 0;
        let skippedCount = 0;

        for (const [name, cronExpression, callback, retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name, cronExpression, callback, retryDelay);
                scheduledCount++;
                capabilities.logger.logDebug(
                    {
                        taskName: name,
                        cronExpression,
                        retryDelayMs: retryDelay.toMilliseconds()
                    },
                    "Task scheduled successfully"
                );
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (cronScheduler.isScheduleDuplicateTaskError(error)) {
                    skippedCount++;
                    capabilities.logger.logDebug(
                        { taskName: name },
                        "Task already scheduled - scheduler already initialized"
                    );
                } else {
                    // Enhanced error context for debugging
                    const errorObj = error instanceof Error ? error : new Error(String(error));
                    throw new ScheduleTaskError(`Failed to schedule task '${name}': ${errorObj.message}`, { name, cronExpression, cause: errorObj });
                }
            }
        }

        capabilities.logger.logInfo(
            {
                totalRegistrations: registrations.length,
                scheduledCount,
                skippedCount
            },
            "Scheduler initialization completed"
        );
    }

    /**
     * Stop the scheduler gracefully with enhanced error handling and logging.
     * @type {Stop}
     */
    async function stop() {
        if (pollingScheduler !== null) {
            const capabilities = getCapabilitiesMemo();
            try {
                capabilities.logger.logInfo(
                    {},
                    "Stopping scheduler gracefully"
                );

                await pollingScheduler.stop();
                pollingScheduler = null;

                capabilities.logger.logInfo({}, "Scheduler stopped successfully");
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                // Still clean up state even if stop failed
                pollingScheduler = null;
                throw new StopSchedulerError(`Failed to stop scheduler: ${error.message}`, { cause: error });
            }
        } else {
            const capabilities = getCapabilitiesMemo();
            capabilities.logger.logDebug({}, "Scheduler already stopped or not initialized");
        }
    }

    return {
        initialize,
        stop,
    };
}

module.exports = {
    make,
};