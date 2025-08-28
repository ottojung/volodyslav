/**
 * Cron expression parser and validator.
 * This module orchestrates parsing, validation, and calculation for cron expressions.
 */

// Import functions and predicates from sub-modules
const { parseCronExpression, isCronExpression, isInvalidCronExpressionError } = require("./expression");
const { matchesCronExpression, getNextExecution, isCronCalculationError } = require("./calculator");
const { isFieldParseError } = require("./field_parser");

module.exports = {
    // Main functions
    parseCronExpression,
    matchesCronExpression,
    getNextExecution,

    // Type guards  
    isCronExpression,
    isInvalidCronExpressionError,
    isFieldParseError,
    isCronCalculationError,
};
