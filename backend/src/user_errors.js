const { isEnvironmentError } = require("./environment");
const { isServerAddressAlreadyInUseError } = require("./express_app");
const { isNotificationsUnavailable } = require("./notifications");
const { isCommandUnavailable } = require("./subprocess");
const { isTaskListMismatchError } = require("./scheduler");

module.exports = [
    isEnvironmentError,
    isNotificationsUnavailable,
    isCommandUnavailable,
    isServerAddressAlreadyInUseError,
    isTaskListMismatchError,
];
