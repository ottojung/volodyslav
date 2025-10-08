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

    /** @type {string | null} */
    let schedulerIdentifier = null;

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

        // Generate scheduler identifier if not already done
        if (schedulerIdentifier === null) {
            schedulerIdentifier = generateSchedulerIdentifier(capabilities);
            capabilities.logger.logDebug(
                { schedulerIdentifier },
                "Generated scheduler identifier"
            );
        }

        // Check for existing polling scheduler
        if (pollingScheduler !== null) {
            // Scheduler already running - need to update with new registrations
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized, stopping current scheduler and recreating with new registrations"
            );
            
            // Stop the existing scheduler
            await pollingScheduler.stopLoop();
            pollingScheduler = null;
            
            // Create new polling scheduler with updated registrations
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);
            
            // Apply materialization logic to detect and log changes, and update persisted state
            await initializeTasks(capabilities, parsedRegistrations, schedulerIdentifier);
            
            // Schedule all tasks (including newly added ones)
            await scheduleAllTasks(registrations, pollingScheduler, capabilities);
            
            capabilities.logger.logDebug(
                {
                    totalRegistrations: registrations.length,
                },
                "Scheduler reinitialization completed"
            );
            return;
        } else {
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);
        }

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        // Apply clean materialization logic (handles persisted state, logging, and orphaned tasks internally)
        await initializeTasks(capabilities, parsedRegistrations, schedulerIdentifier);

        // Schedule all tasks
        await scheduleAllTasks(registrations, pollingScheduler, capabilities);

        capabilities.logger.logDebug(
            {
                totalRegistrations: registrations.length,
            },
            "Scheduler initialization completed"
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