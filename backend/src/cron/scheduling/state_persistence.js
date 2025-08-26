/**
 * State persistence and loading for the polling scheduler.
 * Handles saving and restoring task state to/from disk.
 */

const time_duration = require("../../time_duration");
const { parseCronExpression } = require("../parser");

/** 
 * @typedef {import('../polling_scheduler').Task} Task 
 * @typedef {import('./types').Registration} Registration
 * @typedef {import('./types').ParsedRegistration} ParsedRegistration
 * @typedef {import('./types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('./types').Transformation} Transformation
 * @typedef {import('../../runtime_state_storage/types').TaskRecord} TaskRecord
 */

/**
 * Loads persisted task state and builds in-memory tasks map
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @returns {Promise<void>}
 */
async function loadPersistedState(capabilities, registrations) {
    try {
        await capabilities.state.transaction(async (storage) => {
            const existingState = await storage.getExistingState();
            let taskCount = 0;

            if (existingState === null) {
                // No existing state - start fresh
                capabilities.logger.logInfo({ taskCount: 0 }, "Scheduler state loaded");
                return;
            }

            // Handle migration logging
            if (existingState.version === 1) {
                capabilities.logger.logInfo(
                    { from: 1, to: 2 },
                    "Runtime state migrated"
                );
            }

            // Build in-memory tasks from persisted state
            for (const record of existingState.tasks) {
                try {
                    // Parse cron expression
                    const parsedCron = parseCronExpression(record.cronExpression);

                    // Convert retryDelayMs to TimeDuration
                    const retryDelay = time_duration.fromMilliseconds(record.retryDelayMs);

                    // Convert DateTime objects to native Date objects
                    const lastSuccessTime = record.lastSuccessTime
                        ? capabilities.datetime.toNativeDate(record.lastSuccessTime)
                        : undefined;

                    const lastFailureTime = record.lastFailureTime
                        ? capabilities.datetime.toNativeDate(record.lastFailureTime)
                        : undefined;

                    const lastAttemptTime = record.lastAttemptTime
                        ? capabilities.datetime.toNativeDate(record.lastAttemptTime)
                        : undefined;

                    const pendingRetryUntil = record.pendingRetryUntil
                        ? capabilities.datetime.toNativeDate(record.pendingRetryUntil)
                        : undefined;

                    const lastEvaluatedFire = record.lastEvaluatedFire
                        ? capabilities.datetime.toNativeDate(record.lastEvaluatedFire)
                        : undefined;

                    /** @type {Task} */
                    const task = {
                        name: record.name,
                        cronExpression: record.cronExpression,
                        parsedCron,
                        callback: null, // Will be set when task is re-registered
                        retryDelay,
                        lastSuccessTime,
                        lastFailureTime,
                        lastAttemptTime,
                        pendingRetryUntil,
                        lastEvaluatedFire,
                        running: false, // Never restore running state
                    };

                    tasks.set(record.name, task);
                    taskCount++;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    capabilities.logger.logError(
                        { taskName: record.name, error: message },
                        `Failed to load persisted task: ${message}`
                    );
                    // Continue loading other tasks
                }
            }

            capabilities.logger.logInfo({ taskCount }, "Scheduler state loaded");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ message }, `State load failed: ${message}`);
        throw error;
    }
}

/**
 * Materialize task records into Task objects.
 * @param {ParsedRegistrations} registrations
 * @param {TaskRecord[]} taskRecords
 * @returns {Map<string, Task>}
 */
function materializeTasks(registrations, taskRecords) {
    /** @type {Map<string, Task>} */
    const tasks = new Map();

    for (const record of taskRecords) {
        const name = record.name;

        if (name in tasks) {
            // FIXME: make it a proper error.    
            throw new Error(`Task ${name} is already registered`);
        }

        const registration = registrations.get(name);
        if (registration === undefined) {
            // FIXME: make it a proper error.    
            throw new Error(`Task ${name} is not found`);
        }

        const { parsedCron, callback, retryDelay } = registration;

        const lastSuccessTime = record.lastSuccessTime
            ? new Date(record.lastSuccessTime.getTime())
            : undefined;
        const lastFailureTime = record.lastFailureTime
            ? new Date(record.lastFailureTime.getTime())
            : undefined;
        const lastAttemptTime = record.lastAttemptTime
            ? new Date(record.lastAttemptTime.getTime())
            : undefined;
        const pendingRetryUntil = record.pendingRetryUntil
            ? new Date(record.pendingRetryUntil.getTime())
            : undefined;
        const lastEvaluatedFire = record.lastEvaluatedFire
            ? new Date(record.lastEvaluatedFire.getTime())
            : undefined;

        /** @type {Task} */
        const task = {
            name,
            parsedCron,
            callback,
            retryDelay,
            lastSuccessTime,
            lastFailureTime,
            lastAttemptTime,
            pendingRetryUntil,
            lastEvaluatedFire,
            running: false,
        };

        tasks.set(name, task);
    }

    return tasks;
}

/**
 * Persist current scheduler state to disk
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {Registration[]} registrations
 * @param {Transformation} transformation
 * @returns {Promise<void>}
 */
async function persistCurrentState(capabilities, registrations, transformation) {
    try {
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();
            const currentTaskRecords = currentState.tasks;
            const currentTasks = materializeTasks(registrations, currentTaskRecords);
            const newTasks = transformation(currentTasks);

            // Convert tasks to serializable format
            const taskRecords = Array.from(newTasks.values()).map((task) => ({
                name: task.name,
                cronExpression: task.cronExpression,
                retryDelayMs: task.retryDelay.toMilliseconds(),
                lastSuccessTime: task.lastSuccessTime
                    ? capabilities.datetime.fromEpochMs(task.lastSuccessTime.getTime())
                    : undefined,
                lastFailureTime: task.lastFailureTime
                    ? capabilities.datetime.fromEpochMs(task.lastFailureTime.getTime())
                    : undefined,
                lastAttemptTime: task.lastAttemptTime
                    ? capabilities.datetime.fromEpochMs(task.lastAttemptTime.getTime())
                    : undefined,
                pendingRetryUntil: task.pendingRetryUntil
                    ? capabilities.datetime.fromEpochMs(task.pendingRetryUntil.getTime())
                    : undefined,
                lastEvaluatedFire: task.lastEvaluatedFire
                    ? capabilities.datetime.fromEpochMs(task.lastEvaluatedFire.getTime())
                    : undefined,
            }));

            // Update state with new task records
            const newState = {
                version: currentState.version,
                startTime: currentState.startTime,
                tasks: taskRecords,
            };

            storage.setState(newState);

            capabilities.logger.logDebug({ taskCount: newTasks.size }, "State persisted");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ message }, `State write failed: ${message}`);
        throw error;
    }
}

module.exports = {
    loadPersistedState,
    persistCurrentState,
};
