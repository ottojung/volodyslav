/**
 * Core registration validation logic.
 */

const { parseCronExpression } = require("../expression");
const {
    RegistrationsNotArrayError,
    RegistrationShapeError,
    ScheduleDuplicateTaskError,
    CronExpressionInvalidError,
    NegativeRetryDelayError,
} = require("./errors");

/** @typedef {import('../types').Registration} Registration */

/**
 * Validates registration input format and content
 * @param {Registration[]} registrations
 * @throws {Error} if registrations are invalid
 */
function validateRegistrations(registrations) {
    if (!Array.isArray(registrations)) {
        throw new RegistrationsNotArrayError("Registrations must be an array");
    }

    const seenNames = new Set();

    for (let i = 0; i < registrations.length; i++) {
        const registration = registrations[i];
        if (!Array.isArray(registration) || registration.length !== 4) {
            throw new RegistrationShapeError(`Registration at index ${i} must be an array of length 4: [name, cronExpression, callback, retryDelay]`, { index: i, registration });
        }

        const [name, cronExpression, callback, retryDelay] = registration;
        
        // Validate task name is a string
        if (typeof name !== 'string') {
            throw new RegistrationShapeError(`Registration at index ${i}: task name must be a string, got: ${typeof name}`, { index: i, name, value: name });
        }
        
        if (callback === undefined || typeof callback !== 'function') {
            throw new RegistrationShapeError(`Registration at index ${i} (${JSON.stringify(name)}): callback must be a function, got: ${typeof callback}`, { index: i, name, value: callback });
        }

        const qname = JSON.stringify(name);

        // Check for duplicate task names - this is now a hard error
        if (seenNames.has(name)) {
            throw new ScheduleDuplicateTaskError(name);
        }
        seenNames.add(name);

        // Basic cron expression validation using the cron module
        try {
            parseCronExpression(cronExpression);
        } catch (error) {
            throw new CronExpressionInvalidError(`Registration at index ${i} (${qname}): invalid cron expression '${cronExpression}'`, { index: i, name, value: cronExpression });
        }

        // Validate retry delay is reasonable (warn for very large delays but don't block)
        const retryMs = retryDelay.toMillis();
        if (retryMs < 0) {
            throw new NegativeRetryDelayError(`Registration at index ${i} (${qname}): retryDelay cannot be negative`, { index: i, name, retryMs });
        }
    }
}

module.exports = {
    validateRegistrations,
};