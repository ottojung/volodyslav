/**
 * Core registration validation logic.
 */

const { parseCronExpression } = require("../expression");
const {
    RegistrationsNotArrayError,
    RegistrationShapeError,
    ScheduleInvalidNameError,
    ScheduleDuplicateTaskError,
    InvalidCronExpressionTypeError,
    CronExpressionInvalidError,
    CallbackTypeError,
    RetryDelayTypeError,
    NegativeRetryDelayError,
} = require("./errors");

/** @typedef {import('../types').Registration} Registration */

/**
 * Validates registration input format and content
 * @param {Registration[]} registrations
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @throws {Error} if registrations are invalid
 */
function validateRegistrations(registrations, capabilities) {
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

        if (typeof name !== 'string' || name.trim() === '') {
            throw new ScheduleInvalidNameError(name || '(empty)');
        }

        const qname = JSON.stringify(name);

        // Check for duplicate task names - this is now a hard error
        if (seenNames.has(name)) {
            throw new ScheduleDuplicateTaskError(name);
        }
        seenNames.add(name);

        // Validate name format (helpful for avoiding common mistakes)
        if (name.includes(' ')) {
            capabilities.logger.logWarning(
                { name, index: i },
                `Task name ${qname} contains spaces. Consider using hyphens or underscores instead.`
            );
        }

        if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
            throw new InvalidCronExpressionTypeError(`Registration at index ${i} (${qname}): cronExpression must be a non-empty string, got: ${typeof cronExpression}`, { index: i, name, value: cronExpression });
        }

        // Basic cron expression validation using the cron module
        try {
            parseCronExpression(cronExpression);
        } catch (error) {
            throw new CronExpressionInvalidError(`Registration at index ${i} (${qname}): invalid cron expression '${cronExpression}'`, { index: i, name, value: cronExpression });
        }

        if (typeof callback !== 'function') {
            throw new CallbackTypeError(`Registration at index ${i} (${qname}): callback must be a function, got: ${typeof callback}`, { index: i, name, value: callback });
        }

        if (!retryDelay || typeof retryDelay.toMillis !== 'function') {
            throw new RetryDelayTypeError(`Registration at index ${i} (${qname}): retryDelay must be a Duration object with toMillis() method`, { index: i, name, value: retryDelay });
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