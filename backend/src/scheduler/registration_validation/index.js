/**
 * Registration validation module.
 * Encapsulates all functionality related to validating task registrations.
 */

const { validateRegistrations } = require("./core");
const { isScheduleDuplicateTaskError, isSchedulerAlreadyActiveError } = require("./errors");

module.exports = {
    validateRegistrations,
    isScheduleDuplicateTaskError,
    isSchedulerAlreadyActiveError,
};
