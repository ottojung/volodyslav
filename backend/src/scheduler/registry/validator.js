// @ts-check
/**
 * Validation for task registrations.
 */

/**
 * Validate and parse registrations.
 * @param {Array<import('../types').Registration>} registrations
 * @returns {Array<import('../types').ParsedRegistration>}
 * @throws {Error} If any registration is invalid
 */
function validateRegistrations(registrations) {
    if (!Array.isArray(registrations)) {
        throw new Error("Registrations must be an array");
    }

    const parsed = [];
    const seenNames = new Set();

    for (let i = 0; i < registrations.length; i++) {
        try {
            const parsedReg = validateRegistration(registrations[i], i);
            
            // Check for duplicate names
            const { toString } = require('../value-objects/task-id');
            const taskName = toString(parsedReg.name);
            
            if (seenNames.has(taskName)) {
                throw new Error(`Duplicate task name: ${taskName}`);
            }
            
            seenNames.add(taskName);
            parsed.push(parsedReg);
        } catch (error) {
            throw new Error(`Invalid registration at index ${i}: ${error.message}`);
        }
    }

    return parsed;
}

/**
 * Validate a single registration.
 * @param {import('../types').Registration} registration
 * @param {number} index
 * @returns {import('../types').ParsedRegistration}
 */
function validateRegistration(registration, index) {
    if (!Array.isArray(registration) || registration.length !== 4) {
        throw new Error(`Registration must be a 4-element array [name, cron, callback, retryDelay]`);
    }

    const [nameStr, cronStr, callback, retryDelay] = registration;

    // Validate task name
    if (typeof nameStr !== 'string') {
        throw new Error("Task name must be a string");
    }

    const { fromString: taskIdFromString } = require('../value-objects/task-id');
    const name = taskIdFromString(nameStr);

    // Validate cron expression
    if (typeof cronStr !== 'string') {
        throw new Error("Cron expression must be a string");
    }

    const { fromString: cronFromString } = require('../value-objects/cron-expression');
    const cron = cronFromString(cronStr);

    // Validate callback
    if (typeof callback !== 'function') {
        throw new Error("Callback must be a function");
    }

    // Validate retry delay
    if (!retryDelay || (typeof retryDelay.toMs !== 'function' && typeof retryDelay.toMilliseconds !== 'function')) {
        throw new Error("Retry delay must be a TimeDuration object");
    }

    const { MIN_RETRY_DELAY_MS, MAX_RETRY_DELAY_MS } = require('../constants');
    const retryMs = retryDelay.toMs ? retryDelay.toMs() : retryDelay.toMilliseconds();
    
    if (retryMs < MIN_RETRY_DELAY_MS || retryMs > MAX_RETRY_DELAY_MS) {
        throw new Error(`Retry delay must be between ${MIN_RETRY_DELAY_MS}ms and ${MAX_RETRY_DELAY_MS}ms`);
    }

    return {
        name,
        cron,
        callback,
        retryDelay,
    };
}

/**
 * Validate cron frequency against poll interval.
 * @param {import('../types').CronExpression} cron
 * @param {import('../types').PollIntervalMs} pollInterval
 * @param {string} taskName
 * @throws {Error} If cron is too frequent
 */
function validateCronFrequency(cron, pollInterval, taskName) {
    const { FrequencyGuardError } = require('../errors');
    
    const minInterval = cron.minInterval();
    const cronMs = minInterval.toMs();
    const pollMs = pollInterval.toMs();
    
    if (cronMs < pollMs) {
        throw new FrequencyGuardError(taskName, cronMs, pollMs);
    }
}

/**
 * Validate all registrations against poll interval.
 * @param {Array<import('../types').ParsedRegistration>} registrations
 * @param {import('../types').PollIntervalMs} pollInterval
 * @throws {Error} If any cron is too frequent
 */
function validateFrequencies(registrations, pollInterval) {
    for (const registration of registrations) {
        const { toString } = require('../value-objects/task-id');
        const taskName = toString(registration.name);
        validateCronFrequency(registration.cron, pollInterval, taskName);
    }
}

module.exports = {
    validateRegistrations,
    validateRegistration,
    validateCronFrequency,
    validateFrequencies,
};