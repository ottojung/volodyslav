/**
 * Registration validation module.
 * Encapsulates all functionality related to validating task registrations.
 */

const { validateRegistrations } = require("./core");
const errors = require("./errors");
const { isScheduleDuplicateTaskError, isSchedulerAlreadyActiveError } = errors;

module.exports = {
    validateRegistrations,
    isScheduleDuplicateTaskError,
    isSchedulerAlreadyActiveError,
    errors,
};
