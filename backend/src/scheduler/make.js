/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { initializeTasks } = require("./persistence");
const { validateRegistrations } = require("./registration_validation");
const { SchedulerAlreadyActiveError } = require("./registration_validation/errors");
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
    
    /** @type {"uninitialized" | "initializing" | "running"} */
    let schedulerState = "uninitialized";
    let stopping = false;
    /** @type {Promise<void> | null} */
    let initializationPromise = null;

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
     * @returns {void}
     */
    function scheduleAllTasks(registrations, pollingScheduler, capabilities) {
        for (const [name, cronExpression, , retryDelay] of registrations) {
            pollingScheduler.schedule(name);
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
     * @type {Initialize}
     */
    async function proceedWithInitialization(registrations) {
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

        pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        // Apply clean materialization logic (handles persisted state, logging, and orphaned tasks internally)
        await initializeTasks(capabilities, parsedRegistrations, schedulerIdentifier);

        if (stopping) {
            capabilities.logger.logInfo(
                {},
                "Scheduler initialization aborted due to stop request"
            );
            return;
        }

        scheduleAllTasks(registrations, pollingScheduler, capabilities);
        capabilities.logger.logDebug(
            {
                totalRegistrations: registrations.length,
            },
            "Scheduler initialization completed"
        );
    }

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations) {
        // Check if scheduler is already initializing or running
        if (schedulerState === "initializing") {
            throw new SchedulerAlreadyActiveError("initializing");
        }
        if (schedulerState === "running") {
            throw new SchedulerAlreadyActiveError("running");
        }
        if (pollingScheduler !== null) {
            throw new Error("Impossible: pollingScheduler should be null if not running");
        }
        if (initializationPromise !== null) {
            throw new Error("Impossible: initializationPromise should be null if not running");
        }
        
        try {
            schedulerState = "initializing";
            initializationPromise = proceedWithInitialization(registrations);
            await initializationPromise;    
            initializationPromise = null;
            if (schedulerState === "initializing") {
                schedulerState = "running";
            }
        } catch (error) {
            initializationPromise = null;    
            await stop(); // Waiting is bounded because there should not be anything scheduled.
            throw error;
        }
    }

    /**
     * Stop the scheduler gracefully with enhanced error handling and logging.
     * @type {Stop}
     */
    async function stop() {
        const capabilities = getCapabilitiesMemo();

        stopping = true;

        if (initializationPromise !== null) {
            capabilities.logger.logDebug(
                {},
                "Scheduler is initializing, waiting for it to complete"
            );

            // Wait for initialization to complete
            try {
                await initializationPromise;
            } finally {
                // Ignore. We are stopping anyway.
            }
        }

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

        schedulerState = "uninitialized";
        stopping = false;
    }

    return {
        initialize,
        stop,
    };
}

module.exports = {
    make,
};