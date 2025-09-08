/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { mutateTasks } = require("./persistence");
const { isScheduleDuplicateTaskError } = require("./registration_validation");
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

const { validateRegistrations } = require("./registration_validation");
const { analyzeStateChanges } = require("./state_validation");

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
     * Handle orphaned task detection by detecting tasks that were running under different scheduler identifier.
     * @param {ParsedRegistrations} parsedRegistrations
     * @param {SchedulerCapabilities} capabilities
     * @param {string} currentSchedulerIdentifier
     * @returns {Promise<Set<string>>} Set of orphaned task names
     */
    async function detectOrphanedTasks(parsedRegistrations, capabilities, currentSchedulerIdentifier) {
        const orphanedTaskNames = new Set();
        
        // Get persisted state to detect orphaned tasks
        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        const getStorage = async (storage) => await storage.getExistingState();
        const currentState = await capabilities.state.transaction(getStorage);
        const persistedTasks = currentState?.tasks || [];
        
        // Detect orphaned tasks from persisted state
        const restartedTasks = [];
        for (const record of persistedTasks) {
            const hasLastAttemptTime = record.lastAttemptTime !== undefined;
            const isFromDifferentScheduler = record.schedulerIdentifier !== undefined && record.schedulerIdentifier !== currentSchedulerIdentifier;
            
            if (hasLastAttemptTime && isFromDifferentScheduler && parsedRegistrations.has(record.name)) {
                // Only restart tasks that are still in the new registrations
                orphanedTaskNames.add(record.name);
                restartedTasks.push({
                    taskName: record.name,
                    previousSchedulerIdentifier: record.schedulerIdentifier || "unknown",
                    currentSchedulerIdentifier
                });
            }
        }

        // Log orphaned task warnings
        for (const { taskName, previousSchedulerIdentifier } of restartedTasks) {
            capabilities.logger.logWarning(
                {
                    taskName,
                    previousSchedulerIdentifier,
                    currentSchedulerIdentifier,
                },
                `Task was interrupted during shutdown and will be restarted`);
        }

        return orphanedTaskNames;
    }

    /**
     * Get persisted state for analysis.
     * @param {Registration[]} registrations
     * @param {SchedulerCapabilities} capabilities
     * @returns {Promise<{persistedTasks: import('../runtime_state_storage/types').TaskRecord[] | undefined}>}
     */
    async function getPersistedState(registrations, capabilities) {
        validateRegistrations(registrations);

        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        async function getStorage(storage) {
            return await storage.getExistingState();
        }

        const currentState = await capabilities.state.transaction(getStorage);
        const persistedTasks = currentState?.tasks;

        if (persistedTasks === undefined) {
            capabilities.logger.logDebug(
                {
                    registeredTaskCount: registrations.length,
                    taskNames: registrations.map(([name]) => name)
                },
                "First-time scheduler initialization: registering initial tasks"
            );
        } else {
            capabilities.logger.logDebug(
                {
                    persistedTaskCount: persistedTasks.length,
                    registrationCount: registrations.length
                },
                "Analyzing task registrations against persisted state"
            );
            // Log changes that will be made
            analyzeStateChanges(registrations, persistedTasks, capabilities);
        }

        return { persistedTasks };
    }

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
            // Scheduler already running
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized"
            );
            // Still analyze registrations against persisted state for consistency.
            await getPersistedState(registrations, capabilities);
            return;
        }

        // Create polling scheduler
        pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        // Get persisted state 
        const { persistedTasks } = await getPersistedState(registrations, capabilities);

        if (persistedTasks === undefined) {
            // First initialization - persist initial tasks
            await mutateTasks(capabilities, parsedRegistrations, async () => undefined);
        } else {
            // Detect orphaned tasks
            const orphanedTaskNames = await detectOrphanedTasks(parsedRegistrations, capabilities, schedulerIdentifier);
            
            // Persist tasks with per-task override logic and orphaned task handling
            await mutateTasks(capabilities, parsedRegistrations, async () => undefined, orphanedTaskNames);
        }

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