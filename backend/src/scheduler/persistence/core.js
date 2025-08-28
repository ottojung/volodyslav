/**
 * State initialization and persistence core functionality.
 */

const { makeDefault } = require('../../runtime_state_storage/structure');
const { materializeTasks, serializeTasks } = require('./materialization');

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
    const existingState = await storage.getExistingState();
    if (existingState === null) {
        const ret = makeDefault(datetime);

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
        const currentState = await getCurrentState(storage, registrations, capabilities.datetime);
        const currentTaskRecords = currentState.tasks;
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

module.exports = {
    getCurrentState,
    mutateTasks,
};