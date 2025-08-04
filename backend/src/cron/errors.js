/**
 * Custom error classes for cron expression parsing.
 */

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
 * Custom error class for field parsing errors.
 */
class FieldParseError extends Error {
    /**
     * @param {string} message
     * @param {string} fieldValue
     * @param {string} fieldName
     */
    constructor(message, fieldValue, fieldName) {
        super(message);
        this.name = "FieldParseError";
        this.fieldValue = fieldValue;
        this.fieldName = fieldName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is FieldParseError}
 */
function isFieldParseError(object) {
    return object instanceof FieldParseError;
}

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

module.exports = {
    InvalidCronExpressionError,
    isInvalidCronExpressionError,
    FieldParseError,
    isFieldParseError,
    CronCalculationError,
    isCronCalculationError,
};
