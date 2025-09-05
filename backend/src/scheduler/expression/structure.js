/**
 * Cron expression data structure.
 */

const { FIELD_CONFIGS, parseField, isFieldParseError } = require("./field_parser");

/**
 * Custom error class for invalid cron expressions.
 */
class InvalidCronExpressionError extends Error {
    /**
     * @param {string} expression
     * @param {string} field
     * @param {string} reason
     */
    constructor(expression, field, reason) {
        super(`Invalid cron expression "${expression}": ${field} field ${reason}`);
        this.name = "InvalidCronExpressionError";
        this.expression = expression;
        this.field = field;
        this.reason = reason;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidCronExpressionError}
 */
function isInvalidCronExpressionError(object) {
    return object instanceof InvalidCronExpressionError;
}

/**
 * Represents a parsed cron expression with validated fields.
 */
class CronExpressionClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {string} original
     * @param {boolean[]} minute
     * @param {boolean[]} hour
     * @param {boolean[]} day
     * @param {boolean[]} month
     * @param {boolean[]} weekday
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
            this.minute.every((v, i) => v === other.minute[i]) &&
            this.hour.every((v, i) => v === other.hour[i]) &&
            this.day.every((v, i) => v === other.day[i]) &&
            this.month.every((v, i) => v === other.month[i]) &&
            this.weekday.every((v, i) => v === other.weekday[i])
        );
    }
}

/**
 * @typedef {CronExpressionClass} CronExpression
 */

/**
 * @param {unknown} object
 * @returns {object is CronExpression}
 */
function isCronExpression(object) {
    return object instanceof CronExpressionClass;
}

/**
 * Parses and validates a cron expression.
 * @param {string} expression - The cron expression to parse
 * @returns {CronExpression} Parsed cron expression
 * @throws {InvalidCronExpressionError} If the expression is invalid
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
        throw new InvalidCronExpressionError(
            expression,
            "expression",
            `must have exactly 5 fields, got ${fields.length}`
        );
    }

    const minuteStr = fields[0];
    const hourStr = fields[1];
    const dayStr = fields[2];
    const monthStr = fields[3];
    const weekdayStr = fields[4];

    if (!minuteStr || !hourStr || !dayStr || !monthStr || !weekdayStr) {
        throw new InvalidCronExpressionError(expression, "expression", "contains empty fields");
    }

    const fieldNames = ["minute", "hour", "day", "month", "weekday"];

    try {
        const minute = parseField(minuteStr, FIELD_CONFIGS.minute);
        const hour = parseField(hourStr, FIELD_CONFIGS.hour);
        const day = parseField(dayStr, FIELD_CONFIGS.day);
        const month = parseField(monthStr, FIELD_CONFIGS.month);
        const weekday = parseField(weekdayStr, FIELD_CONFIGS.weekday);

        return new CronExpressionClass(expression, minute, hour, day, month, weekday);
    } catch (error) {
        const fieldStrings = [minuteStr, hourStr, dayStr, monthStr, weekdayStr];
        const fieldIndex = fieldStrings.findIndex((field, index) => {
            try {
                const configKey = fieldNames[index];
                let config;
                if (configKey === "minute") config = FIELD_CONFIGS.minute;
                else if (configKey === "hour") config = FIELD_CONFIGS.hour;
                else if (configKey === "day") config = FIELD_CONFIGS.day;
                else if (configKey === "month") config = FIELD_CONFIGS.month;
                else if (configKey === "weekday") config = FIELD_CONFIGS.weekday;
                else return false;

                parseField(field, config);
                return false;
            } catch {
                return true;
            }
        });

        const fieldName = fieldNames[fieldIndex] || "unknown";
        let errorMessage = "unknown error";

        if (isFieldParseError(error)) {
            errorMessage = error.message;
        } else if (error instanceof Error) {
            errorMessage = error.message;
        } else {
            errorMessage = String(error);
        }

        throw new InvalidCronExpressionError(expression, fieldName, errorMessage);
    }
}

module.exports = {
    parseCronExpression,
    isCronExpression,
    isInvalidCronExpressionError,
};
