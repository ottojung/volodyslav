const { isEnvironmentError } = require("./environment");
const { isNotificationsUnavailable } = require("./notifications");
const { isCommandUnavailable } = require("./subprocess");

module.exports = [isEnvironmentError, isNotificationsUnavailable, isCommandUnavailable];
