/**
 * Registration validation module.
 * Encapsulates all functionality related to validating task registrations.
 */

const { validateRegistrations } = require("./core");
const { isScheduleDuplicateTaskError } = require("./errors");
const { validateTaskFrequency } = require("./frequency");

module.exports = {
    validateRegistrations,
    isScheduleDuplicateTaskError,
    validateTaskFrequency,
};
