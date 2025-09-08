/**
 * State initialization and persistence core functionality.
 */

const { fromMinutes } = require("../../datetime");
const { makeDefault } = require('../../runtime_state_storage/structure');
const { materializeTasks, serializeTasks } = require('./materialization');
const { makeTask } = require('../task/structure');

/** 
 * @typedef {import('../task').Task} Task 
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('../../runtime_state_storage/types').TaskRecord} TaskRecord
 */

/**
 * @template T
 * @typedef {import('../types').Transformation<T>} Transformation
 */

/**
 * Get or create current state for the scheduler.
 * @param {import('../../runtime_state_storage/class').RuntimeStateStorage} storage
 * @param {ParsedRegistrations} registrations
 * @param {import('../../datetime').Datetime} datetime
 * @returns {Promise<import('../../runtime_state_storage/types').RuntimeState>}
 */
async function getCurrentState(storage, registrations, datetime) {
    const now = datetime.now();    
    const lastMinute = now.subtract(fromMinutes(1));
    const existingState = await storage.getExistingState();
    if (existingState === null) {
        const ret = makeDefault(datetime);

        for (const registration of registrations.values()) {
            ret.tasks.push({
                name: registration.name,
                cronExpression: registration.parsedCron.original,
                retryDelayMs: registration.retryDelay.toMillis(),
                lastAttemptTime: lastMinute,
                lastSuccessTime: lastMinute,
            });
        }

        return ret;
    } else {
        return existingState;
    }
}

/**
 * Persist current scheduler state to disk
 * @template T
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {Transformation<T>} transformation
 * @param {boolean} [forceOverride=false] - If true, create fresh tasks from registrations instead of materializing persisted tasks
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation, forceOverride = false) {
    return await capabilities.state.transaction(async (storage) => {
        const currentState = await getCurrentState(storage, registrations, capabilities.datetime);
        const currentTaskRecords = currentState.tasks;
        
        let tasks;
        if (forceOverride) {
            // Create fresh tasks from registrations, preserving timing information from persisted tasks
            const now = capabilities.datetime.now();
            tasks = createFreshTasksFromRegistrations(registrations, currentTaskRecords, now);
            capabilities.logger.logDebug({ taskCount: tasks.size }, "Created fresh tasks from registrations (override)");
        } else {
            // Use existing materialization logic
            tasks = materializeTasks(registrations, currentTaskRecords);
        }
        
        const result = transformation(tasks);

        // Convert tasks to serializable format using Task.serialize()
        const taskRecords = serializeTasks(tasks);

        // Update state with new task records while preserving other state fields
        const newState = {
            ...currentState,
            tasks: taskRecords,
        };

        storage.setState(newState);

        capabilities.logger.logDebug({ taskCount: tasks.size }, "State persisted");
        return result;
    });
}

/**
 * Create fresh tasks from registrations while preserving timing information from persisted tasks.
 * Used when override is needed due to configuration mismatches.
 * @param {ParsedRegistrations} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTaskRecords
 * @param {import('../../datetime').DateTime} now - Current time for setting default timing for new tasks
 * @returns {Map<string, Task>}
 */
function createFreshTasksFromRegistrations(registrations, persistedTaskRecords, now) {
    /** @type {Map<string, Task>} */
    const tasks = new Map();
    
    // Create a map of persisted task records by name for quick lookup
    const persistedTaskMap = new Map();
    for (const record of persistedTaskRecords) {
        persistedTaskMap.set(record.name, record);
    }
    
    const lastMinute = now.subtract(fromMinutes(1));

    for (const registration of registrations.values()) {
        // Check if there's a persisted task with the same name to preserve timing
        const persistedTask = persistedTaskMap.get(registration.name);
        
        const task = makeTask(
            registration.name,
            registration.parsedCron,
            registration.callback,
            registration.retryDelay,
            // For existing tasks, preserve timing; for new tasks, use lastMinute to prevent immediate execution
            persistedTask?.lastSuccessTime ?? lastMinute,
            persistedTask?.lastFailureTime,
            persistedTask?.lastAttemptTime ?? lastMinute,
            persistedTask?.pendingRetryUntil,
            undefined  // Clear schedulerIdentifier for fresh start
        );
        tasks.set(registration.name, task);
    }

    return tasks;
}

module.exports = {
    mutateTasks,
};