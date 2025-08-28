/**
 * State persistence and loading for the polling scheduler.
 * Handles saving and restoring task state to/from disk.
 */

const { makeDefault } = require('../runtime_state_storage/structure');
const { serialize, tryDeserialize, isTaskTryDeserializeError } = require('./task');

/**
 * Error thrown when attempting to register a task that is already registered.
 */
class TaskAlreadyRegisteredError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${taskName} is already registered`);
        this.name = "TaskAlreadyRegisteredError";
        this.taskName = taskName;
    }
}

/** 
 * @typedef {import('./task').Task} Task 
 * @typedef {import('./types').Registration} Registration
 * @typedef {import('./types').ParsedRegistration} ParsedRegistration
 * @typedef {import('./types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('../runtime_state_storage/types').TaskRecord} TaskRecord
 */

/**
 * @template T
 * @typedef {import('./types').Transformation<T>} Transformation
 */

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

        if (tasks.has(name)) {
            throw new TaskAlreadyRegisteredError(name);
        }

        const taskOrError = tryDeserialize(record, registrations);
        if (isTaskTryDeserializeError(taskOrError)) {
            throw new Error(`Failed to deserialize task ${name}: ${taskOrError.message}`);
        }

        tasks.set(name, taskOrError);
    }

    return tasks;
}

/**
 * Persist current scheduler state to disk
 * @template T
 * @param {import('../../capabilities/root').Capabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation) {
    return await capabilities.state.transaction(async (storage) => {
        async function getCurrentState() {
            const existingState = await storage.getExistingState();
            if (existingState === null) {
                const ret = makeDefault(capabilities.datetime);

                for (const registration of registrations.values()) {
                    ret.tasks.push({
                        name: registration.name,
                        cronExpression: registration.parsedCron.original,
                        retryDelayMs: registration.retryDelay.toMilliseconds(),
                    });
                }

                return ret;
            } else {
                return existingState;
            }
        }

        const currentState = await getCurrentState();
        const currentTaskRecords = currentState.tasks;
        const tasks = materializeTasks(registrations, currentTaskRecords);
        const result = transformation(tasks);

        // Convert tasks to serializable format using Task.serialize()
        const taskRecords = Array.from(tasks.values()).map((task) => serialize(task));

        // Update state with new task records
        const newState = {
            ...currentState,
            tasks: taskRecords,
        };

        storage.setState(newState);

        capabilities.logger.logDebug({ taskCount: tasks.size }, "State persisted");
        return result;
    });
}

module.exports = {
    mutateTasks,
};
