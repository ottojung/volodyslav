const { isEnvironmentError } = require("./environment");
const { isServerAddressAlreadyInUseError } = require("./express_app");
const { isNotificationsUnavailable } = require("./notifications");
const { isCommandUnavailable } = require("./subprocess");

// Export as array for backward compatibility with gentlewrap
const errorCheckers = [
    isEnvironmentError,
    isNotificationsUnavailable,
    isCommandUnavailable,
    isServerAddressAlreadyInUseError,
];

module.exports = errorCheckers;
