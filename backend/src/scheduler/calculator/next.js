
const { matchesCronExpression } = require("./current");
const { fromLuxon } = require("../../datetime/structure");
const { Duration } = require("luxon");

/**
 * Custom error class for calculation errors.
 */
class CronCalculationError extends Error {
    /**
     * @param {string} message
     * @param {string} cronExpression
     */
    constructor(message, cronExpression) {
        super(message);
        this.name = "CronCalculationError";
        this.cronExpression = cronExpression;
    }
}

/**
 * @param {unknown} object
 * @returns {object is CronCalculationError}
 */
function isCronCalculationError(object) {
    return object instanceof CronCalculationError;
}

// Pre-create the one-minute duration for performance
const ONE_MINUTE_DURATION = Duration.fromObject({ minutes: 1 });

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} fromDateTime - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, fromDateTime) {
    // Start from the next minute with seconds and milliseconds reset
    // Use the timezone-aware method to preserve the original timezone
    const startDateTime = fromDateTime.startOfNextMinuteForIteration();

    // Extract the Luxon DateTime to use efficient Luxon arithmetic while preserving timezone
    let currentLuxonDateTime = startDateTime._luxonDateTime;

    // Optimize iteration strategy based on cron expression constraints
    const { incrementStrategy, maxIterations } = determineIterationStrategy(cronExpr);
    let iterations = 0;

    while (iterations < maxIterations) {
        // Create DateTime wrapper only when needed for matching
        const currentDateTime = fromLuxon(currentLuxonDateTime);
        
        if (matchesCronExpression(cronExpr, currentDateTime)) {
            return currentDateTime;
        }
        
        // Use optimized increment strategy
        currentLuxonDateTime = incrementStrategy(currentLuxonDateTime, cronExpr, currentDateTime);
        iterations++;
    }

    throw new CronCalculationError(
        "Could not find next execution time within reasonable timeframe",
        `${cronExpr.minute} ${cronExpr.hour} ${cronExpr.day} ${cronExpr.month} ${cronExpr.weekday}`
    );
}

/**
 * Determines the optimal iteration strategy based on cron expression constraints.
 * @param {import('../expression').CronExpression} cronExpr
 * @returns {{incrementStrategy: Function, maxIterations: number}}
 */
function determineIterationStrategy(cronExpr) {
    // Analyze constraint sparsity to choose optimal increment
    const minuteConstraints = cronExpr.minute.length;
    const hourConstraints = cronExpr.hour.length;
    const dayConstraints = cronExpr.day.length;
    const monthConstraints = cronExpr.month.length;
    const weekdayConstraints = cronExpr.weekday.length;
    
    // Only use day-level optimization for very sparse schedules with specific minute and hour constraints
    // This is safe for patterns like "0 0 * * 0" (weekly) or "0 12 1 * *" (monthly)
    if (minuteConstraints <= 2 && hourConstraints <= 2 && 
        (weekdayConstraints <= 2 || dayConstraints <= 3)) {
        return {
            incrementStrategy: smartDayIncrement,
            maxIterations: 400 // Maximum ~400 days for yearly patterns
        };
    }
    
    // For all other cases, use minute increment to ensure correctness
    // This is conservative but ensures we don't skip valid execution times
    return {
        incrementStrategy: minuteIncrement,
        maxIterations: 366 * 24 * 60 // One year worth of minutes (original behavior)
    };
}

/**
 * Increment by minutes for frequent patterns.
 */
function minuteIncrement(luxonDateTime) {
    return luxonDateTime.plus(ONE_MINUTE_DURATION);
}

/**
 * Smart day increment - jumps by days when hour/minute constraints don't match.
 */
function smartDayIncrement(luxonDateTime, cronExpr, currentDateTime) {
    const currentMinute = currentDateTime.minute;
    const currentHour = currentDateTime.hour;
    
    // If current minute and hour match constraints, increment by 1 minute to check next possibility
    if (cronExpr.minute.includes(currentMinute) && cronExpr.hour.includes(currentHour)) {
        return luxonDateTime.plus(ONE_MINUTE_DURATION);
    }
    
    // If hour matches but minute doesn't, jump to next valid minute in same hour
    if (cronExpr.hour.includes(currentHour) && !cronExpr.minute.includes(currentMinute)) {
        const validMinutes = cronExpr.minute.filter(m => m > currentMinute);
        if (validMinutes.length > 0) {
            const nextValidMinute = Math.min(...validMinutes);
            return luxonDateTime.startOf('hour').plus(Duration.fromObject({ minutes: nextValidMinute }));
        }
        // No more valid minutes in this hour, jump to next day
    }
    
    // Jump to next day and set to first valid hour/minute combination
    const nextDay = luxonDateTime.plus(Duration.fromObject({ days: 1 })).startOf('day');
    const firstValidHour = Math.min(...cronExpr.hour);
    const firstValidMinute = Math.min(...cronExpr.minute);
    return nextDay.plus(Duration.fromObject({ 
        hours: firstValidHour, 
        minutes: firstValidMinute 
    }));
}

module.exports = {
    getNextExecution,
    isCronCalculationError,
};
