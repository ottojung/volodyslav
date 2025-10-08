/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { initializeTasks } = require("./persistence");
const { validateRegistrations } = require("./registration_validation");
const { generateSchedulerIdentifier } = require("./scheduler_identifier");
const memconst = require("../memconst");

/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */
/** @typedef {import('./types').SchedulerCapabilities} SchedulerCapabilities */
/** @typedef {import('./types').ParsedRegistrations} ParsedRegistrations */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @param {() => SchedulerCapabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {ReturnType<makePollingScheduler> | null} */
    let pollingScheduler = null;

    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * Parse registrations into internal format.
     * @param {Registration[]} registrations
     * @returns {ParsedRegistrations}
     */
    function parseRegistrations(registrations) {
        /** @type {ParsedRegistrations} */
        const parsedRegistrations = new Map();
        registrations.forEach(([name, cronExpression, callback, retryDelay]) =>
            parsedRegistrations.set(name, {
                name,
                parsedCron: parseCronExpression(cronExpression),
                callback,
                retryDelay
            }));
        return parsedRegistrations;
    }

    /**
     * Schedule all tasks and handle errors.
     * @param {Registration[]} registrations
     * @param {ReturnType<makePollingScheduler>} pollingScheduler
     * @param {SchedulerCapabilities} capabilities
     * @returns {Promise<void>}
     */
    async function scheduleAllTasks(registrations, pollingScheduler, capabilities) {
        for (const [name, cronExpression, , retryDelay] of registrations) {
            await pollingScheduler.schedule(name);
            capabilities.logger.logDebug(
                {
                    taskName: name,
                    cronExpression,
                    retryDelayMs: retryDelay.toMillis()
                },
                "Task scheduled successfully"
            );
        }
    }

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations) {
        const capabilities = getCapabilitiesMemo();
        
        // Validate registrations before any processing
        validateRegistrations(registrations);
        
        const parsedRegistrations = parseRegistrations(registrations);

        // Each time we initialize, we generate a new scheduler identifier
        const schedulerIdentifier = generateSchedulerIdentifier(capabilities);
        capabilities.logger.logDebug(
            { schedulerIdentifier },
            "Generated scheduler identifier"
        );

        const existingScheduler = pollingScheduler;
        const isReinitialization = existingScheduler !== null;

        const nextScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);

        async function stopSchedulerWithWarning(scheduler, message) {
            try {
                await scheduler.stopLoop();
            } catch (stopError) {
                capabilities.logger.logWarning(
                    {
                        errorName: stopError.name,
                        errorMessage: stopError.message,
                    },
                    message
                );
            }
        }

        if (!isReinitialization) {
            capabilities.logger.logDebug(
                {},
                "Creating new polling scheduler"
            );
        }

        try {
            // Apply materialization logic to detect and log changes, and update persisted state
            await initializeTasks(capabilities, parsedRegistrations, schedulerIdentifier);

            // Schedule all tasks (including newly added ones)
            await scheduleAllTasks(registrations, nextScheduler, capabilities);
        } catch (error) {
            await stopSchedulerWithWarning(nextScheduler, "Failed to stop candidate scheduler after initialization failure");
            throw error;
        }

        if (isReinitialization) {
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized, stopping current scheduler and recreating with new registrations"
            );

            try {
                await existingScheduler.stopLoop();
            } catch (stopError) {
                await stopSchedulerWithWarning(
                    nextScheduler,
                    "Failed to stop candidate scheduler after previous scheduler stop failure"
                );
                throw stopError;
            }
        }

        pollingScheduler = nextScheduler;

        capabilities.logger.logDebug(
            {
                totalRegistrations: registrations.length,
            },
            isReinitialization ? "Scheduler reinitialization completed" : "Scheduler initialization completed"
        );
    }

    /**
     * Stop the scheduler gracefully with enhanced error handling and logging.
     * @type {Stop}
     */
    async function stop() {
        const capabilities = getCapabilitiesMemo();
        if (pollingScheduler !== null) {
            capabilities.logger.logDebug(
                {},
                "Stopping scheduler gracefully"
            );

            await pollingScheduler.stopLoop();
            pollingScheduler = null;

            capabilities.logger.logInfo({}, "Scheduler stopped successfully");
        } else {
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