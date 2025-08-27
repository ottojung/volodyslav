/**
 * Consolidated cron expression parser and calculator.
 * This module provides all cron-related functionality in one place.
 */

const { 
    InvalidCronExpressionError, 
    FieldParseError, 
    CronCalculationError 
} = require('../new_errors');

// Field configurations for cron parsing
const FIELD_CONFIGS = {
    minute: { min: 0, max: 59 },
    hour: { min: 0, max: 23 },
    day: { min: 1, max: 31 },
    month: { min: 1, max: 12 },
    weekday: { min: 0, max: 6 }
};

/**
 * Represents a parsed cron expression with validated fields.
 */
class CronExpressionClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {string} original
     * @param {number[]} minute
     * @param {number[]} hour
     * @param {number[]} day
     * @param {number[]} month
     * @param {number[]} weekday
     */
    constructor(original, minute, hour, day, month, weekday) {
        if (this.__brand !== undefined) {
            throw new Error("CronExpression is a nominal type");
        }

        this.original = original;
        this.minute = minute;
        this.hour = hour;
        this.day = day;
        this.month = month;
        this.weekday = weekday;
    }

    /**
     * @param {CronExpression} other
     * @returns {boolean}
     */
    equivalent(other) {
        return (
            this.minute.length === other.minute.length &&
            this.hour.length === other.hour.length &&
            this.day.length === other.day.length &&
            this.month.length === other.month.length &&
            this.weekday.length === other.weekday.length &&
            this.minute.every((v, i) => v === other.minute[i]) &&
            this.hour.every((v, i) => v === other.hour[i]) &&
            this.day.every((v, i) => v === other.day[i]) &&
            this.month.every((v, i) => v === other.month[i]) &&
            this.weekday.every((v, i) => v === other.weekday[i])
        );
    }
}

/** @typedef {CronExpressionClass} CronExpression */

/**
 * Parse a single cron field value.
 * @param {string} fieldValue - The field value to parse
 * @param {string} fieldName - Name of the field being parsed
 * @returns {number[]} Array of valid numbers for this field
 */
function parseField(fieldValue, fieldName) {
    const config = FIELD_CONFIGS[fieldName];
    if (!config) {
        throw new FieldParseError(`Unknown field: ${fieldName}`, fieldValue, fieldName);
    }

    if (fieldValue === "*") {
        return Array.from({ length: config.max - config.min + 1 }, (_, i) => i + config.min);
    }

    const values = new Set();
    const parts = fieldValue.split(",");

    for (const part of parts) {
        if (part.includes("/")) {
            // Step values
            const [range, step] = part.split("/");
            const stepNum = parseInt(step, 10);
            if (isNaN(stepNum) || stepNum <= 0) {
                throw new FieldParseError(`Invalid step value: ${step}`, fieldValue, fieldName);
            }

            let rangeValues;
            if (range === "*") {
                rangeValues = Array.from({ length: config.max - config.min + 1 }, (_, i) => i + config.min);
            } else if (range.includes("-")) {
                const [start, end] = range.split("-").map(n => parseInt(n, 10));
                if (isNaN(start) || isNaN(end) || start > end) {
                    throw new FieldParseError(`Invalid range: ${range}`, fieldValue, fieldName);
                }
                rangeValues = Array.from({ length: end - start + 1 }, (_, i) => i + start);
            } else {
                const num = parseInt(range, 10);
                if (isNaN(num)) {
                    throw new FieldParseError(`Invalid number: ${range}`, fieldValue, fieldName);
                }
                rangeValues = [num];
            }

            for (let i = 0; i < rangeValues.length; i += stepNum) {
                const value = rangeValues[i];
                if (value >= config.min && value <= config.max) {
                    values.add(value);
                }
            }
        } else if (part.includes("-")) {
            // Range values
            const [start, end] = part.split("-").map(n => parseInt(n, 10));
            if (isNaN(start) || isNaN(end) || start > end) {
                throw new FieldParseError(`Invalid range: ${part}`, fieldValue, fieldName);
            }
            if (start < config.min || end > config.max) {
                throw new FieldParseError(`Range out of bounds: ${part}`, fieldValue, fieldName);
            }
            for (let i = start; i <= end; i++) {
                values.add(i);
            }
        } else {
            // Single value
            const num = parseInt(part, 10);
            if (isNaN(num)) {
                throw new FieldParseError(`Invalid number: ${part}`, fieldValue, fieldName);
            }
            if (num < config.min || num > config.max) {
                throw new FieldParseError(`Number out of bounds: ${num}`, fieldValue, fieldName);
            }
            values.add(num);
        }
    }

    return Array.from(values).sort((a, b) => a - b);
}

/**
 * Parse a cron expression string into a CronExpression object.
 * @param {string} expression - The cron expression to parse
 * @returns {CronExpression} Parsed cron expression
 */
function parseCronExpression(expression) {
    if (typeof expression !== "string") {
        throw new InvalidCronExpressionError(String(expression), "expression", "must be a string");
    }

    const trimmed = expression.trim();
    if (!trimmed) {
        throw new InvalidCronExpressionError(expression, "expression", "cannot be empty");
    }

    const fields = trimmed.split(/\s+/);
    if (fields.length !== 5) {
        throw new InvalidCronExpressionError(expression, "expression", "must have exactly 5 fields");
    }

    try {
        const minute = parseField(fields[0], "minute");
        const hour = parseField(fields[1], "hour");
        const day = parseField(fields[2], "day");
        const month = parseField(fields[3], "month");
        const weekday = parseField(fields[4], "weekday");

        return new CronExpressionClass(expression, minute, hour, day, month, weekday);
    } catch (err) {
        if (err instanceof FieldParseError) {
            throw new InvalidCronExpressionError(expression, err.fieldName, err.message);
        }
        throw err;
    }
}

/**
 * Check if an object is a CronExpression.
 * @param {unknown} object
 * @returns {object is CronExpression}
 */
function isCronExpression(object) {
    return object instanceof CronExpressionClass;
}

/**
 * Check if a date matches a cron expression.
 * @param {CronExpression} cronExpr - Parsed cron expression
 * @param {Date} date - Date to check
 * @returns {boolean} True if the date matches the cron expression
 */
function matchesCronExpression(cronExpr, date) {
    try {
        const minute = date.getMinutes();
        const hour = date.getHours();
        const day = date.getDate();
        const month = date.getMonth() + 1; // JavaScript months are 0-based
        const weekday = date.getDay();

        return (
            cronExpr.minute.includes(minute) &&
            cronExpr.hour.includes(hour) &&
            cronExpr.day.includes(day) &&
            cronExpr.month.includes(month) &&
            cronExpr.weekday.includes(weekday)
        );
    } catch (err) {
        throw new CronCalculationError(`Failed to match cron expression: ${err instanceof Error ? err.message : String(err)}`);
    }
}

/**
 * Get the next execution time for a cron expression after a given date.
 * @param {CronExpression} cronExpr - Parsed cron expression
 * @param {Date} afterDate - Date to find next execution after
 * @returns {Date} Next execution date
 */
function getNextExecution(cronExpr, afterDate) {
    try {
        // Start from the next minute to avoid immediate re-execution
        const startDate = new Date(afterDate.getTime() + 60000);
        startDate.setSeconds(0, 0);

        // Limit search to prevent infinite loops
        const maxIterations = 366 * 24 * 60; // One year of minutes
        let iterations = 0;

        let current = new Date(startDate);

        while (iterations < maxIterations) {
            if (matchesCronExpression(cronExpr, current)) {
                return current;
            }

            // Advance by one minute
            current = new Date(current.getTime() + 60000);
            iterations++;
        }

        throw new CronCalculationError("Could not find next execution within reasonable time frame");
    } catch (err) {
        if (err instanceof CronCalculationError) {
            throw err;
        }
        throw new CronCalculationError(`Failed to calculate next execution: ${err instanceof Error ? err.message : String(err)}`);
    }
}

module.exports = {
    // Factory function
    parseCronExpression,
    
    // Calculation functions  
    matchesCronExpression,
    getNextExecution,
    
    // Type guard
    isCronExpression,
    
    // Error classes (re-exported for convenience)
    InvalidCronExpressionError,
    FieldParseError,
    CronCalculationError,
};