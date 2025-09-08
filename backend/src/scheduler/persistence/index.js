/**
 * Persistence module.
 * Encapsulates all functionality related to state persistence and task materialization.
 */

const { mutateTasks, materializeAndPersistTasks } = require('./core');
const { materializeTasks, serializeTasks } = require('./materialization');

module.exports = {
    mutateTasks,
    materializeAndPersistTasks,
    materializeTasks,
    serializeTasks,
};
