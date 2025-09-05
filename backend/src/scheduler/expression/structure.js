/**
 * Cron expression data structure.
 */

const { dateTimeFromObject, weekdayNameToCronNumber } = require("../../datetime");
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
     * @param {boolean} isDomDowRestricted
     */
    constructor(original, minute, hour, day, month, weekday, isDomDowRestricted) {
        if (this.__brand !== undefined) {
            throw new Error("CronExpression is a nominal type");
        }

        this.original = original;
        this.minute = minute;
        this.hour = hour;
        this.day = day;
        this.month = month;
        this.weekday = weekday;
        this.isDomDowRestricted = isDomDowRestricted;
        /** @type {Map<string, number[]>}  */
        this._validDaysCache = new Map();
    }

    /**
     * Gets the valid minutes for the cron expression.
     * @return {number[]} Sorted array of valid minute values
     */
    get validMinutes() {
        if (!this._validMinutes) {
            this._validMinutes = this.minute
                .map((isValid, minute) => (isValid ? minute : -1))
                .filter((minute) => minute !== -1);
        }
        return this._validMinutes;
    }

    /**
     * Gets the valid hours for the cron expression.
     * @return {number[]} Sorted array of valid hour values
     */
    get validHours() {
        if (!this._validHours) {
            this._validHours = this.hour
                .map((isValid, hour) => (isValid ? hour : -1))
                .filter((hour) => hour !== -1);
        }
        return this._validHours;
    }

    /** 
     * @param {number} day
     * @param {import("../../datetime").WeekdayName} weekdayName
     * @returns {boolean}
     */
    isValidDay(day, weekdayName) {
        const weekday = weekdayNameToCronNumber(weekdayName);
        return this.isValidDayAndWeekdayNumbers(day, weekday);
    }

    /** 
     * @param {number} day
     * @param {number} weekday
     * @returns {boolean}
     */
    isValidDayAndWeekdayNumbers(day, weekday) {
        // POSIX DOM/DOW semantics: when both day and weekday are restricted (not wildcards),
        // the job should run if EITHER the day OR the weekday matches
        if (this.isDomDowRestricted) {
            // Both are restricted (not wildcards) - use OR logic
            return this.day[day] === true || this.weekday[weekday] === true;
        } else {
            // At least one is wildcard - use AND logic
            return this.day[day] === true && this.weekday[weekday] === true;
        }
    }

    /**
     * Gets the valid days for the cron expression and for the given year and month.
     * @param {number} year
     * @param {number} month
     * @return {number[]} Sorted array of valid day values
     */
    validDays(year, month) {
        const cacheKey = `${year}-${month}`;
        const existing = this._validDaysCache.get(cacheKey);
        if (existing === undefined) {

            /** @type {() => number[]} */
            const calculateValidDays = () => {
                if (this.month[month] === false) {
                    return [];
                }

                /** @type {number[]} */
                const validDays = [];
                const startWeekdayName = dateTimeFromObject({ year, month, day: 1 }).weekday;
                const startWeekday = weekdayNameToCronNumber(startWeekdayName);
                let weekday = startWeekday;
                let day = 1;
                while (day <= 31) {
                    if (this.isValidDayAndWeekdayNumbers(day, weekday)) {
                        validDays.push(day);
                    }
                    day = day + 1;
                    weekday = 1 + ((weekday + 1) % 7);
                }
                return validDays;
            };

            const validDays = calculateValidDays();
            this._validDaysCache.set(cacheKey, validDays);
            return validDays;
        }
        return existing;
    }

    /**
     * @param {CronExpression} other
     * @returns {boolean}
     */
    equivalent(other) {
        return (
            this.isDomDowRestricted === other.isDomDowRestricted &&
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
        const isDomDowRestricted = dayStr !== "*" && weekdayStr !== "*";

        return new CronExpressionClass(expression, minute, hour, day, month, weekday, isDomDowRestricted);
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
