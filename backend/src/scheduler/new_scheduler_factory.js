/**
 * Clean scheduler factory implementation.
 * Creates scheduler instances using the new clean architecture.
 */

const { parseCronExpression } = require('./new_cron/parser');
const { makePollingScheduler } = require('./new_core/scheduler');
const { mutateTasks } = require('./new_core/state_manager');
const { validateRegistrations } = require('./new_validation/registration_validator');
const { validateTasksAgainstPersistedState } = require('./new_validation/state_validator');
const { 
    TaskListMismatchError,
    ScheduleTaskError,
    StopSchedulerError,
} = require('./new_errors');
const memconst = require("../memconst");

/** @typedef {import('./new_types/scheduler_types').Scheduler} Scheduler */
/** @typedef {import('./new_types/task_types').Registration} Registration */
/** @typedef {import('./new_types/scheduler_types').Initialize} Initialize */
/** @typedef {import('./new_types/scheduler_types').Stop} Stop */
/** @typedef {import('./tasks').Capabilities} Capabilities */
/** @typedef {import('./new_types/task_types').ParsedRegistrations} ParsedRegistrations */

/**
 * Create a new scheduler instance.
 * @param {() => Capabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {import('./new_core/scheduler')} */
    let pollingScheduler = null;

    /**
     * Parse and validate registrations.
     * @param {Registration[]} registrations
     * @param {Capabilities} capabilities
     * @returns {ParsedRegistrations}
     */
    function parseRegistrations(registrations, capabilities) {
        // Validate registrations format
        validateRegistrations(registrations, capabilities);

        // Parse and build registrations map
        const parsedRegistrations = new Map();
        
        for (const registration of registrations) {
            const [name, cronExpression, callback, retryDelay] = registration;
            
            // Parse cron expression
            const parsedCron = parseCronExpression(cronExpression);
            
            const parsedRegistration = {
                name,
                parsedCron,
                callback,
                retryDelay,
            };
            
            parsedRegistrations.set(name, parsedRegistration);
        }

        return parsedRegistrations;
    }

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations) {
        if (registrations === undefined || registrations === null) {
            throw new Error("Registrations parameter is required");
        }

        const capabilities = getCapabilities();
        
        try {
            // Parse and validate registrations
            const parsedRegistrations = parseRegistrations(registrations, capabilities);

            // Load persisted state and validate consistency
            const persistedTasks = await capabilities.state.transaction(async (storage) => {
                const state = await storage.getExistingState();
                return state ? state.tasks : [];
            });

            if (persistedTasks.length === 0 && registrations.length > 0) {
                // First-time initialization
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
                validateTasksAgainstPersistedState(registrations, persistedTasks);
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

            // Create new polling scheduler
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations);

            // Initialize state by ensuring all tasks are in the state store
            await mutateTasks(capabilities, parsedRegistrations, (tasks) => {
                capabilities.logger.logInfo(
                    { taskCount: tasks.size },
                    "Scheduler initialized with tasks"
                );
                return tasks; // Return unchanged tasks
            });

            // Auto-schedule all tasks
            for (const registration of parsedRegistrations.values()) {
                await pollingScheduler.schedule(registration.name);
            }

            capabilities.logger.logInfo(
                { taskCount: parsedRegistrations.size },
                "Scheduler initialization complete"
            );

        } catch (error) {
            // Let TaskListMismatchError propagate directly
            if (error instanceof TaskListMismatchError) {
                throw error;
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new ScheduleTaskError(`Failed to initialize scheduler: ${message}`, { cause: error });
        }
    }

    /**
     * Stop the scheduler and clean up resources.
     * @type {Stop}
     */
    async function stop() {
        try {
            if (pollingScheduler !== null) {
                await pollingScheduler.cancelAll();
                await pollingScheduler.stopLoop();
                pollingScheduler = null;
                
                const capabilities = getCapabilities();
                capabilities.logger.logInfo({}, "Scheduler stopped");
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new StopSchedulerError(`Failed to stop scheduler: ${message}`, { cause: error });
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