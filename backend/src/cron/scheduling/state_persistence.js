/**
 * State persistence and loading for the polling scheduler.
 * Handles saving and restoring task state to/from disk.
 */

const structure = require("../../runtime_state_storage/structure");
const time_duration = require("../../time_duration");
const { parseCronExpression } = require("../parser");

/** @typedef {import('../polling_scheduler').Task} Task */

/**
 * Loads persisted task state and builds in-memory tasks map
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {Map<string, Task>} tasks
 * @returns {Promise<void>}
 */
async function loadPersistedState(capabilities, tasks) {
    try {
        await capabilities.state.transaction(async (storage) => {
            const existingState = await storage.getExistingState();
            let taskCount = 0;

            if (existingState === null) {
                // No existing state - start fresh
                capabilities.logger.logInfo({ taskCount: 0 }, "SchedulerStateLoaded");
                return;
            }

            // Handle migration logging
            if (existingState.version === 1) {
                capabilities.logger.logInfo(
                    { from: 1, to: 2 },
                    "RuntimeStateMigrated"
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
                        "FailedToLoadPersistedTask"
                    );
                    // Continue loading other tasks
                }
            }

            capabilities.logger.logInfo({ taskCount }, "SchedulerStateLoaded");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ message }, "StateLoadFailed");
        // Non-fatal: continue with empty state
    }
}

/**
 * Persist current scheduler state to disk
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {Map<string, Task>} tasks
 * @returns {Promise<void>}
 */
async function persistCurrentState(capabilities, tasks) {
    try {
        await capabilities.state.transaction(async (storage) => {
            const currentState = await storage.getCurrentState();

            // Convert tasks to serializable format
            const taskRecords = Array.from(tasks.values()).map((task) => ({
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

            capabilities.logger.logDebug({ taskCount: tasks.size }, "State persisted");
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        capabilities.logger.logError({ message }, `State write failed: ${message}`);
        // Continue running - write failures are non-fatal
    }
}

module.exports = {
    loadPersistedState,
    persistCurrentState,
};