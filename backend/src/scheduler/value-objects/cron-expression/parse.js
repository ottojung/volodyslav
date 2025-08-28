// @ts-check

/**
 * Parse cron expressions and calculate execution times.
 */

const { CronExpressionClass } = require('./class');

/**
 * Parse a cron expression string.
 * @param {string} cronStr - Cron expression string
 * @returns {import('./index').CronExpression}
 */
function parseExpression(cronStr) {
    if (typeof cronStr !== 'string') {
        throw new Error("Cron expression must be a string");
    }

    const parts = cronStr.trim().split(/\s+/);
    if (parts.length !== 5) {
        throw new Error(`Cron expression must have 5 fields, got ${parts.length}: ${cronStr}`);
    }

    const [minuteStr, hourStr, dayStr, monthStr, weekdayStr] = parts;
    
    // These should all be defined since we validated parts.length === 5
    if (!minuteStr || !hourStr || !dayStr || !monthStr || !weekdayStr) {
        throw new Error(`Invalid cron expression parts: ${cronStr}`);
    }

    try {
        const minute = parseField(minuteStr, 0, 59);
        const hour = parseField(hourStr, 0, 23);
        const day = parseField(dayStr, 1, 31);
        const month = parseField(monthStr, 1, 12);
        const weekday = parseField(weekdayStr, 0, 6);

        return new CronExpressionClass(cronStr, minute, hour, day, month, weekday);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid cron expression "${cronStr}": ${message}`);
    }
}

/**
 * Parse a single cron field.
 * @param {string} field - Field value
 * @param {number} min - Minimum allowed value
 * @param {number} max - Maximum allowed value
 * @returns {number[]} Array of valid values
 */
function parseField(field, min, max) {
    if (field === '*') {
        return Array.from({ length: max - min + 1 }, (_, i) => min + i);
    }

    if (field.includes(',')) {
        const values = [];
        for (const part of field.split(',')) {
            values.push(...parseField(part.trim(), min, max));
        }
        return [...new Set(values)].sort((a, b) => a - b);
    }

    if (field.includes('-')) {
        const parts = field.split('-');
        if (parts.length !== 2) {
            throw new Error(`Invalid range format: ${field}`);
        }
        const [start, end] = parts;
        if (!start || !end) {
            throw new Error(`Invalid range format: ${field}`);
        }
        const startNum = parseInt(start, 10);
        const endNum = parseInt(end, 10);
        
        if (isNaN(startNum) || isNaN(endNum)) {
            throw new Error(`Invalid range: ${field}`);
        }
        
        if (startNum < min || endNum > max || startNum > endNum) {
            throw new Error(`Invalid range values: ${field}`);
        }
        
        return Array.from({ length: endNum - startNum + 1 }, (_, i) => startNum + i);
    }

    if (field.includes('/')) {
        const parts = field.split('/');
        if (parts.length !== 2) {
            throw new Error(`Invalid step format: ${field}`);
        }
        const [range, step] = parts;
        if (!range || !step) {
            throw new Error(`Invalid step format: ${field}`);
        }
        const stepNum = parseInt(step, 10);
        
        if (isNaN(stepNum) || stepNum <= 0) {
            throw new Error(`Invalid step: ${field}`);
        }
        
        const rangeValues = parseField(range, min, max);
        return rangeValues.filter((_, index) => index % stepNum === 0);
    }

    const num = parseInt(field, 10);
    if (isNaN(num) || num < min || num > max) {
        throw new Error(`Invalid value: ${field} (must be ${min}-${max})`);
    }
    
    return [num];
}

/**
 * Calculate the next execution time after the given instant.
 * @param {import('./index').CronExpression} cron
 * @param {import('../instant').InstantMs} now
 * @returns {import('../instant').InstantMs}
 */
function calculateNext(cron, now) {
    const { fromEpochMs } = require('../instant');
    
    const startTime = new Date(now.epochMs);
    startTime.setSeconds(0, 0); // Reset seconds and milliseconds
    startTime.setMinutes(startTime.getMinutes() + 1); // Start from next minute

    // Limit iterations to prevent infinite loops
    const maxIterations = 366 * 24 * 60; // One year worth of minutes
    let iterations = 0;

    let testTime = new Date(startTime);

    while (iterations < maxIterations) {
        const minute = testTime.getMinutes();
        const hour = testTime.getHours();
        const day = testTime.getDate();
        const month = testTime.getMonth() + 1; // JS months are 0-based, cron months are 1-based
        const weekday = testTime.getDay(); // Both JS and cron use 0=Sunday

        if (
            cron.minute.includes(minute) &&
            cron.hour.includes(hour) &&
            cron.day.includes(day) &&
            cron.month.includes(month) &&
            cron.weekday.includes(weekday)
        ) {
            return fromEpochMs(testTime.getTime());
        }

        testTime.setMinutes(testTime.getMinutes() + 1);
        iterations++;
    }

    throw new Error(`Could not calculate next execution for cron expression: ${cron.original}`);
}

/**
 * Calculate the minimum interval between executions.
 * @param {import('./index').CronExpression} cron
 * @returns {import('../time-duration').TimeDuration}
 */
function calculateMinInterval(cron) {
    const { fromMs } = require('../time-duration');
    const { fromEpochMs } = require('../instant');
    
    // Test from multiple starting points to find true minimum
    const baseTime = new Date();
    const testBases = [
        baseTime,
        new Date(baseTime.getTime() + 60 * 1000), // +1 minute
        new Date(baseTime.getTime() + 60 * 60 * 1000), // +1 hour
        new Date(baseTime.getTime() + 24 * 60 * 60 * 1000), // +1 day
    ];

    let minInterval = Number.MAX_SAFE_INTEGER;
    const targetSamples = 10; // Analyze multiple consecutive executions

    for (const baseTime of testBases) {
        const baseInstant = fromEpochMs(baseTime.getTime());

        try {
            // Get first execution from this base
            let previousExecution = calculateNext(cron, baseInstant);

            // Check consecutive executions to find true minimum interval
            for (let i = 0; i < targetSamples; i++) {
                const nextExecution = calculateNext(cron, previousExecution);
                const interval = nextExecution.epochMs - previousExecution.epochMs;

                if (interval > 0 && interval < minInterval) {
                    minInterval = interval;
                }

                // Early exit for sub-minute frequencies
                if (minInterval < 60 * 1000) {
                    return fromMs(minInterval);
                }

                previousExecution = nextExecution;
            }
        } catch {
            // Continue with next base if calculation fails
            continue;
        }
    }

    return fromMs(minInterval === Number.MAX_SAFE_INTEGER ? 60 * 1000 : minInterval);
}

module.exports = {
    parseExpression,
    parseField,
    calculateNext,
    calculateMinInterval,
};