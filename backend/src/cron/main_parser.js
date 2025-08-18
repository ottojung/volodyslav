/**
 * Main parser module that orchestrates cron expression parsing.
 */

const { InvalidCronExpressionError, isFieldParseError } = require("./errors");
const { FIELD_CONFIGS, parseField } = require("./field_parser");
const { CronExpressionClass } = require("./expression");

/**
 * Parses and validates a cron expression.
 * @param {string} expression - The cron expression to parse
 * @returns {CronExpressionClass} Parsed cron expression
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

        return new CronExpressionClass(minute, hour, day, month, weekday);
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
};
