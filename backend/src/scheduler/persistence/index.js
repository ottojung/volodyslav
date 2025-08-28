/**
 * Persistence module.
 * Encapsulates all functionality related to state persistence and task materialization.
 */

const { mutateTasks } = require('./core');
const { materializeTasks, serializeTasks } = require('./materialization');

module.exports = {
    mutateTasks,
    materializeTasks,
    serializeTasks,
};
