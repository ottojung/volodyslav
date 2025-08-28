/**
 * Registration validation module.
 * Encapsulates all functionality related to validating task registrations.
 */

const { validateRegistrations } = require("./core");
const { 
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
} = require("./errors");

module.exports = {
    validateRegistrations,
    isScheduleDuplicateTaskError,
    ScheduleInvalidNameError,
};