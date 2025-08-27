/**
 * Registration validation for scheduler inputs.
 * Validates the structure and content of task registrations.
 */

const { parseCronExpression } = require('../new_cron/parser');
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
} = require('../new_errors');

/**
 * Validates registration input format and content.
 * @param {import('../new_types/task_types').Registration[]} registrations
 * @param {import('../new_types/scheduler_types').Capabilities} capabilities
 * @throws {Error} if registrations are invalid
 */
function validateRegistrations(registrations, capabilities) {
    if (!Array.isArray(registrations)) {
        throw new RegistrationsNotArrayError(`Registrations must be an array, got: ${typeof registrations}`);
    }

    const seenNames = new Set();

    for (let i = 0; i < registrations.length; i++) {
        const registration = registrations[i];

        // Validate registration structure
        if (!Array.isArray(registration) || registration.length !== 4) {
            throw new RegistrationShapeError(
                `Registration at index ${i} must be an array of 4 elements [name, cronExpression, callback, retryDelay], got: ${JSON.stringify(registration)}`, 
                { index: i, value: registration }
            );
        }

        const [name, cronExpression, callback, retryDelay] = registration;

        // Validate task name
        if (typeof name !== 'string' || name.trim() === '') {
            throw new ScheduleInvalidNameError(name);
        }

        const qname = JSON.stringify(name);

        // Check for duplicate task names
        if (seenNames.has(name)) {
            throw new ScheduleDuplicateTaskError(name);
        }
        seenNames.add(name);

        // Validate name format (log warning for spaces)
        if (name.includes(' ')) {
            capabilities.logger.logWarning(
                { name, index: i },
                `Task name ${qname} contains spaces. Consider using hyphens or underscores instead.`
            );
        }

        // Validate cron expression type
        if (typeof cronExpression !== 'string' || cronExpression.trim() === '') {
            throw new InvalidCronExpressionTypeError(
                `Registration at index ${i} (${qname}): cronExpression must be a non-empty string, got: ${typeof cronExpression}`, 
                { index: i, name, value: cronExpression }
            );
        }

        // Validate cron expression syntax
        try {
            parseCronExpression(cronExpression);
        } catch (error) {
            throw new CronExpressionInvalidError(
                `Registration at index ${i} (${qname}): invalid cron expression '${cronExpression}'`, 
                { index: i, name, value: cronExpression, cause: error }
            );
        }

        // Validate callback
        if (typeof callback !== 'function') {
            throw new CallbackTypeError(
                `Registration at index ${i} (${qname}): callback must be a function, got: ${typeof callback}`, 
                { index: i, name, value: callback }
            );
        }

        // Validate retry delay
        if (!retryDelay || typeof retryDelay.toMilliseconds !== 'function') {
            throw new RetryDelayTypeError(
                `Registration at index ${i} (${qname}): retryDelay must be a TimeDuration object with toMilliseconds() method`, 
                { index: i, name, value: retryDelay }
            );
        }

        // Validate retry delay value
        const retryMs = retryDelay.toMilliseconds();
        if (retryMs < 0) {
            throw new NegativeRetryDelayError(
                `Registration at index ${i} (${qname}): retryDelay cannot be negative`, 
                { index: i, name, retryMs }
            );
        }

        // Warn about very large retry delays
        if (retryMs > 24 * 60 * 60 * 1000) { // 24 hours
            capabilities.logger.logWarning(
                { name, retryDelayMs: retryMs, retryDelayHours: Math.round(retryMs / (60 * 60 * 1000)) },
                `Task ${qname} has a very large retry delay of ${retryMs}ms (${Math.round(retryMs / (60 * 60 * 1000))} hours). Consider using a smaller delay.`
            );
        }
    }
}

module.exports = {
    validateRegistrations,
};