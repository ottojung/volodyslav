/**
 * Declarative scheduler that exposes only a single initialization entrypoint.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 */

const cronScheduler = require("../cron");
const { transaction } = require("../runtime_state_storage");

/**
 * Error thrown when the task list provided to initialize() differs from persisted runtime state.
 */
class TaskListMismatchError extends Error {
    /**
     * @param {string} message
     * @param {object} mismatchDetails
     * @param {string[]} mismatchDetails.missing - Tasks in persisted state but not in registrations
     * @param {string[]} mismatchDetails.extra - Tasks in registrations but not in persisted state
     * @param {Array<{name: string, field: string, expected: any, actual: any}>} mismatchDetails.differing - Tasks with differing properties
     */
    constructor(message, mismatchDetails) {
        super(message);
        this.name = "TaskListMismatchError";
        this.mismatchDetails = mismatchDetails;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskListMismatchError}
 */
function isTaskListMismatchError(object) {
    return object instanceof TaskListMismatchError;
}

/** @typedef {import('../time_duration/structure').TimeDuration} TimeDuration */
/** @typedef {import('./tasks').Capabilities} Capabilities */

/**
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler
 * @property {Stop} stop - Stops the scheduler
 */

/**
 * Registration tuple: [name, cronExpression, callback, retryDelay]
 * @typedef {[string, string, () => Promise<void>, TimeDuration]} Registration
 */

/**
 * Task identity for comparison
 * @typedef {object} TaskIdentity
 * @property {string} name - Task name
 * @property {string} cronExpression - Cron expression
 * @property {number} retryDelayMs - Retry delay in milliseconds
 */

/**
 * Converts a registration to a TaskIdentity for comparison
 * @param {Registration} registration
 * @returns {TaskIdentity}
 */
function registrationToTaskIdentity(registration) {
    const [name, cronExpression, , retryDelay] = registration;
    return {
        name,
        cronExpression,
        retryDelayMs: retryDelay.toMilliseconds(),
    };
}

/**
 * Converts a persisted TaskRecord to a TaskIdentity for comparison
 * @param {import('../runtime_state_storage/types').TaskRecord} taskRecord
 * @returns {TaskIdentity}
 */
function taskRecordToTaskIdentity(taskRecord) {
    return {
        name: taskRecord.name,
        cronExpression: taskRecord.cronExpression,
        retryDelayMs: taskRecord.retryDelayMs,
    };
}

/**
 * Compares two TaskIdentity objects for equality
 * @param {TaskIdentity} a
 * @param {TaskIdentity} b
 * @returns {boolean}
 */
function taskIdentitiesEqual(a, b) {
    return (a.name === b.name &&
        a.cronExpression === b.cronExpression &&
        a.retryDelayMs === b.retryDelayMs);
}

/**
 * Validates that registrations match persisted runtime state (inner implementation)
 * @param {Registration[]} registrations
 * @param {import('../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @returns {void}
 * @throws {TaskListMismatchError} if tasks don't match
 */
function validateTasksAgainstPersistedStateInner(registrations, persistedTasks) {
    // Convert to comparable identities
    const registrationIdentities = registrations.map(registrationToTaskIdentity);
    const persistedIdentities = persistedTasks.map(taskRecordToTaskIdentity);

    // Sort by name for deterministic comparison
    registrationIdentities.sort((a, b) => a.name.localeCompare(b.name));
    persistedIdentities.sort((a, b) => a.name.localeCompare(b.name));

    // Find mismatches
    const registrationMap = new Map(registrationIdentities.map(t => [t.name, t]));
    const persistedMap = new Map(persistedIdentities.map(t => [t.name, t]));

    const missing = [];
    const extra = [];
    const differing = [];

    // Find tasks in persisted state but not in registrations
    for (const persistedTask of persistedIdentities) {
        if (!registrationMap.has(persistedTask.name)) {
            missing.push(persistedTask.name);
        }
    }

    // Find tasks in registrations but not in persisted state
    for (const regTask of registrationIdentities) {
        if (!persistedMap.has(regTask.name)) {
            extra.push(regTask.name);
        }
    }

    // Find tasks with differing properties
    for (const regTask of registrationIdentities) {
        const persistedTask = persistedMap.get(regTask.name);
        if (persistedTask && !taskIdentitiesEqual(regTask, persistedTask)) {
            if (regTask.cronExpression !== persistedTask.cronExpression) {
                differing.push({
                    name: regTask.name,
                    field: 'cronExpression',
                    expected: persistedTask.cronExpression,
                    actual: regTask.cronExpression
                });
            }
            if (regTask.retryDelayMs !== persistedTask.retryDelayMs) {
                differing.push({
                    name: regTask.name,
                    field: 'retryDelayMs',
                    expected: persistedTask.retryDelayMs,
                    actual: regTask.retryDelayMs
                });
            }
        }
    }

    // If any mismatches found, throw error
    if (missing.length > 0 || extra.length > 0 || differing.length > 0) {
        const mismatchDetails = { missing, extra, differing };
        let message = "Task list mismatch detected:";

        if (missing.length > 0) {
            message += `\n  Missing tasks (in persisted state but not in registrations): ${missing.join(', ')}`;
        }
        if (extra.length > 0) {
            message += `\n  Extra tasks (in registrations but not in persisted state): ${extra.join(', ')}`;
        }
        if (differing.length > 0) {
            message += `\n  Differing tasks:`;
            for (const diff of differing) {
                message += `\n    ${diff.name}.${diff.field}: expected ${diff.expected}, got ${diff.actual}`;
            }
        }

        throw new TaskListMismatchError(message, mismatchDetails);
    }
}

/**
 * @typedef {object} PollerOptions
 * @property {number} [pollIntervalMs] - The polling interval in milliseconds.
 */

/**
 * @typedef {(capabilities: Capabilities, registrations: Array<Registration>, options?: PollerOptions) => Promise<void>} Initialize
 * @typedef {(capabilities: Capabilities) => Promise<void>} Stop
 */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @returns {Scheduler}
 * @throws {TaskListMismatchError} if registrations don't match persisted runtime state
 */
function make() {
    /** @type {ReturnType<cronScheduler.make> | null} */
    let pollingScheduler = null;

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(capabilities, registrations, options = {}) {

        /**
         * @param {import('../runtime_state_storage/class').RuntimeStateStorage} storage
         */
        async function getStorage(storage) {
            return await storage.getCurrentState();
        }

        const currentState = await transaction(capabilities, getStorage);
        const persistedTasks = currentState.tasks;

        // Always validate registrations against persisted state (unless first-time with empty state)
        if (persistedTasks.length === 0 && registrations.length > 0) {
            capabilities.logger.logInfo(
                { registeredTaskCount: registrations.length },
                "First-time scheduler initialization: registering initial tasks"
            );
        } else {
            // Validate registrations match persisted state
            validateTasksAgainstPersistedStateInner(registrations, persistedTasks);
        }

        if (pollingScheduler !== null) {
            // FIXME: change the polling interval if different requested via `options`.
            return;
        }

        // Create polling scheduler
        const cronOptions = {
            pollIntervalMs: options.pollIntervalMs,
        };

        pollingScheduler = cronScheduler.make(capabilities, cronOptions);

        for (const [name, cronExpression, callback, retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name, cronExpression, callback, retryDelay);
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (cronScheduler.isScheduleDuplicateTaskError(error)) {
                    capabilities.logger.logDebug(
                        { taskName: name },
                        "Task already scheduled - scheduler already initialized"
                    );
                } else {
                    // Re-throw any other errors
                    throw error;
                }
            }
        }
    }

    /**
     * Stop the scheduler.
     * @type {Stop}
     */
    async function stop(_capabilities) {
        if (pollingScheduler !== null) {
            await pollingScheduler.stop();
            pollingScheduler = null;
        }
    }

    return {
        initialize,
        stop,
    }
}

module.exports = {
    make,
    isTaskListMismatchError,
};
