/**
 * Cron expression parser and validator.
 * This module orchestrates parsing, validation, and calculation for cron expressions.
 */

// Import functions and predicates from sub-modules
const { parseCronExpression, isCronExpression, isInvalidCronExpressionError } = require("./structure");
const { isFieldParseError } = require("./field_parser");

// Re-export types from sub-modules
/** @typedef {import('./structure').CronExpression} CronExpression */

module.exports = {
    // Main functions
    parseCronExpression,

    // Type guards  
    isCronExpression,
    isInvalidCronExpressionError,
    isFieldParseError,
};
