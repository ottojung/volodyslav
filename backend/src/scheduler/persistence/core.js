/**
 * State initialization and persistence core functionality.
 */

const { fromMinutes } = require("../../datetime");
const { makeDefault } = require('../../runtime_state_storage/structure');
const { materializeTasks, serializeTasks } = require('./materialization');
const { makeTask } = require('../task/structure');
const { registrationToTaskIdentity, taskRecordToTaskIdentity, taskIdentitiesEqual } = require("../task/identity");

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
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation) {
    return await capabilities.state.transaction(async (storage) => {
        const currentState = await getCurrentState(storage, registrations, capabilities.datetime);
        const currentTaskRecords = currentState.tasks;
        
        // Use existing materialization logic for normal operation
        const tasks = materializeTasks(registrations, currentTaskRecords);
        
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
 * Materialize and persist tasks during scheduler initialization.
 * This handles override logic, orphaned task detection, and initial state setup.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {string} schedulerIdentifier - Current scheduler identifier
 * @returns {Promise<void>}
 */
async function materializeAndPersistTasks(capabilities, registrations, schedulerIdentifier) {
    return await capabilities.state.transaction(async (storage) => {
        const currentState = await getCurrentState(storage, registrations, capabilities.datetime);
        const currentTaskRecords = currentState.tasks;
        
        // Apply clean materialization logic with override and orphaned task handling
        const tasks = materializeTasksWithCleanLogic(registrations, currentTaskRecords, capabilities, schedulerIdentifier);
        
        // Convert tasks to serializable format
        const taskRecords = serializeTasks(tasks);

        // Update state with new task records while preserving other state fields
        const newState = {
            ...currentState,
            tasks: taskRecords,
        };

        storage.setState(newState);

        capabilities.logger.logDebug({ taskCount: tasks.size }, "Initial state materialized and persisted");
    });
}

/**
 * Materialize tasks using clean per-task logic.
 * Handles orphaned task detection internally and makes individual decisions for each task.
 * @param {ParsedRegistrations} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTaskRecords
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {string} schedulerIdentifier - Current scheduler identifier for orphaned task detection
 * @returns {Map<string, Task>}
 */
function materializeTasksWithCleanLogic(registrations, persistedTaskRecords, capabilities, schedulerIdentifier) {
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
    
    // Track decisions made for logging
    const decisions = {
        new: [],
        preserved: [],
        overridden: [],
        orphaned: []
    };

    for (const registration of registrations.values()) {
        const registrationIdentity = registrationToTaskIdentity([
            registration.name,
            registration.parsedCron.original,
            registration.callback,
            registration.retryDelay
        ]);
        
        const persistedTask = persistedTaskMap.get(registration.name);
        const persistedIdentity = persistedIdentityMap.get(registration.name);
        
        // Determine task decision
        const decision = decideTaskAction(
            registration,
            persistedTask,
            registrationIdentity,
            persistedIdentity,
            schedulerIdentifier
        );
        
        // Create task based on decision
        const task = createTaskFromDecision(decision, registration, persistedTask, lastMinute);
        tasks.set(registration.name, task);
        
        // Track decision for logging
        decisions[decision.type].push({
            name: registration.name,
            reason: decision.reason
        });
    }
    
    // Log decisions made
    logMaterializationDecisions(capabilities, decisions, persistedTaskMap, schedulerIdentifier);

    return tasks;
}

/**
 * Decide what action to take for a single task.
 * @param {object} registration
 * @param {object} persistedTask
 * @param {object} registrationIdentity
 * @param {object} persistedIdentity
 * @param {string} schedulerIdentifier
 * @returns {{type: string, reason: string}}
 */
function decideTaskAction(registration, persistedTask, registrationIdentity, persistedIdentity, schedulerIdentifier) {
    if (!persistedTask) {
        return { type: 'new', reason: 'no_persisted_state' };
    }
    
    // Check if task is orphaned (from different scheduler)
    const isOrphaned = persistedTask.lastAttemptTime !== undefined && 
                      persistedTask.schedulerIdentifier !== undefined && 
                      persistedTask.schedulerIdentifier !== schedulerIdentifier;
    
    if (isOrphaned) {
        return { type: 'orphaned', reason: 'different_scheduler' };
    }
    
    // Check if configuration changed
    if (!taskIdentitiesEqual(registrationIdentity, persistedIdentity)) {
        return { type: 'overridden', reason: 'config_changed' };
    }
    
    // Task matches exactly - preserve
    return { type: 'preserved', reason: 'exact_match' };
}

/**
 * Create a task based on the decision made.
 * @param {{type: string, reason: string}} decision
 * @param {object} registration
 * @param {object} persistedTask
 * @param {object} lastMinute
 * @returns {Task}
 */
function createTaskFromDecision(decision, registration, persistedTask, lastMinute) {
    if (decision.type === 'new') {
        // New task - create fresh
        return makeTask(
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
    } else if (decision.type === 'orphaned') {
        // Orphaned task - create fresh but restart immediately
        return makeTask(
            registration.name,
            registration.parsedCron,
            registration.callback,
            registration.retryDelay,
            undefined,   // Clear lastSuccessTime so it restarts
            persistedTask.lastFailureTime,
            undefined,   // Clear lastAttemptTime so it restarts
            persistedTask.pendingRetryUntil,
            undefined    // Clear schedulerIdentifier for fresh start
        );
    } else if (decision.type === 'overridden') {
        // Config changed - create fresh but preserve timing
        return makeTask(
            registration.name,
            registration.parsedCron,
            registration.callback,
            registration.retryDelay,
            persistedTask.lastSuccessTime,  // Preserve timing
            persistedTask.lastFailureTime,
            persistedTask.lastAttemptTime,  // Preserve timing
            persistedTask.pendingRetryUntil,
            undefined    // Clear schedulerIdentifier for fresh start
        );
    } else {
        // Preserved task - create task directly from persisted data with current registration
        return makeTask(
            registration.name,
            registration.parsedCron,
            registration.callback,
            registration.retryDelay,
            persistedTask.lastSuccessTime,
            persistedTask.lastFailureTime,
            persistedTask.lastAttemptTime,
            persistedTask.pendingRetryUntil,
            persistedTask.schedulerIdentifier  // Keep the original scheduler identifier
        );
    }
}

/**
 * Log materialization decisions made.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {object} decisions
 * @param {Map<string, object>} persistedTaskMap
 * @param {string} schedulerIdentifier
 */
function logMaterializationDecisions(capabilities, decisions, persistedTaskMap, schedulerIdentifier) {
    if (decisions.overridden.length > 0) {
        capabilities.logger.logDebug(
            { 
                overriddenTasks: decisions.overridden,
                count: decisions.overridden.length
            },
            "Tasks overridden with fresh configuration"
        );
    }
    
    if (decisions.orphaned.length > 0) {
        // Log each orphaned task individually to match expected test format
        for (const orphanedTask of decisions.orphaned) {
            const persistedTask = persistedTaskMap.get(orphanedTask.name);
            capabilities.logger.logWarning(
                {
                    taskName: orphanedTask.name,
                    previousSchedulerIdentifier: persistedTask?.schedulerIdentifier || "unknown",
                    currentSchedulerIdentifier: schedulerIdentifier,
                },
                "Task was interrupted during shutdown and will be restarted"
            );
        }
    }
    
    if (decisions.preserved.length > 0) {
        capabilities.logger.logDebug(
            { 
                preservedTasks: decisions.preserved, 
                count: decisions.preserved.length 
            },
            "Tasks preserved from persisted state"
        );
    }
    
    if (decisions.new.length > 0) {
        capabilities.logger.logDebug(
            { 
                newTasks: decisions.new, 
                count: decisions.new.length 
            },
            "New tasks created"
        );
    }
}

module.exports = {
    mutateTasks,
    materializeAndPersistTasks,
};