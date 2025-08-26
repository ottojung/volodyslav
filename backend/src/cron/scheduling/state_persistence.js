/**
 * State persistence and loading for the polling scheduler.
 * Handles saving and restoring task state to/from disk.
 */

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
    /** @type {Map<string, Task>} */
    const tasks = new Map();

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
            const name = record.name;

            const registration = registrations.get(name);
            if (registration === undefined) {
                // FIXME: make it a proper error.    
                throw new Error(`Task ${name} is not found`);
            }

            const { parsedCron, callback, retryDelay } = registration;
            const lastSuccessTime = record.lastSuccessTime;
            const lastFailureTime = record.lastFailureTime;
            const lastAttemptTime = record.lastAttemptTime;
            const pendingRetryUntil = record.pendingRetryUntil;
            const lastEvaluatedFire = record.lastEvaluatedFire;

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
            };

            tasks.set(name, task);
            taskCount++;
        }

        capabilities.logger.logInfo({ taskCount }, "Scheduler state loaded");
    });
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

        const lastSuccessTime = record.lastSuccessTime;
        const lastFailureTime = record.lastFailureTime;
        const lastAttemptTime = record.lastAttemptTime;
        const pendingRetryUntil = record.pendingRetryUntil;
        const lastEvaluatedFire = record.lastEvaluatedFire;

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
        };

        tasks.set(name, task);
    }

    return tasks;
}

/**
 * Persist current scheduler state to disk
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
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
                cronExpression: task.parsedCron.unparse(),
                retryDelayMs: task.retryDelay.toMilliseconds(),
                lastSuccessTime: task.lastSuccessTime,
                lastFailureTime: task.lastFailureTime,
                lastAttemptTime: task.lastAttemptTime,
                pendingRetryUntil: task.pendingRetryUntil,
                lastEvaluatedFire: task.lastEvaluatedFire,
            }));

            // Update state with new task records
            const newState = {
                ...currentState,
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
