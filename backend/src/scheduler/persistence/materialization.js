/**
 * Task materialization functionality.
 * Converts task records from storage into Task objects.
 */

const { serialize, tryDeserialize, isTaskTryDeserializeError } = require('../task');
const { TaskAlreadyRegisteredError } = require('./errors');

/** 
 * @typedef {import('../task').Task} Task 
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('../../runtime_state_storage/types').TaskRecord} TaskRecord
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
 * Serialize tasks into task records for storage.
 * @param {Map<string, Task>} tasks
 * @returns {TaskRecord[]}
 */
function serializeTasks(tasks) {
    return Array.from(tasks.values()).map((task) => serialize(task));
}

module.exports = {
    materializeTasks,
    serializeTasks,
};