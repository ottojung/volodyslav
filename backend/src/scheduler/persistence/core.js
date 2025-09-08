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
 * @param {Set<string>} [orphanedTaskNames] - Names of tasks that were orphaned and should restart immediately
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation, orphanedTaskNames = new Set()) {
    return await capabilities.state.transaction(async (storage) => {
        const currentState = await getCurrentState(storage, registrations, capabilities.datetime);
        const currentTaskRecords = currentState.tasks;
        
        // Apply per-task logic for materialization/override
        const tasks = materializeTasksWithPerTaskOverride(registrations, currentTaskRecords, capabilities, orphanedTaskNames);
        
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
 * Materialize tasks using per-task logic to decide whether to use persisted state or create fresh.
 * This replaces the binary forceOverride approach with individual task decisions.
 * @param {ParsedRegistrations} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTaskRecords
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {Set<string>} [orphanedTaskNames] - Names of tasks that were orphaned and should restart immediately
 * @returns {Map<string, Task>}
 */
function materializeTasksWithPerTaskOverride(registrations, persistedTaskRecords, capabilities, orphanedTaskNames = new Set()) {
    const { registrationToTaskIdentity, taskRecordToTaskIdentity, taskIdentitiesEqual } = require("../task/identity");
    
    /** @type {Map<string, Task>} */
    const tasks = new Map();
    
    // Create a map of persisted task records by name for quick lookup
    const persistedTaskMap = new Map();
    const persistedIdentityMap = new Map();
    for (const record of persistedTaskRecords) {
        persistedTaskMap.set(record.name, record);
        persistedIdentityMap.set(record.name, taskRecordToTaskIdentity(record));
    }
    
    const now = capabilities.datetime.now();
    const lastMinute = now.subtract(fromMinutes(1));
    
    // Track what decisions we make for logging
    const overriddenTasks = [];
    const preservedTasks = [];
    const newTasks = [];

    for (const registration of registrations.values()) {
        const registrationIdentity = registrationToTaskIdentity([
            registration.name,
            registration.parsedCron.original,
            registration.callback,
            registration.retryDelay
        ]);
        
        const persistedTask = persistedTaskMap.get(registration.name);
        const persistedIdentity = persistedIdentityMap.get(registration.name);
        const isOrphaned = orphanedTaskNames.has(registration.name);
        
        if (!persistedTask) {
            // New task - create fresh
            const task = makeTask(
                registration.name,
                registration.parsedCron,
                registration.callback,
                registration.retryDelay,
                lastMinute,  // Use lastMinute to prevent immediate execution
                undefined,   // No lastFailureTime
                lastMinute,  // Use lastMinute to prevent immediate execution
                undefined,   // No pendingRetryUntil
                undefined    // Clear schedulerIdentifier for fresh start
            );
            tasks.set(registration.name, task);
            newTasks.push(registration.name);
        } else if (isOrphaned || !taskIdentitiesEqual(registrationIdentity, persistedIdentity)) {
            // Task needs override (config changed) or is orphaned - create fresh but preserve timing where appropriate
            const task = makeTask(
                registration.name,
                registration.parsedCron,
                registration.callback,
                registration.retryDelay,
                // For orphaned tasks, clear lastSuccessTime so they restart; for config changes, preserve timing
                isOrphaned ? undefined : persistedTask.lastSuccessTime,
                persistedTask.lastFailureTime,
                // For orphaned tasks, clear lastAttemptTime so they restart; for config changes, preserve timing  
                isOrphaned ? undefined : persistedTask.lastAttemptTime,
                persistedTask.pendingRetryUntil,
                undefined  // Clear schedulerIdentifier for fresh start
            );
            tasks.set(registration.name, task);
            overriddenTasks.push({
                name: registration.name,
                reason: isOrphaned ? 'orphaned' : 'config_changed'
            });
        } else {
            // Task matches exactly - use existing materialization logic
            try {
                const materializedTasks = materializeTasks(
                    new Map([[registration.name, registration]]), 
                    [persistedTask]
                );
                const task = materializedTasks.get(registration.name);
                if (task) {
                    tasks.set(registration.name, task);
                    preservedTasks.push(registration.name);
                }
            } catch (error) {
                // Fall back to creating fresh task if materialization fails
                capabilities.logger.logWarning(
                    { taskName: registration.name, error: error.message },
                    "Failed to materialize persisted task, creating fresh task"
                );
                const task = makeTask(
                    registration.name,
                    registration.parsedCron,
                    registration.callback,
                    registration.retryDelay,
                    persistedTask.lastSuccessTime,
                    persistedTask.lastFailureTime,
                    persistedTask.lastAttemptTime,
                    persistedTask.pendingRetryUntil,
                    undefined  // Clear schedulerIdentifier for fresh start
                );
                tasks.set(registration.name, task);
                overriddenTasks.push({
                    name: registration.name,
                    reason: 'materialization_failed'
                });
            }
        }
    }
    
    // Log the decisions made
    if (overriddenTasks.length > 0) {
        capabilities.logger.logDebug(
            { 
                overriddenTasks: overriddenTasks.map(t => ({ name: t.name, reason: t.reason })),
                count: overriddenTasks.length
            },
            "Tasks overridden with fresh configuration"
        );
    }
    
    if (preservedTasks.length > 0) {
        capabilities.logger.logDebug(
            { preservedTasks, count: preservedTasks.length },
            "Tasks preserved from persisted state"
        );
    }
    
    if (newTasks.length > 0) {
        capabilities.logger.logDebug(
            { newTasks, count: newTasks.length },
            "New tasks created"
        );
    }

    return tasks;
}

module.exports = {
    mutateTasks,
};