/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { materializeAndPersistTasks } = require("./persistence");
const { isScheduleDuplicateTaskError, validateRegistrations } = require("./registration_validation");
const { generateSchedulerIdentifier } = require("./scheduler_identifier");
const memconst = require("../memconst");

/**
 * Error for task scheduling failures.
 */
class ScheduleTaskError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "ScheduleTaskError";
        this.details = details;
    }
}

/**
 * Error for scheduler stop failures.
 */
class StopSchedulerError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "StopSchedulerError";
        this.details = details;
    }
}

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
     * @returns {Promise<{scheduledCount: number, skippedCount: number}>}
     */
    async function scheduleAllTasks(registrations, pollingScheduler, capabilities) {
        let scheduledCount = 0;
        let skippedCount = 0;

        for (const [name, cronExpression, , retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name);
                scheduledCount++;
                capabilities.logger.logDebug(
                    {
                        taskName: name,
                        cronExpression,
                        retryDelayMs: retryDelay.toMillis()
                    },
                    "Task scheduled successfully"
                );
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (isScheduleDuplicateTaskError(error)) {
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

        return { scheduledCount, skippedCount };
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
            // Scheduler already running - still analyze and apply changes to persisted state
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized, analyzing registration changes"
            );
            
            // Apply materialization logic to detect and log changes, and update persisted state
            await materializeAndPersistTasks(capabilities, parsedRegistrations, schedulerIdentifier);
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
        await materializeAndPersistTasks(capabilities, parsedRegistrations, schedulerIdentifier);

        // Schedule all tasks
        const { scheduledCount, skippedCount } = await scheduleAllTasks(registrations, pollingScheduler, capabilities);

        capabilities.logger.logDebug(
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
        const capabilities = getCapabilitiesMemo();
        if (pollingScheduler !== null) {
            try {
                capabilities.logger.logInfo(
                    {},
                    "Stopping scheduler gracefully"
                );

                await pollingScheduler.stopLoop();
                pollingScheduler = null;

                capabilities.logger.logInfo({}, "Scheduler stopped successfully");
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                // Still clean up state even if stop failed
                pollingScheduler = null;
                throw new StopSchedulerError(`Failed to stop scheduler: ${error.message}`, { cause: error });
            }
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