const { isEnvironmentError } = require("./environment");
const { isServerAddressAlreadyInUseError } = require("./express_app");
const { isNotificationsUnavailable } = require("./notifications");
const { isCommandUnavailable } = require("./subprocess");
const { isTaskListMismatchError } = require("./scheduler");
const { isDailyTasksUnavailable } = require("./jobs");

module.exports = [
    isEnvironmentError,
    isNotificationsUnavailable,
    isCommandUnavailable,
    isServerAddressAlreadyInUseError,
    isTaskListMismatchError,
    isDailyTasksUnavailable,
];
