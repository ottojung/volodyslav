const { isEnvironmentError } = require("./environment");
const { isNotificationsUnavailable } = require("./notifications");

module.exports = [isEnvironmentError, isNotificationsUnavailable];
