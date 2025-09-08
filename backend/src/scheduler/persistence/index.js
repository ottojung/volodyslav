/**
 * Persistence module.
 * Encapsulates all functionality related to state persistence and task materialization.
 */

const { mutateTasks, initializeTasks } = require('./core');
const { materializeTasks, serializeTasks } = require('./materialization');

module.exports = {
    mutateTasks,
    initializeTasks,
    materializeTasks,
    serializeTasks,
};
