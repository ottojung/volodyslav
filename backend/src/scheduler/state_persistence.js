/**
 * State persistence and loading for the polling scheduler.
 * This module now serves as a facade to the encapsulated persistence modules.
 */

const { mutateTasks } = require("./persistence");

module.exports = {
    mutateTasks,
};
