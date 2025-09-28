/**
 * State initialization and persistence core functionality.
 */

const { fromMinutes } = require("../../datetime");
const { materializeTasks, serializeTasks } = require('./materialization');
const { registrationToTaskIdentity, taskRecordToTaskIdentity, taskIdentitiesEqual } = require("../task/identity");
const { tryDeserialize, isTaskTryDeserializeError } = require("../task");

/** 
 * @typedef {import('../task').Task} Task
 * @typedef {import('../task').AwaitingRetry} AwaitingRetry
 * @typedef {import('../types').ParsedRegistration} ParsedRegistration
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('../types').TaskRecord} TaskRecord
 * @typedef {import('../types').SchedulerCapabilities} SchedulerCapabilities
 * @typedef {import('../types').RuntimeState} RuntimeState
 * @typedef {import('../types').TaskTryDeserializeError} TaskTryDeserializeError
 * @typedef {import('../types').SerializedTask} SerializedTask
 */

/**
 * @template T
 * @typedef {import('../types').Transformation<T>} Transformation
 */

/**
 * @template T
 * @typedef {import('../types').RecordTransformation<T>} RecordTransformation
 */

/**
 * @template T
 * @param {SchedulerCapabilities} capabilities
 * @param {RecordTransformation<T>} transformation
 */
async function mutateTaskRecords(capabilities, transformation) {
    return await capabilities.state.transaction(async (storage) => {
        const currentState = await storage.getCurrentState();
        const taskRecords = currentState.tasks;
        const result = transformation(taskRecords);
        const newState = {
            ...currentState,
            tasks: taskRecords,
        };
        storage.setState(newState);
        capabilities.logger.logDebug({ taskCount: taskRecords.length }, "State persisted");
        return result;
    });
}

/**
 * Persist current scheduler state to disk
 * @template T
 * @param {SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation) {
    return await mutateTaskRecords(capabilities, async (currentTaskRecords) => {

        // Use existing materialization logic for normal operation
        const tasks = materializeTasks(registrations, currentTaskRecords);

        const result = transformation(tasks);

        // Convert tasks to serializable format using Task.serialize()
        const taskRecords = serializeTasks(tasks);

        currentTaskRecords.length = 0; // Clear array in-place
        currentTaskRecords.push(...taskRecords);

        return result;
    });
}

/**
 * Materialize and persist tasks during scheduler initialization.
 * This handles override logic, orphaned task detection, and initial state setup.
 * @param {SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {string} schedulerIdentifier - Current scheduler identifier
 * @returns {Promise<void>}
 */
async function initializeTasks(capabilities, registrations, schedulerIdentifier) {
    return await mutateTaskRecords(capabilities, async (currentTaskRecords) => {
        // Apply clean materialization logic with override and orphaned task handling
        const tasks = materializeTasksWithCleanLogic(registrations, currentTaskRecords, capabilities, schedulerIdentifier);

        // Convert tasks to serializable format
        const taskRecords = serializeTasks(tasks);

        // Update state with new task records while preserving other state fields
        currentTaskRecords.length = 0; // Clear array in-place
        currentTaskRecords.push(...taskRecords);

        capabilities.logger.logDebug({ taskCount: tasks.size }, "Initial state materialized and persisted");
    });
}

/**
 * Materialize tasks using clean per-task logic.
 * Handles orphaned task detection internally and makes individual decisions for each task.
 * @param {ParsedRegistrations} registrations
 * @param {TaskRecord[]} persistedTaskRecords
 * @param {SchedulerCapabilities} capabilities
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

    // Analyze what changes will be made for high-level logging
    const registrationNames = new Set(Array.from(registrations.keys()));
    const persistedNames = new Set(persistedTaskMap.keys());

    const addedTasks = Array.from(registrationNames).filter(name => !persistedNames.has(name));
    const removedTasks = Array.from(persistedNames).filter(name => !registrationNames.has(name));

    // Detect modified tasks (configuration changes)
    const modifiedTasks = [];
    for (const registration of registrations.values()) {
        const persistedTask = persistedTaskMap.get(registration.name);
        if (persistedTask && !removedTasks.includes(registration.name)) {
            const registrationIdentity = registrationToTaskIdentity([
                registration.name,
                registration.parsedCron.original,
                registration.callback,
                registration.retryDelay
            ]);
            const persistedIdentity = taskRecordToTaskIdentity(persistedTask);

            if (!taskIdentitiesEqual(registrationIdentity, persistedIdentity)) {
                // Check which fields differ
                if (registrationIdentity.cronExpression !== persistedIdentity.cronExpression) {
                    modifiedTasks.push({
                        name: registration.name,
                        field: 'cronExpression',
                        from: persistedIdentity.cronExpression,
                        to: registrationIdentity.cronExpression
                    });
                }
                if (registrationIdentity.retryDelayMs !== persistedIdentity.retryDelayMs) {
                    modifiedTasks.push({
                        name: registration.name,
                        field: 'retryDelayMs',
                        from: persistedIdentity.retryDelayMs,
                        to: registrationIdentity.retryDelayMs
                    });
                }
            }
        }
    }

    // Log high-level changes if any exist
    if (addedTasks.length > 0 || removedTasks.length > 0 || modifiedTasks.length > 0) {
        capabilities.logger.logInfo(
            {
                removedTasks,
                addedTasks,
                modifiedTasks,
                totalChanges: addedTasks.length + removedTasks.length + modifiedTasks.length
            },
            "Scheduler state override: registrations differ from persisted state, applying changes"
        );
    }

    const now = capabilities.datetime.now();
    const lastMinute = now.subtract(fromMinutes(1));

    // Track decisions made for logging
    /** @type {{new: Array<{name: string, reason: string}>, preserved: Array<{name: string, reason: string}>, overridden: Array<{name: string, reason: string}>, orphaned: Array<{name: string, reason: string}>}} */
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
            persistedTask,
            registrationIdentity,
            persistedIdentity,
            schedulerIdentifier
        );

        // Create task based on decision
        const task = createTaskFromDecision(decision, registration, registrations, persistedTask, lastMinute);
        if (isTaskTryDeserializeError(task)) {
            throw task;
        }

        tasks.set(registration.name, task);

        // Track decision for logging
        const decisionType = decision.type;
        if (decisionType === 'new') {
            decisions.new.push({
                name: registration.name,
                reason: decision.reason
            });
        } else if (decisionType === 'preserved') {
            decisions.preserved.push({
                name: registration.name,
                reason: decision.reason
            });
        } else if (decisionType === 'overridden') {
            decisions.overridden.push({
                name: registration.name,
                reason: decision.reason
            });
        } else if (decisionType === 'orphaned') {
            decisions.orphaned.push({
                name: registration.name,
                reason: decision.reason
            });
        }
    }

    // Log decisions made
    logMaterializationDecisions(capabilities, decisions, persistedTaskMap, schedulerIdentifier);

    return tasks;
}

/**
 * Decide what action to take for a single task.
 * @param {TaskRecord | undefined} persistedTask
 * @param {{name: string, cronExpression: string, retryDelayMs: number}} registrationIdentity
 * @param {{name: string, cronExpression: string, retryDelayMs: number} | undefined} persistedIdentity
 * @param {string} schedulerIdentifier
 * @returns {{type: 'new' | 'preserved' | 'overridden' | 'orphaned', reason: string}}
 */
function decideTaskAction(persistedTask, registrationIdentity, persistedIdentity, schedulerIdentifier) {
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
    if (!persistedIdentity || !taskIdentitiesEqual(registrationIdentity, persistedIdentity)) {
        return { type: 'overridden', reason: 'config_changed' };
    }

    // Task matches exactly - preserve
    return { type: 'preserved', reason: 'exact_match' };
}

/**
 * Create a task based on the decision made.
 * @param {{type: 'new' | 'preserved' | 'overridden' | 'orphaned', reason: string}} decision
 * @param {ParsedRegistration} registration
 * @param {ParsedRegistrations} registrations
 * @param {TaskRecord | undefined} persistedTask
 * @param {import('../../datetime/structure').DateTime} lastMinute
 * @returns {Task | TaskTryDeserializeError }
 */
function createTaskFromDecision(decision, registration, registrations, persistedTask, lastMinute) {
    /** @type {SerializedTask} */
    let baseTask;
    if (persistedTask === undefined) {
        if (decision.type !== 'new') {
            throw new Error("Non-new task decision requires persisted task data");
        }
        baseTask = {
            name: registration.name,
            cronExpression: registration.parsedCron.original,
            retryDelayMs: registration.retryDelay.toMillis(),
            lastAttemptTime: lastMinute, // Prevent immediate execution
            lastSuccessTime: lastMinute, // Prevent immediate execution
        };
    } else {
        baseTask = {
            ...persistedTask,
            cronExpression: registration.parsedCron.original,
            retryDelayMs: registration.retryDelay.toMillis()
        };
    }

    const task = tryDeserialize(baseTask, registrations);
    if (isTaskTryDeserializeError(task)) {
        return task;
    }

    if (decision.type === 'orphaned') {
        // Create fresh but restart immediately
        /**
         * @type {AwaitingRetry}
         */
        const newState = {
            lastFailureTime: lastMinute,
            pendingRetryUntil: lastMinute,
        };
        task.state = newState;
    }

    return task;
}

/**
 * Log materialization decisions made.
 * @param {SchedulerCapabilities} capabilities
 * @param {{new: Array<{name: string, reason: string}>, preserved: Array<{name: string, reason: string}>, overridden: Array<{name: string, reason: string}>, orphaned: Array<{name: string, reason: string}>}} decisions
 * @param {Map<string, TaskRecord>} persistedTaskMap
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
    initializeTasks,
};