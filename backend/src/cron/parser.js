/**
 * Cron expression parser and validator.
 * This module orchestrates parsing, validation, and calculation for cron expressions.
 */

// Export everything from sub-modules
const { 
    InvalidCronExpressionError, 
    isInvalidCronExpressionError,
    FieldParseError,
    isFieldParseError,
    CronCalculationError,
    isCronCalculationError
} = require("./errors");

const { CronExpressionClass, isCronExpression } = require("./expression");
const { parseCronExpression } = require("./main_parser");
const { matchesCronExpression, getNextExecution } = require("./calculator");

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
    
    // Error classes
    InvalidCronExpressionError,
    FieldParseError,
    CronCalculationError,
    
    // Data types
    CronExpressionClass,
};
