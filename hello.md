
> backend/src/scheduler/calculator/current.js
```javascript
/**
 * Cron expression matching using boolean mask lookups.
 */

/**
 * Checks if a given datetime matches the cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} dateTime - DateTime to check
 * @returns {boolean} True if the datetime matches the cron expression
 */
function matchesCronExpression(cronExpr, dateTime) {
    // Extract date components
    const month = dateTime.month; // Already 1-based like cron
    const day = dateTime.day;
    const hour = dateTime.hour;
    const minute = dateTime.minute;

    // Check minute, hour, and month constraints (these are always AND)
    return (
        cronExpr.minute[minute] === true &&
        cronExpr.hour[hour] === true &&
        cronExpr.month[month] === true &&
        cronExpr.isValidDay(day, dateTime.weekday)
    );
}

module.exports = {
    matchesCronExpression,
};

```



> backend/src/scheduler/calculator/errors.js
```javascript
/**
 * Error classes for cron calculation failures.
 * These errors are defined close to where they are thrown.
 */

/**
 * Error thrown when no valid execution time can be found for a cron expression.
 * This indicates that the cron expression is incorrect or impossible to satisfy.
 */
class CronCalculationError extends Error {
    /**
     * @param {string} message - Error message
     * @param {object} [details] - Additional error details
     */
    constructor(message, details) {
        super(message);
        this.name = "CronCalculationError";
        this.details = details;
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
    CronCalculationError,
    isCronCalculationError,
};
```



> backend/src/scheduler/calculator/index.js
```javascript
/**
 * Mathematical cron calculator exports.
 * Provides the same API as the previous implementation while using
 * the new O(1) field-based algorithms internally.
 */

const { matchesCronExpression } = require("./current");
const { getNextExecution } = require("./next");
const { getMostRecentExecution } = require("./previous");
const { CronCalculationError, isCronCalculationError } = require("./errors");

module.exports = {
    matchesCronExpression,
    getNextExecution,
    getMostRecentExecution,
    CronCalculationError,
    isCronCalculationError,
};
```



> backend/src/scheduler/calculator/next.js
```javascript
/**
 * Next execution calculation API.
 */

const { dateTimeFromObject } = require('../../datetime');
const { iterateValidDays } = require('../expression');
const { matchesCronExpression } = require('./current');
const { CronCalculationError } = require('./errors');

/**
 * Calculates the next execution time for a cron expression.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} origin - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Next execution datetime
 * @throws {CronCalculationError} If next execution cannot be calculated
 */
function getNextExecution(cronExpr, origin) {
    for (const { year, month, day } of iterateValidDays(cronExpr, origin)) {
        const getTime = () => {
            if (day === origin.day && year === origin.year && month === origin.month) {
                const hour = cronExpr.validHours.filter(h => h >= origin.hour)[0];
                if (hour === undefined) {
                    return null;
                }

                const minute = hour === origin.hour
                    ? cronExpr.validMinutes.filter(m => m > origin.minute)[0]
                    : cronExpr.validMinutes[0];
                if (minute === undefined) {
                    const hour = cronExpr.validHours.filter(h => h > origin.hour)[0];
                    if (hour === undefined) {
                        return null;
                    }
                    const minute = cronExpr.validMinutes[0];
                    if (minute === undefined) {
                        throw new Error("Internal error: no valid minutes in cron expression");
                    }
                    return { hour, minute };
                }

                return { hour, minute };
            } else {
                return { hour: cronExpr.validHours[0], minute: cronExpr.validMinutes[0] };
            }
        };

        const time = getTime();
        if (time === null) {
            continue;
        }

        const { hour, minute } = time;

        const candidate = dateTimeFromObject({
            year,
            month,
            day,
            hour,
            minute,
            second: 0,
            millisecond: 0,
        }, {
            zone: origin.zone ? origin.zone : undefined,
        });

        if (candidate.isValid === false) {
            throw new Error(`Invalid candidate datetime: ${candidate}`);
        }
        if (matchesCronExpression(cronExpr, candidate)) {
            return candidate;
        } else {
            throw new Error("Internal error: candidate does not match cron expression");
        }
    }

    throw new CronCalculationError("No valid next execution time found for cron expression", {
        cronExpression: cronExpr,
        origin: origin
    });
}

module.exports = {
    getNextExecution,
};

```



> backend/src/scheduler/calculator/previous.js
```javascript
/**
 * Previous fire time calculation API.
 */

const { matchesCronExpression } = require("./current");
const { dateTimeFromObject } = require("../../datetime");
const { iterateValidDaysBackwards } = require("../expression");
const { CronCalculationError } = require("./errors");

/**
 * Calculates the previous execution time for a cron expression.
 * Note: it is inclusive. I.e. if `fromDateTime` matches the cron expression,
 * it will be returned as the previous execution time.
 * @param {import('../expression').CronExpression} cronExpr - Parsed cron expression
 * @param {import('../../datetime').DateTime} origin - DateTime to calculate from
 * @returns {import('../../datetime').DateTime} Previous execution datetime, or null if none found
 */
function getMostRecentExecution(cronExpr, origin) {
    for (const { year, month, day } of iterateValidDaysBackwards(cronExpr, origin)) {
        const getTime = () => {
            const validHours = cronExpr.validHours;
            const validMinutes = cronExpr.validMinutes;
            if (day === origin.day && year === origin.year && month === origin.month) {
                const filteredHours = validHours.filter(h => h <= origin.hour);
                const hour = filteredHours[filteredHours.length - 1];
                if (hour === undefined) {
                    return null;
                }

                const filteredMinutes = validMinutes.filter(m => m <= origin.minute);
                const minute = hour === origin.hour
                    ? filteredMinutes[filteredMinutes.length - 1]
                    : validMinutes[validMinutes.length - 1];
                if (minute === undefined) {
                    const filteredHours = validHours.filter(h => h < origin.hour);
                    const hour = filteredHours[filteredHours.length - 1];
                    if (hour === undefined) {
                        return null;
                    }
                    const minute = validMinutes[validMinutes.length - 1];
                    if (minute === undefined) {
                        throw new Error("Internal error: no valid minutes in cron expression");
                    }
                    return { hour, minute };
                }

                return { hour, minute };
            } else {
                const hour = validHours[validHours.length - 1];
                const minute = validMinutes[validMinutes.length - 1];
                return { hour, minute };
            }
        };

        const time = getTime();
        if (time === null) {
            continue;
        }

        const { hour, minute } = time;

        const candidate = dateTimeFromObject({
            year,
            month,
            day,
            hour,
            minute,
            second: 0,
            millisecond: 0,
        }, {
            zone: origin.zone ? origin.zone : undefined,
        });

        if (candidate.isValid === false) {
            throw new Error(`Invalid candidate datetime: ${candidate}`);
        }
        if (matchesCronExpression(cronExpr, candidate)) {
            return candidate;
        } else {
            throw new Error("Internal error: candidate does not match cron expression");
        }
    }

    throw new CronCalculationError("No valid previous execution time found for cron expression", {
        cronExpression: cronExpr,
        origin: origin
    });
}

module.exports = {
    getMostRecentExecution,
};

```



> backend/src/scheduler/execution/collector.js
```javascript
/**
 * Task execution evaluation logic.
 * Determines which tasks should be executed based on cron schedules and retry timing.
 */

const { getMostRecentExecution } = require("../calculator");
const { isRunning } = require("../task");

/** @typedef {import('../types').Callback} Callback */
/** @typedef {import('../task').Running} Running */
/** @typedef {import('../task').AwaitingRetry} AwaitingRetry */
/** @typedef {import('../task').AwaitingRun} AwaitingRun */

/**
 * Error thrown when a task is not found during evaluation for execution.
 */
class TaskEvaluationNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found during evaluation`);
        this.name = "TaskEvaluationNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * Evaluates tasks to determine which ones should be executed.
 * @param {Map<string, import('../task').Task>} tasks - Task map
 * @param {Set<string>} scheduledTasks - Set of scheduled task names
 * @param {import('../../datetime').DateTime} now - Current datetime
 * @param {import('../types').SchedulerCapabilities} capabilities - Capabilities for logging
 * @param {string} schedulerIdentifier - Identifier of the current scheduler instance
 * @returns {{
 *   dueTasks: Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>,
 *   stats: {dueRetry: number, dueCron: number, skippedRunning: number, skippedRetryFuture: number, skippedNotDue: number}
 * }}
 */
function evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities, schedulerIdentifier) {
    let dueRetry = 0;
    let dueCron = 0;
    let skippedRunning = 0;
    let skippedRetryFuture = 0;
    let skippedNotDue = 0;

    // Collect all due tasks for parallel execution
    /** @type {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} */
    const dueTasks = [];

    for (const taskName of scheduledTasks) {
        const task = tasks.get(taskName);
        if (task === undefined) {
            throw new TaskEvaluationNotFoundError(taskName);
        }

        if (isRunning(task)) {
            skippedRunning++;
            capabilities.logger.logDebug({ name: taskName, reason: "running" }, "TaskSkip");
            continue;
        }

        // Check both cron schedule and retry timing
        const lastScheduledFire = getMostRecentExecution(task.parsedCron, now);
        const shouldRunCron = 'lastAttemptTime' in task.state && (task.state.lastAttemptTime === null || task.state.lastAttemptTime.isBefore(lastScheduledFire));
        const shouldRunRetry = 'pendingRetryUntil' in task.state && now.isAfterOrEqual(task.state.pendingRetryUntil);
        const callback = task.callback;

        if (shouldRunRetry) {
            dueTasks.push({ taskName, mode: "retry", callback });
            /** @type {Running} */
            const newState = {
                lastAttemptTime: now,
                schedulerIdentifier: schedulerIdentifier
            };
            task.state = newState;
            dueRetry++;
        } else if (shouldRunCron) {
            dueTasks.push({ taskName, mode: "cron", callback });
            /** @type {Running} */
            const newState = {
                lastAttemptTime: now,
                schedulerIdentifier: schedulerIdentifier
            };
            task.state = newState;
            dueCron++;
        } else if ('pendingRetryUntil' in task.state) {
            skippedRetryFuture++;
            capabilities.logger.logDebug({ name: taskName, reason: "retryNotDue" }, "TaskSkip");
        } else {
            skippedNotDue++;
            capabilities.logger.logDebug({ name: taskName, reason: "notDue" }, "TaskSkip");
        }
    }

    return {
        dueTasks,
        stats: {
            dueRetry,
            dueCron,
            skippedRunning,
            skippedRetryFuture,
            skippedNotDue,
        }
    };
}

module.exports = {
    evaluateTasksForExecution,
};

```



> backend/src/scheduler/execution/executor.js
```javascript
const { difference } = require("../../datetime");
/**
 * Task execution for the polling scheduler.
 * Handles running tasks with proper error handling.
 */

/**
 * Error thrown when a task is not found during task execution.
 */
class TaskExecutionNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found during execution`);
        this.name = "TaskExecutionNotFoundError";
        this.taskName = taskName;
    }
}

/** @typedef {import('../task').Task} Task */
/** @typedef {import('../task').Running} Running */
/** @typedef {import('../task').AwaitingRetry} AwaitingRetry */
/** @typedef {import('../task').AwaitingRun} AwaitingRun */

/**
 * @template T
 * @typedef {import('../types').Transformation<T>} Transformation
 */

/**
 * @typedef {import('../types').Callback} Callback
 */

/**
 * Create a task executor.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {<T>(tr: Transformation<T>) => Promise<T>} mutateTasks
 */
function makeTaskExecutor(capabilities, mutateTasks) {
    const dt = capabilities.datetime;

    /**
     * Execute multiple tasks in parallel.
     * @param {Array<{taskName: string, mode: "retry"|"cron", callback: Callback}>} dueTasks
     * @returns {Promise<void>}
     */
    async function executeTasks(dueTasks) {
        if (dueTasks.length === 0) return;

        // Execute all tasks in parallel
        const promises = dueTasks.map(({ taskName, mode, callback }) => runTask(taskName, mode, callback));
        await Promise.all(promises);
    }

    /**
     * Execute a single task.
     * @param {string} taskName
     * @param {"retry"|"cron"} mode
     * @param {Callback} callback
     */
    async function runTask(taskName, mode, callback) {
        const qname = JSON.stringify(taskName);
        const startTime = dt.now();

        /**
         * @template T
         * @param {(task: Task) => T} transformation
         * @returns {Promise<T>}
         */
        async function mutateThis(transformation) {
            return await mutateTasks((tasks) => {
                const task = tasks.get(taskName);
                if (task === undefined) {
                    throw new TaskExecutionNotFoundError(taskName);
                }
                return transformation(task);
            });
        }

        capabilities.logger.logInfo({ name: taskName, mode }, "TaskRunStarted");

        async function executeIt() {
            try {
                await callback();
                return null;
            } catch (error) {
                if (error instanceof Error) {
                    return error;
                } else {
                    return new Error(`Unknown error: ${error}`);
                }
            }
        }

        const maybeError = await executeIt();
        const end = dt.now();

        if (maybeError === null) {
            await mutateThis((task) => {
                /** @type {AwaitingRun} */
                const newState = {
                    lastAttemptTime: end,
                    lastSuccessTime: end,
                };
                task.state = newState;
            });

            capabilities.logger.logInfo(
                { name: taskName, mode, durationMs: difference(end, startTime).toMillis() },
                `Task ${qname} succeeded`
            );
        } else {
            await mutateThis((task) => {
                const retryAt = end.advance(task.retryDelay);
                /** @type {AwaitingRetry} */
                const newState = {
                    lastFailureTime: end,
                    pendingRetryUntil: retryAt,
                };
                task.state = newState;
            });

            const message = maybeError.message;
            capabilities.logger.logInfo(
                { name: taskName, mode, errorMessage: message },
                `Task ${qname} failed: ${message}`
            );
        }
    }

    return {
        executeTasks,
        runTask,
    };
}

module.exports = {
    makeTaskExecutor,
};

```



> backend/src/scheduler/execution/index.js
```javascript
/**
 * Task execution module.
 * Encapsulates all functionality related to evaluating and executing tasks.
 */

const { evaluateTasksForExecution } = require("./collector");
const { makeTaskExecutor } = require("./executor");

module.exports = {
    makeTaskExecutor,
    evaluateTasksForExecution,
};

```



> backend/src/scheduler/expression/field_parser.js
```javascript
/**
 * Field configuration and parsing for cron expressions.
 */

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
 * @typedef {object} FieldConfig
 * @property {number} min - Minimum allowed value
 * @property {number} max - Maximum allowed value  
 * @property {string} name - Field name for error messages
 */

/**
 * Field configuration for cron expression validation.
 * Enforces POSIX-compliant ranges as defined in IEEE Std 1003.1.
 */
const FIELD_CONFIGS = {
    minute: { min: 0, max: 59, name: "minute" },
    hour: { min: 0, max: 23, name: "hour" },
    day: { min: 1, max: 31, name: "day" },
    month: { min: 1, max: 12, name: "month" },
    // POSIX weekday range: 0-6 (0 = Sunday, 6 = Saturday)
    // Explicitly rejects 7 for Sunday as this is a non-POSIX extension
    weekday: { min: 0, max: 6, name: "weekday" }
};

/**
 * Validates that a field value is POSIX compliant.
 * Rejects non-POSIX extensions like names, macros, and Quartz tokens.
 * @param {string} value - The field value to validate
 * @param {FieldConfig} config - Field configuration
 * @throws {FieldParseError} If the field value contains non-POSIX extensions
 */
function validatePosixCompliance(value, config) {
    // Reject macro syntax (@hourly, @reboot, etc.)
    if (value.startsWith("@")) {
        throw new FieldParseError(`macro syntax not supported (POSIX violation) "${value}"`, value, config.name);
    }
    
    // Reject Quartz tokens (?, L, W, #)
    const quartz_tokens = ["?", "L", "W", "#"];
    for (const token of quartz_tokens) {
        if (value.includes(token)) {
            throw new FieldParseError(`Quartz token '${token}' not supported (POSIX violation) "${value}"`, value, config.name);
        }
    }
    
    // Reject names (mon, jan, etc.) - detect alphabetic characters
    // Allow digits, decimal points, scientific notation, wildcards (*), ranges (-), commas (,), and whitespace
    // This allows parseInt to handle decimal/scientific notation naturally while rejecting named tokens
    const allowedPattern = /^[\d\s,*.\-eE+]+$/;
    if (!allowedPattern.test(value)) {
        throw new FieldParseError(`names not supported, use numbers only (POSIX violation) "${value}"`, value, config.name);
    }
}

/**
 * Parses a single cron field value.
 * @param {string} value - The field value to parse
 * @param {FieldConfig} config - Field configuration
 * @returns {boolean[]} Boolean mask where index indicates if value is valid
 * @throws {FieldParseError} If the field value is invalid
 */
function parseField(value, config) {
    // Create boolean mask with correct length for the field
    const maskLength = config.max + 1; // +1 to include the max value
    
    if (value === "*") {
        const mask = new Array(maskLength).fill(false);
        // Set all valid values to true
        for (let i = config.min; i <= config.max; i++) {
            mask[i] = true;
        }
        return mask;
    }

    if (value.includes(",")) {
        const parts = value.split(",");
        const mask = new Array(maskLength).fill(false);
        
        for (const part of parts) {
            const partMask = parseField(part.trim(), config);
            // Merge the part mask into the main mask
            for (let i = 0; i < partMask.length; i++) {
                if (partMask[i]) {
                    mask[i] = true;
                }
            }
        }
        return mask;
    }

    if (value.includes("/")) {
        throw new FieldParseError(`slash syntax not supported (POSIX violation) "${value}"`, value, config.name);
    }

    // POSIX compliance validation - reject non-POSIX extensions after checking for slashes
    validatePosixCompliance(value, config);

    if (value.includes("-")) {
        const parts = value.split("-");
        if (parts.length !== 2) {
            throw new FieldParseError(`invalid range format "${value}"`, value, config.name);
        }
        const startStr = parts[0];
        const endStr = parts[1];
        if (!startStr || !endStr) {
            throw new FieldParseError(`invalid range format "${value}"`, value, config.name);
        }
        const startNum = parseInt(startStr, 10);
        const endNum = parseInt(endStr, 10);

        if (isNaN(startNum) || isNaN(endNum)) {
            throw new FieldParseError(`invalid range "${value}"`, value, config.name);
        }
        
        // Verify the parsed numbers match the original strings to catch cases like "1e" -> 1 or "1e10" -> 1e10
        // Allow leading zeros by using specific pattern matches
        if (!(/^\d+$/.test(startStr)) || !(/^\d+$/.test(endStr))) {
            throw new FieldParseError(`invalid range format "${value}"`, value, config.name);
        }

        if (startNum < config.min || startNum > config.max) {
            // Special case: provide clear error message for common Sunday=7 mistake
            if (config.name === "weekday" && startNum === 7) {
                throw new FieldParseError(`out of range (${config.min}-${config.max}): Sunday must be 0, not 7 (POSIX compliance)`, value, config.name);
            }
            throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
        }

        if (endNum < config.min || endNum > config.max) {
            // Special case: provide clear error message for common Sunday=7 mistake
            if (config.name === "weekday" && endNum === 7) {
                throw new FieldParseError(`out of range (${config.min}-${config.max}): Sunday must be 0, not 7 (POSIX compliance)`, value, config.name);
            }
            throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
        }

        if (startNum > endNum) {
            throw new FieldParseError(`wrap-around ranges not supported (POSIX violation) "${value}"`, value, config.name);
        }

        const mask = new Array(maskLength).fill(false);
        for (let i = startNum; i <= endNum; i++) {
            mask[i] = true;
        }
        return mask;
    }

    // Check for decimal values which are not valid in cron expressions
    if (value.includes('.')) {
        throw new FieldParseError(`decimal numbers not supported "${value}"`, value, config.name);
    }
    
    const num = parseInt(value, 10);
    if (isNaN(num)) {
        throw new FieldParseError(`invalid number "${value}"`, value, config.name);
    }
    
    // Verify the parsed number matches the original string to catch cases like "1.5" -> 1 or "1e10" -> 1e10
    // Allow leading zeros by using a specific pattern match
    if (!(/^\d+$/.test(value))) {
        throw new FieldParseError(`invalid number format "${value}"`, value, config.name);
    }

    if (num < config.min || num > config.max) {
        // Special case: provide clear error message for common Sunday=7 mistake
        if (config.name === "weekday" && num === 7) {
            throw new FieldParseError(`out of range (${config.min}-${config.max}): Sunday must be 0, not 7 (POSIX compliance)`, value, config.name);
        }
        throw new FieldParseError(`out of range (${config.min}-${config.max})`, value, config.name);
    }

    const mask = new Array(maskLength).fill(false);
    mask[num] = true;
    return mask;
}

module.exports = {
    FIELD_CONFIGS,
    parseField,
    isFieldParseError,
};

```



> backend/src/scheduler/expression/index.js
```javascript
/**
 * Cron expression parser and validator.
 * This module orchestrates parsing, validation, and calculation for cron expressions.
 */

// Import functions and predicates from sub-modules
const { parseCronExpression, isCronExpression, isInvalidCronExpressionError } = require("./structure");
const { iterateValidDays, iterateValidDaysBackwards } = require("./methods");
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

    // Helpers
    iterateValidDays,
    iterateValidDaysBackwards,
};

```



> backend/src/scheduler/expression/methods.js
```javascript

/**
 * @typedef {import("../expression").CronExpression} CronExpression
 */

/**
 * Generator that yields valid (year, month, day) tuples starting from the given date.
 * @param {CronExpression} cronExpr
 * @param {import("../../datetime").DateTime} startDate
 * @returns {Generator<{year: number, month: number, day: number}>} Tuples
 */
function* iterateValidDays(cronExpr, startDate) {
    const origin = startDate;

    const oyear = origin.year;
    const omonth = origin.month;
    let year = origin.year;
    let month = origin.month;

    // Limit to 10 years forward to prevent infinite loops.
    // It must be impossible to have a valid cron expression that doesn't for that long.
    while (year < oyear + 10) {
        let validDays = cronExpr.validDays(year, month);
        if (month === omonth && year === oyear) {
            validDays = validDays.filter(d => d >= origin.day);
        }

        for (const day of validDays) {
            yield { year, month, day };
        }

        month += 1;
        if (month > 12) {
            month = 1;
            year += 1;
        }
    }
}


/**
 * Generator that yields valid (year, month, day) tuples starting from the given date.
 * @param {CronExpression} cronExpr
 * @param {import("../../datetime").DateTime} startDate
 * @returns {Generator<{year: number, month: number, day: number}>} Tuples
 */
function* iterateValidDaysBackwards(cronExpr, startDate) {
    const origin = startDate;

    const oyear = origin.year;
    const omonth = origin.month;
    let year = origin.year;
    let month = origin.month;

    // Limit to 10 years back to prevent infinite loops.
    // It must be impossible to have a valid cron expression that doesn't for that long.
    while (year > oyear - 10) {
        let validDays = cronExpr.validDays(year, month);
        if (month === omonth && year === oyear) {
            validDays = validDays.filter(d => d <= origin.day);
        }

        for (const day of [...validDays].reverse()) {
            yield { year, month, day };
        }

        month -= 1;
        if (month < 1) {
            month = 12;
            year -= 1;
        }
    }
}

module.exports = {
    iterateValidDays,
    iterateValidDaysBackwards,
};

```



> backend/src/scheduler/expression/structure.js
```javascript
/**
 * Cron expression data structure.
 */

const { dateTimeFromObject, weekdayNameToCronNumber, getMaxDaysInMonth } = require("../../datetime");
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
                const max_days = getMaxDaysInMonth(year, month);
                let weekday = startWeekday;
                let day = 1;
                while (day <= max_days) {
                    if (this.isValidDayAndWeekdayNumbers(day, weekday)) {
                        validDays.push(day);
                    }
                    day = day + 1;
                    weekday = (weekday + 1) % 7;
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

const FIRST_COMING = dateTimeFromObject({ year: 1, month: 1, day: 1, hour: 0, minute: 0 });

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

    // POSIX compliance: reject macro syntax at expression level
    if (trimmed.startsWith("@")) {
        throw new InvalidCronExpressionError(expression, "expression", "macro syntax not supported (POSIX violation)");
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

    const fieldNames = ["minute", "hour", "day", "month", "weekday"];

    function basicParse() {
        if (!minuteStr || !hourStr || !dayStr || !monthStr || !weekdayStr) {
            throw new InvalidCronExpressionError(expression, "expression", "contains empty fields");
        }

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

    const ret = basicParse();
    const { getNextExecution } = require("../calculator");
    try {
        getNextExecution(ret, FIRST_COMING); // validate it can compute next execution
    } catch (error) {
        const innerMessage = error instanceof Error ? error.message : String(error);
        const message = `no valid execution times: ${innerMessage}`;
        throw new InvalidCronExpressionError(expression, "expression", message);
    }

    return ret;
}

module.exports = {
    parseCronExpression,
    isCronExpression,
    isInvalidCronExpressionError,
};

```



> backend/src/scheduler/index.js
```javascript
/**
 * Declarative scheduler module exports.
 * This module provides a static, idempotent scheduler that validates tasks
 * against persisted runtime state.
 * 
 * The scheduler uses a purely declarative interface - no procedural APIs
 * like start, stop, schedule, or cancel are exposed to external consumers.
 */

const { make } = require("./make");
const { isScheduleDuplicateTaskError } = require("./registration_validation");
const { isTaskListMismatchError } = require("./state_validation");
const { isCronExpression, isInvalidCronExpressionError } = require('./expression')

// Re-export types for external consumption
/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').TaskIdentity} TaskIdentity */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */

module.exports = {
    make,
    isTaskListMismatchError,
    isScheduleDuplicateTaskError,
    isCronExpression,
    isInvalidCronExpressionError,
};

```



> backend/src/scheduler/make.js
```javascript
/**
 * Scheduler factory implementation for the declarative scheduler.
 */

const { parseCronExpression } = require("./expression");
const { makePollingScheduler } = require("./polling");
const { initializeTasks } = require("./persistence");
const { isScheduleDuplicateTaskError, validateRegistrations } = require("./registration_validation");
const { generateSchedulerIdentifier } = require("./scheduler_identifier");
const memconst = require("../memconst");

/**
 * Error for task scheduling failures.
 */
class ScheduleTaskError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "ScheduleTaskError";
        this.details = details;
    }
}

/**
 * Error for scheduler stop failures.
 */
class StopSchedulerError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "StopSchedulerError";
        this.details = details;
    }
}

/** @typedef {import('./types').Scheduler} Scheduler */
/** @typedef {import('./types').Registration} Registration */
/** @typedef {import('./types').Initialize} Initialize */
/** @typedef {import('./types').Stop} Stop */
/** @typedef {import('./types').SchedulerCapabilities} SchedulerCapabilities */
/** @typedef {import('./types').ParsedRegistrations} ParsedRegistrations */

/**
 * Initialize the scheduler with the given registrations.
 * 
 * @param {() => SchedulerCapabilities} getCapabilities
 * @returns {Scheduler}
 * @throws {Error} if registrations are invalid or capabilities are malformed
 */
function make(getCapabilities) {
    /** @type {ReturnType<makePollingScheduler> | null} */
    let pollingScheduler = null;

    /** @type {string | null} */
    let schedulerIdentifier = null;

    const getCapabilitiesMemo = memconst(getCapabilities);

    /**
     * Parse registrations into internal format.
     * @param {Registration[]} registrations
     * @returns {ParsedRegistrations}
     */
    function parseRegistrations(registrations) {
        /** @type {ParsedRegistrations} */
        const parsedRegistrations = new Map();
        registrations.forEach(([name, cronExpression, callback, retryDelay]) =>
            parsedRegistrations.set(name, {
                name,
                parsedCron: parseCronExpression(cronExpression),
                callback,
                retryDelay
            }));
        return parsedRegistrations;
    }

    /**
     * Schedule all tasks and handle errors.
     * @param {Registration[]} registrations
     * @param {ReturnType<makePollingScheduler>} pollingScheduler
     * @param {SchedulerCapabilities} capabilities
     * @returns {Promise<{scheduledCount: number, skippedCount: number}>}
     */
    async function scheduleAllTasks(registrations, pollingScheduler, capabilities) {
        let scheduledCount = 0;
        let skippedCount = 0;

        for (const [name, cronExpression, , retryDelay] of registrations) {
            try {
                await pollingScheduler.schedule(name);
                scheduledCount++;
                capabilities.logger.logDebug(
                    {
                        taskName: name,
                        cronExpression,
                        retryDelayMs: retryDelay.toMillis()
                    },
                    "Task scheduled successfully"
                );
            } catch (error) {
                // If the task is already scheduled with a callback, that's fine for idempotency
                if (isScheduleDuplicateTaskError(error)) {
                    skippedCount++;
                    capabilities.logger.logDebug(
                        { taskName: name },
                        "Task already scheduled - scheduler already initialized"
                    );
                } else {
                    // Enhanced error context for debugging
                    const errorObj = error instanceof Error ? error : new Error(String(error));
                    throw new ScheduleTaskError(`Failed to schedule task '${name}': ${errorObj.message}`, { name, cronExpression, cause: errorObj });
                }
            }
        }

        return { scheduledCount, skippedCount };
    }

    /**
     * Initialize the scheduler with the given registrations.
     * @type {Initialize}
     */
    async function initialize(registrations) {
        const capabilities = getCapabilitiesMemo();
        
        // Validate registrations before any processing
        validateRegistrations(registrations);
        
        const parsedRegistrations = parseRegistrations(registrations);

        // Generate scheduler identifier if not already done
        if (schedulerIdentifier === null) {
            schedulerIdentifier = generateSchedulerIdentifier(capabilities);
            capabilities.logger.logDebug(
                { schedulerIdentifier },
                "Generated scheduler identifier"
            );
        }

        // Check for existing polling scheduler
        if (pollingScheduler !== null) {
            // Scheduler already running - need to update with new registrations
            capabilities.logger.logDebug(
                {},
                "Scheduler already initialized, stopping current scheduler and recreating with new registrations"
            );
            
            // Stop the existing scheduler
            await pollingScheduler.stopLoop();
            pollingScheduler = null;
            
            // Create new polling scheduler with updated registrations
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);
            
            // Apply materialization logic to detect and log changes, and update persisted state
            await initializeTasks(capabilities, parsedRegistrations, schedulerIdentifier);
            
            // Schedule all tasks (including newly added ones)
            const { scheduledCount, skippedCount } = await scheduleAllTasks(registrations, pollingScheduler, capabilities);
            
            capabilities.logger.logDebug(
                {
                    totalRegistrations: registrations.length,
                    scheduledCount,
                    skippedCount
                },
                "Scheduler reinitialization completed"
            );
            return;
        } else {
            pollingScheduler = makePollingScheduler(capabilities, parsedRegistrations, schedulerIdentifier);
        }

        // Create polling scheduler
        capabilities.logger.logDebug(
            {},
            "Creating new polling scheduler"
        );

        // Apply clean materialization logic (handles persisted state, logging, and orphaned tasks internally)
        await initializeTasks(capabilities, parsedRegistrations, schedulerIdentifier);

        // Schedule all tasks
        const { scheduledCount, skippedCount } = await scheduleAllTasks(registrations, pollingScheduler, capabilities);

        capabilities.logger.logDebug(
            {
                totalRegistrations: registrations.length,
                scheduledCount,
                skippedCount
            },
            "Scheduler initialization completed"
        );
    }

    /**
     * Stop the scheduler gracefully with enhanced error handling and logging.
     * @type {Stop}
     */
    async function stop() {
        const capabilities = getCapabilitiesMemo();
        if (pollingScheduler !== null) {
            try {
                capabilities.logger.logInfo(
                    {},
                    "Stopping scheduler gracefully"
                );

                await pollingScheduler.stopLoop();
                pollingScheduler = null;

                capabilities.logger.logInfo({}, "Scheduler stopped successfully");
            } catch (err) {
                const error = err instanceof Error ? err : new Error(String(err));
                // Still clean up state even if stop failed
                pollingScheduler = null;
                throw new StopSchedulerError(`Failed to stop scheduler: ${error.message}`, { cause: error });
            }
        } else {
            capabilities.logger.logDebug({}, "Scheduler already stopped or not initialized");
        }
    }

    return {
        initialize,
        stop,
    };
}

module.exports = {
    make,
};
```



> backend/src/scheduler/persistence/core.js
```javascript
/**
 * State initialization and persistence core functionality.
 */

const { fromMinutes } = require("../../datetime");
const { materializeTasks, serializeTasks } = require('./materialization');
const { registrationToTaskIdentity, taskRecordToTaskIdentity, taskIdentitiesEqual } = require("../task/identity");
const { tryDeserialize, isTaskTryDeserializeError } = require("../task");

/** 
 * @typedef {import('../task').Task} Task
 * @typedef {import('../task').AwaitingRetry} AwaitingRetry
 * @typedef {import('../types').ParsedRegistration} ParsedRegistration
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('../types').TaskRecord} TaskRecord
 * @typedef {import('../types').SchedulerCapabilities} SchedulerCapabilities
 * @typedef {import('../types').RuntimeState} RuntimeState
 * @typedef {import('../types').TaskTryDeserializeError} TaskTryDeserializeError
 */

/**
 * @template T
 * @typedef {import('../types').Transformation<T>} Transformation
 */

/**
 * @template T
 * @typedef {import('../types').RecordTransformation<T>} RecordTransformation
 */

/**
 * @template T
 * @param {SchedulerCapabilities} capabilities
 * @param {RecordTransformation<T>} transformation
 */
async function mutateTaskRecords(capabilities, transformation) {
    return await capabilities.state.transaction(async (storage) => {
        const currentState = await storage.getCurrentState();
        const taskRecords = currentState.tasks;
        const result = transformation(taskRecords);
        const newState = {
            ...currentState,
            tasks: taskRecords,
        };
        storage.setState(newState);
        capabilities.logger.logDebug({ taskCount: taskRecords.length }, "State persisted");
        return result;
    });
}

/**
 * Persist current scheduler state to disk
 * @template T
 * @param {SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {Transformation<T>} transformation
 * @returns {Promise<T>}
 */
async function mutateTasks(capabilities, registrations, transformation) {
    return await mutateTaskRecords(capabilities, async (currentTaskRecords) => {

        // Use existing materialization logic for normal operation
        const tasks = materializeTasks(registrations, currentTaskRecords);

        const result = transformation(tasks);

        // Convert tasks to serializable format using Task.serialize()
        const taskRecords = serializeTasks(tasks);

        currentTaskRecords.length = 0; // Clear array in-place
        currentTaskRecords.push(...taskRecords);

        return result;
    });
}

/**
 * Materialize and persist tasks during scheduler initialization.
 * This handles override logic, orphaned task detection, and initial state setup.
 * @param {SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {string} schedulerIdentifier - Current scheduler identifier
 * @returns {Promise<void>}
 */
async function initializeTasks(capabilities, registrations, schedulerIdentifier) {
    return await mutateTaskRecords(capabilities, async (currentTaskRecords) => {
        // Apply clean materialization logic with override and orphaned task handling
        const tasks = materializeTasksWithCleanLogic(registrations, currentTaskRecords, capabilities, schedulerIdentifier);

        // Convert tasks to serializable format
        const taskRecords = serializeTasks(tasks);

        // Update state with new task records while preserving other state fields
        currentTaskRecords.length = 0; // Clear array in-place
        currentTaskRecords.push(...taskRecords);

        capabilities.logger.logDebug({ taskCount: tasks.size }, "Initial state materialized and persisted");
    });
}

/**
 * Materialize tasks using clean per-task logic.
 * Handles orphaned task detection internally and makes individual decisions for each task.
 * @param {ParsedRegistrations} registrations
 * @param {TaskRecord[]} persistedTaskRecords
 * @param {SchedulerCapabilities} capabilities
 * @param {string} schedulerIdentifier - Current scheduler identifier for orphaned task detection
 * @returns {Map<string, Task>}
 */
function materializeTasksWithCleanLogic(registrations, persistedTaskRecords, capabilities, schedulerIdentifier) {
    /** @type {Map<string, Task>} */
    const tasks = new Map();

    // Create a map of persisted task records by name for quick lookup
    const persistedTaskMap = new Map();
    const persistedIdentityMap = new Map();
    for (const record of persistedTaskRecords) {
        persistedTaskMap.set(record.name, record);
        persistedIdentityMap.set(record.name, taskRecordToTaskIdentity(record));
    }

    // Analyze what changes will be made for high-level logging
    const registrationNames = new Set(Array.from(registrations.keys()));
    const persistedNames = new Set(persistedTaskMap.keys());

    const addedTasks = Array.from(registrationNames).filter(name => !persistedNames.has(name));
    const removedTasks = Array.from(persistedNames).filter(name => !registrationNames.has(name));

    // Detect modified tasks (configuration changes)
    const modifiedTasks = [];
    for (const registration of registrations.values()) {
        const persistedTask = persistedTaskMap.get(registration.name);
        if (persistedTask && !removedTasks.includes(registration.name)) {
            const registrationIdentity = registrationToTaskIdentity([
                registration.name,
                registration.parsedCron.original,
                registration.callback,
                registration.retryDelay
            ]);
            const persistedIdentity = taskRecordToTaskIdentity(persistedTask);

            if (!taskIdentitiesEqual(registrationIdentity, persistedIdentity)) {
                // Check which fields differ
                if (registrationIdentity.cronExpression !== persistedIdentity.cronExpression) {
                    modifiedTasks.push({
                        name: registration.name,
                        field: 'cronExpression',
                        from: persistedIdentity.cronExpression,
                        to: registrationIdentity.cronExpression
                    });
                }
                if (registrationIdentity.retryDelayMs !== persistedIdentity.retryDelayMs) {
                    modifiedTasks.push({
                        name: registration.name,
                        field: 'retryDelayMs',
                        from: persistedIdentity.retryDelayMs,
                        to: registrationIdentity.retryDelayMs
                    });
                }
            }
        }
    }

    // Log high-level changes if any exist
    if (addedTasks.length > 0 || removedTasks.length > 0 || modifiedTasks.length > 0) {
        capabilities.logger.logInfo(
            {
                removedTasks,
                addedTasks,
                modifiedTasks,
                totalChanges: addedTasks.length + removedTasks.length + modifiedTasks.length
            },
            "Scheduler state override: registrations differ from persisted state, applying changes"
        );
    }

    const now = capabilities.datetime.now();
    const lastMinute = now.subtract(fromMinutes(1));

    // Track decisions made for logging
    /** @type {{new: Array<{name: string, reason: string}>, preserved: Array<{name: string, reason: string}>, overridden: Array<{name: string, reason: string}>, orphaned: Array<{name: string, reason: string}>}} */
    const decisions = {
        new: [],
        preserved: [],
        overridden: [],
        orphaned: []
    };

    for (const registration of registrations.values()) {
        const registrationIdentity = registrationToTaskIdentity([
            registration.name,
            registration.parsedCron.original,
            registration.callback,
            registration.retryDelay
        ]);

        const persistedTask = persistedTaskMap.get(registration.name);
        const persistedIdentity = persistedIdentityMap.get(registration.name);

        // Determine task decision
        const decision = decideTaskAction(
            persistedTask,
            registrationIdentity,
            persistedIdentity,
            schedulerIdentifier
        );

        // Create task based on decision
        const task = createTaskFromDecision(decision, registration, registrations, persistedTask, lastMinute);
        if (isTaskTryDeserializeError(task)) {
            throw task;
        }

        tasks.set(registration.name, task);

        // Track decision for logging
        const decisionType = decision.type;
        if (decisionType === 'new') {
            decisions.new.push({
                name: registration.name,
                reason: decision.reason
            });
        } else if (decisionType === 'preserved') {
            decisions.preserved.push({
                name: registration.name,
                reason: decision.reason
            });
        } else if (decisionType === 'overridden') {
            decisions.overridden.push({
                name: registration.name,
                reason: decision.reason
            });
        } else if (decisionType === 'orphaned') {
            decisions.orphaned.push({
                name: registration.name,
                reason: decision.reason
            });
        }
    }

    // Log decisions made
    logMaterializationDecisions(capabilities, decisions, persistedTaskMap, schedulerIdentifier);

    return tasks;
}

/**
 * Decide what action to take for a single task.
 * @param {TaskRecord | undefined} persistedTask
 * @param {{name: string, cronExpression: string, retryDelayMs: number}} registrationIdentity
 * @param {{name: string, cronExpression: string, retryDelayMs: number} | undefined} persistedIdentity
 * @param {string} schedulerIdentifier
 * @returns {{type: 'new' | 'preserved' | 'overridden' | 'orphaned', reason: string}}
 */
function decideTaskAction(persistedTask, registrationIdentity, persistedIdentity, schedulerIdentifier) {
    if (!persistedTask) {
        return { type: 'new', reason: 'no_persisted_state' };
    }

    // Check if task is orphaned (from different scheduler)
    const isOrphaned = persistedTask.lastAttemptTime !== undefined &&
        persistedTask.schedulerIdentifier !== undefined &&
        persistedTask.schedulerIdentifier !== schedulerIdentifier;

    if (isOrphaned) {
        return { type: 'orphaned', reason: 'different_scheduler' };
    }

    // Check if configuration changed
    if (!persistedIdentity || !taskIdentitiesEqual(registrationIdentity, persistedIdentity)) {
        return { type: 'overridden', reason: 'config_changed' };
    }

    // Task matches exactly - preserve
    return { type: 'preserved', reason: 'exact_match' };
}

/**
 * Create a task based on the decision made.
 * @param {{type: 'new' | 'preserved' | 'overridden' | 'orphaned', reason: string}} decision
 * @param {ParsedRegistration} registration
 * @param {ParsedRegistrations} registrations
 * @param {TaskRecord | undefined} persistedTask
 * @param {import('../../datetime/structure').DateTime} lastMinute
 * @returns {Task | TaskTryDeserializeError }
 */
function createTaskFromDecision(decision, registration, registrations, persistedTask, lastMinute) {
    if (persistedTask === undefined) {
        if (decision.type !== 'new') {
            throw new Error("Non-new task decision requires persisted task data");
        }
        persistedTask = {
            name: registration.name,
            cronExpression: registration.parsedCron.original,
            retryDelayMs: registration.retryDelay.toMillis(),
            lastAttemptTime: lastMinute, // Prevent immediate execution
            lastSuccessTime: lastMinute, // Prevent immediate execution
        };
    }

    const task = tryDeserialize(persistedTask, registrations);
    if (isTaskTryDeserializeError(task)) {
        return task;
    }

    if (decision.type === 'orphaned') {
        // Create fresh but restart immediately
        /**
         * @type {AwaitingRetry}
         */
        const newState = {
            lastFailureTime: lastMinute,
            pendingRetryUntil: lastMinute,
        };
        task.state = newState;
    }

    return task;
}

/**
 * Log materialization decisions made.
 * @param {SchedulerCapabilities} capabilities
 * @param {{new: Array<{name: string, reason: string}>, preserved: Array<{name: string, reason: string}>, overridden: Array<{name: string, reason: string}>, orphaned: Array<{name: string, reason: string}>}} decisions
 * @param {Map<string, TaskRecord>} persistedTaskMap
 * @param {string} schedulerIdentifier
 */
function logMaterializationDecisions(capabilities, decisions, persistedTaskMap, schedulerIdentifier) {
    if (decisions.overridden.length > 0) {
        capabilities.logger.logDebug(
            {
                overriddenTasks: decisions.overridden,
                count: decisions.overridden.length
            },
            "Tasks overridden with fresh configuration"
        );
    }

    if (decisions.orphaned.length > 0) {
        // Log each orphaned task individually to match expected test format
        for (const orphanedTask of decisions.orphaned) {
            const persistedTask = persistedTaskMap.get(orphanedTask.name);
            capabilities.logger.logWarning(
                {
                    taskName: orphanedTask.name,
                    previousSchedulerIdentifier: persistedTask?.schedulerIdentifier || "unknown",
                    currentSchedulerIdentifier: schedulerIdentifier,
                },
                "Task was interrupted during shutdown and will be restarted"
            );
        }
    }

    if (decisions.preserved.length > 0) {
        capabilities.logger.logDebug(
            {
                preservedTasks: decisions.preserved,
                count: decisions.preserved.length
            },
            "Tasks preserved from persisted state"
        );
    }

    if (decisions.new.length > 0) {
        capabilities.logger.logDebug(
            {
                newTasks: decisions.new,
                count: decisions.new.length
            },
            "New tasks created"
        );
    }
}

module.exports = {
    mutateTasks,
    initializeTasks,
};
```



> backend/src/scheduler/persistence/index.js
```javascript
/**
 * Persistence module.
 * Encapsulates all functionality related to state persistence and task materialization.
 */

const { mutateTasks, initializeTasks } = require('./core');
const { materializeTasks, serializeTasks } = require('./materialization');

module.exports = {
    mutateTasks,
    initializeTasks,
    materializeTasks,
    serializeTasks,
};

```



> backend/src/scheduler/persistence/materialization.js
```javascript
/**
 * Task materialization functionality.
 * Converts task records from storage into Task objects.
 */

const { serialize, tryDeserialize, isTaskTryDeserializeError } = require('../task');

/** 
 * @typedef {import('../task').Task} Task 
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 * @typedef {import('../../runtime_state_storage/types').TaskRecord} TaskRecord
 */

/**
 * Error thrown when attempting to register a task that is already registered.
 */
class TaskAlreadyRegisteredError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${taskName} is already registered`);
        this.name = "TaskAlreadyRegisteredError";
        this.taskName = taskName;
    }
}

/**
 * Materialize task records into Task objects.
 * @param {ParsedRegistrations} registrations
 * @param {TaskRecord[]} taskRecords
 * @returns {Map<string, Task>}
 */
function materializeTasks(registrations, taskRecords) {
    /** @type {Map<string, Task>} */
    const tasks = new Map();

    for (const record of taskRecords) {
        const name = record.name;

        if (tasks.has(name)) {
            throw new TaskAlreadyRegisteredError(name);
        }

        if (!registrations.has(name)) {
            // Skip tasks not in current registrations
            continue;
        }

        const taskOrError = tryDeserialize(record, registrations);
        if (isTaskTryDeserializeError(taskOrError)) {
            throw taskOrError;
        }

        tasks.set(name, taskOrError);
    }

    return tasks;
}

/**
 * Serialize tasks into task records for storage.
 * @param {Map<string, Task>} tasks
 * @returns {TaskRecord[]}
 */
function serializeTasks(tasks) {
    return Array.from(tasks.values()).map((task) => serialize(task));
}

module.exports = {
    materializeTasks,
    serializeTasks,
};
```



> backend/src/scheduler/polling/function.js
```javascript
/**
 * Polling execution logic.
 * Handles the core polling behavior with collection exclusivity optimization.
 * 
 * IMPORTANT: The polling loop is intentionally reentrant for task execution.
 * This reentrancy is essential because long-running tasks must not block newly 
 * due tasks from being executed. Task execution happens in parallel to ensure
 * the scheduler remains responsive regardless of individual task duration.
 * 
 * The only exclusivity protection is during the collection phase: when a thread
 * starts collecting due tasks and sees another thread is already collecting
 * (via parallelCounter), it exits early. This optimization reduces wasteful
 * duplicate collection work, not reentrancy itself.
 */

const { mutateTasks } = require('../persistence');
const { evaluateTasksForExecution } = require('../execution');
const { fromMinutes } = require('../../datetime');
const { POLLING_LOOP_NAME } = require('./identifiers');

/**
 * Minimum polling interval is determined by cron job granularity (1 minute).
 */
const POLL_INTERVAL = fromMinutes(1);

/** @typedef {import('../types').Callback} Callback */

/**
 * Create a polling function that evaluates and executes due tasks.
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {import('../types').ParsedRegistrations} registrations
 * @param {Set<string>} scheduledTasks
 * @param {ReturnType<import('../execution').makeTaskExecutor>} taskExecutor
 * @param {string} schedulerIdentifier
 * @returns {{start: () => void, stop: () => Promise<void>}} Loop manager with start/stop methods
 */
function makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor, schedulerIdentifier) {
    const dt = capabilities.datetime;
    /** @type {Set<Promise<void>>} */
    const runningPool = new Set();
    let parallelCounter = 0;
    let isActive = false;
    const sleeper = capabilities.sleeper.makeSleeper(POLLING_LOOP_NAME);
    /** @type {Promise<void> | null} */
    let loopThread = null;

    /**
     * Wrap a promise to ensure it is removed from the running pool when done
     * @param {Promise<void>} promise
     */
    function wrap(promise) {
        const wrapped = promise.finally(() => {
            runningPool.delete(wrapped);
        });
        return wrapped;
    }

    /**
     * Wait for all currently running tasks to complete
     * @returns {Promise<void>}
     */
    async function join() {
        await Promise.all([...runningPool]);
    }

    function start() {
        if (isActive === false) {
            isActive = true;
            loopThread = loop();
        }
    }

    async function stop() {
        if (isActive === true) {
            isActive = false;
            sleeper.wake();
            await loopThread;
            await join();
        }
    }

    async function loop() {
        await new Promise((resolve) => setImmediate(resolve));
        while (isActive) {
            await pollWrapper();
            if (isActive) {
                await sleeper.sleep(POLL_INTERVAL);
            }
        }
    }

    async function getDueTasks() {
        const now = dt.now();
        return await mutateTasks(capabilities, registrations, (tasks) =>
            evaluateTasksForExecution(tasks, scheduledTasks, now, capabilities, schedulerIdentifier)
        );
    }

    async function pollWrapper() {
        // Collection exclusivity optimization: prevent overlapping collection phases
        // to reduce wasteful duplicate work. Task execution itself remains reentrant.
        if (parallelCounter > 0) {
            // Another thread is already collecting due tasks; skip to avoid duplication
            return;
        } else {
            parallelCounter++;
            try {
                await poll();
            } finally {
                parallelCounter--;
            }
        }
    }

    async function poll() {
        // Collect tasks and stats.
        const { dueTasks, stats } = await getDueTasks();

        // Execute all due tasks in parallel
        const todo = taskExecutor.executeTasks(dueTasks);
        runningPool.add(wrap(todo));

        capabilities.logger.logDebug(
            {
                due: dueTasks.length,
                dueRetry: stats.dueRetry,
                dueCron: stats.dueCron,
                skippedRunning: stats.skippedRunning,
                skippedRetryFuture: stats.skippedRetryFuture,
                skippedNotDue: stats.skippedNotDue,
            },
            "PollSummary"
        );
    }

    return { start, stop };
}

module.exports = {
    makePollingFunction,
};

```



> backend/src/scheduler/polling/identifiers.js
```javascript
/**
 * Polling interval management functionality.
 * Handles the timing and execution of polling operations.
 */

const POLLING_LOOP_NAME = "volodyslav:scheduler:poll";

module.exports = {
    POLLING_LOOP_NAME,
};

```



> backend/src/scheduler/polling/index.js
```javascript
/**
 * Lifecycle module.
 * Encapsulates all functionality related to polling lifecycle management.
 */

const { makePollingScheduler } = require('./make');

module.exports = {
    makePollingScheduler,
};

```



> backend/src/scheduler/polling/make.js
```javascript
/**
 * Polling based cron scheduler.
 */

const { mutateTasks } = require("../persistence");
const { makeTaskExecutor } = require("../execution");
const { makePollingFunction } = require("./function");

/**
 * Error thrown when a task registration is not found in the polling scheduler.
 */
class TaskRegistrationNotFoundError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task ${JSON.stringify(taskName)} not found in registrations`);
        this.name = "TaskRegistrationNotFoundError";
        this.taskName = taskName;
    }
}

/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../datetime').Duration} Duration
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../types').Callback} Callback
 */

/** @typedef {import('../types').Registration} Registration */

/**
 * @typedef {import('../types').ParsedRegistrations} ParsedRegistrations
 */

/**
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @param {ParsedRegistrations} registrations
 * @param {string} schedulerIdentifier
 */
function makePollingScheduler(capabilities, registrations, schedulerIdentifier) {
    /** @type {Set<string>} */
    const scheduledTasks = new Set(); // Task names that are enabled. Is a subset of names in `registrations`.

    // Create task executor for handling task execution
    const taskExecutor = makeTaskExecutor(capabilities, (transformation) => mutateTasks(capabilities, registrations, transformation));

    // Create polling function with lifecycle management
    const intervalManager = makePollingFunction(capabilities, registrations, scheduledTasks, taskExecutor, schedulerIdentifier);

    function start() {
        intervalManager.start();
    }

    async function stop() {
        await intervalManager.stop();
    }

    return {
        /**
         * Schedule a new task.
         * @param {string} name
         * @returns {Promise<void>}
         */
        async schedule(name) {
            const found = registrations.get(name);
            if (found === undefined) {
                throw new TaskRegistrationNotFoundError(name);
            }

            if (scheduledTasks.size === 0) {
                start();
            }

            scheduledTasks.add(name);
        },

        /**
         * Cancel a scheduled task.
         * @param {string} name
         * @returns {Promise<boolean>}
         */
        async cancel(name) {
            const existed = scheduledTasks.delete(name);
            if (scheduledTasks.size === 0) {
                stop();
            }
            return existed;
        },

        async stopLoop() {
            return await stop();
        },

        /**
         * Cancel all tasks and stop polling.
         * @returns {Promise<number>}
         */
        async cancelAll() {
            const count = scheduledTasks.size;
            scheduledTasks.clear();
            stop();
            return count;
        },
    };
}

module.exports = {
    makePollingScheduler,
};

```



> backend/src/scheduler/registration_validation/core.js
```javascript
/**
 * Core registration validation logic.
 */

const { parseCronExpression } = require("../expression");
const {
    RegistrationsNotArrayError,
    RegistrationShapeError,
    ScheduleDuplicateTaskError,
    CronExpressionInvalidError,
    NegativeRetryDelayError,
} = require("./errors");

/** @typedef {import('../types').Registration} Registration */

/**
 * Validates registration input format and content
 * @param {Registration[]} registrations
 * @throws {Error} if registrations are invalid
 */
function validateRegistrations(registrations) {
    if (!Array.isArray(registrations)) {
        throw new RegistrationsNotArrayError("Registrations must be an array");
    }

    const seenNames = new Set();

    for (let i = 0; i < registrations.length; i++) {
        const registration = registrations[i];
        if (!Array.isArray(registration) || registration.length !== 4) {
            throw new RegistrationShapeError(`Registration at index ${i} must be an array of length 4: [name, cronExpression, callback, retryDelay]`, { index: i, registration });
        }

        const [name, cronExpression, callback, retryDelay] = registration;
        
        // Validate task name is a string
        if (typeof name !== 'string') {
            throw new RegistrationShapeError(`Registration at index ${i}: task name must be a string, got: ${typeof name}`, { index: i, name, value: name });
        }

        const qname = JSON.stringify(name);
        
        if (callback === undefined || typeof callback !== 'function') {
            throw new RegistrationShapeError(`Registration at index ${i} (${qname}): callback must be a function, got: ${typeof callback}`, { index: i, name, value: callback });
        }

        // Check for duplicate task names - this is now a hard error
        if (seenNames.has(name)) {
            throw new ScheduleDuplicateTaskError(name);
        }
        seenNames.add(name);

        // Basic cron expression validation using the cron module
        try {
            parseCronExpression(cronExpression);
        } catch (error) {
            const message = typeof error === 'object' && error !== null && 'message' in error ? error.message : "unknown error";
            throw new CronExpressionInvalidError(`Registration at index ${i} (${qname}): invalid cron expression '${cronExpression}': ${message}`, { index: i, name, value: cronExpression, error });
        }

        // Validate retry delay is reasonable (warn for very large delays but don't block)
        const retryMs = retryDelay.toMillis();
        if (retryMs < 0) {
            throw new NegativeRetryDelayError(`Registration at index ${i} (${qname}): retryDelay cannot be negative`, { index: i, name, retryMs });
        }
    }
}

module.exports = {
    validateRegistrations,
};
```



> backend/src/scheduler/registration_validation/errors.js
```javascript
/**
 * Error classes for registration validation.
 * These errors are defined close to where they are thrown.
 */

/**
 * Error for invalid registration input.
 */
class InvalidRegistrationError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "InvalidRegistrationError";
        this.details = details;
    }
}

/**
 * Error when registrations is not an array.
 */
class RegistrationsNotArrayError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "RegistrationsNotArrayError";
    }
}

/**
 * Error for invalid registration shape.
 */
class RegistrationShapeError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "RegistrationShapeError";
        this.details = details;
    }
}

/**
 * Error for invalid cron expression.
 */
class CronExpressionInvalidError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "CronExpressionInvalidError";
        this.details = details;
    }
}

/**
 * Error for negative retry delay.
 */
class NegativeRetryDelayError extends Error {
    /**
     * @param {string} message
     * @param {object} [details]
     */
    constructor(message, details) {
        super(message);
        this.name = "NegativeRetryDelayError";
        this.details = details;
    }
}

/**
 * Error thrown when attempting to register a task with a name that already exists.
 */
class ScheduleDuplicateTaskError extends Error {
    /**
     * @param {string} taskName
     */
    constructor(taskName) {
        super(`Task with name "${taskName}" is already scheduled`);
        this.name = "ScheduleDuplicateTaskError";
        this.taskName = taskName;
    }
}

/**
 * @param {unknown} object
 * @returns {object is ScheduleDuplicateTaskError}
 */
function isScheduleDuplicateTaskError(object) {
    return object instanceof ScheduleDuplicateTaskError;
}

module.exports = {
    InvalidRegistrationError,
    RegistrationsNotArrayError,
    RegistrationShapeError,
    CronExpressionInvalidError,
    NegativeRetryDelayError,
    ScheduleDuplicateTaskError,
    isScheduleDuplicateTaskError,
};

```



> backend/src/scheduler/registration_validation/index.js
```javascript
/**
 * Registration validation module.
 * Encapsulates all functionality related to validating task registrations.
 */

const { validateRegistrations } = require("./core");
const { isScheduleDuplicateTaskError } = require("./errors");

module.exports = {
    validateRegistrations,
    isScheduleDuplicateTaskError,
};

```



> backend/src/scheduler/scheduler_identifier.js
```javascript
/**
 * Scheduler identifier generation for tracking task ownership.
 * Each scheduler instance gets a unique identifier to detect
 * orphaned tasks from previous shutdowns.
 */

const { string } = require('../random');

/** @typedef {import('./types').SchedulerCapabilities} SchedulerCapabilities */

/**
 * Generates a unique identifier for this scheduler instance.
 * @param {SchedulerCapabilities} capabilities
 * @returns {string}
 */
function generateSchedulerIdentifier(capabilities) {
    return string(capabilities, 8);
}

module.exports = {
    generateSchedulerIdentifier,
};
```



> backend/src/scheduler/state_validation/core.js
```javascript
/**
 * Core state validation logic.
 */

const {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
} = require("../task/identity");
const { InvalidRegistrationError } = require("../registration_validation/errors");

/** @typedef {import('../types').Registration} Registration */



/**
 * Compares registrations with persisted state and logs any differences.
 * Unlike validateTasksAgainstPersistedStateInner, this function does not throw errors
 * but instead logs the changes and indicates that registrations should override persisted state.
 * @param {Registration[]} registrations
 * @param {import('../../runtime_state_storage/types').TaskRecord[]} persistedTasks
 * @param {import('../types').SchedulerCapabilities} capabilities
 * @returns {{shouldOverride: boolean, changeDetails: {missing: string[], extra: string[], differing: Array<{name: string, field: string, expected: any, actual: any}>}}}
 */
function analyzeStateChanges(registrations, persistedTasks, capabilities) {
    // Early exit optimization for empty arrays
    if (registrations.length === 0 && persistedTasks.length === 0) {
        return { shouldOverride: false, changeDetails: { missing: [], extra: [], differing: [] } };
    }

    // Convert to comparable identities with early validation
    const registrationIdentities = registrations.map((registration, index) => {
        try {
            return registrationToTaskIdentity(registration);
        } catch (err) {
            const error = err instanceof Error ? err : new Error(String(err));
            throw new InvalidRegistrationError(`Invalid registration at index ${index}: ${error.message}`, { index, cause: error });
        }
    });

    const persistedIdentities = persistedTasks.map(taskRecordToTaskIdentity);

    // Use Set for faster lookup operations  
    const registrationNameSet = new Set(registrationIdentities.map(t => t.name));

    // Find mismatches efficiently
    const missing = [];
    const extra = [];
    const differing = [];

    // Find tasks in persisted state but not in registrations
    for (const persistedTask of persistedIdentities) {
        if (!registrationNameSet.has(persistedTask.name)) {
            missing.push(persistedTask.name);
        }
    }

    // Find tasks in registrations but not in persisted state, and check for differences
    const persistedMap = new Map(persistedIdentities.map(t => [t.name, t]));

    for (const regTask of registrationIdentities) {
        const persistedTask = persistedMap.get(regTask.name);

        if (!persistedTask) {
            extra.push(regTask.name);
        } else if (!taskIdentitiesEqual(regTask, persistedTask)) {
            // Detailed difference analysis
            if (regTask.cronExpression !== persistedTask.cronExpression) {
                differing.push({
                    name: regTask.name,
                    field: 'cronExpression',
                    expected: persistedTask.cronExpression,
                    actual: regTask.cronExpression
                });
            }
            if (regTask.retryDelayMs !== persistedTask.retryDelayMs) {
                differing.push({
                    name: regTask.name,
                    field: 'retryDelayMs',
                    expected: persistedTask.retryDelayMs,
                    actual: regTask.retryDelayMs
                });
            }
        }
    }

    const changeDetails = { missing, extra, differing };
    const shouldOverride = missing.length > 0 || extra.length > 0 || differing.length > 0;

    // Log the changes that will be made
    if (shouldOverride) {
        capabilities.logger.logInfo(
            {
                removedTasks: missing,
                addedTasks: extra,
                modifiedTasks: differing.map(d => ({ name: d.name, field: d.field, from: d.expected, to: d.actual })),
                totalChanges: missing.length + extra.length + differing.length
            },
            "Scheduler state override: registrations differ from persisted state, applying changes"
        );

        if (missing.length > 0) {
            capabilities.logger.logDebug(
                { taskNames: missing },
                "Removing tasks from persisted state (no longer in registrations)"
            );
        }
        if (extra.length > 0) {
            capabilities.logger.logDebug(
                { taskNames: extra },
                "Adding new tasks to persisted state"
            );
        }
        if (differing.length > 0) {
            capabilities.logger.logDebug(
                { modifications: differing },
                "Updating task configurations in persisted state"
            );
        }
    }

    return { shouldOverride, changeDetails };
}

module.exports = {
    analyzeStateChanges,
};
```



> backend/src/scheduler/state_validation/errors.js
```javascript
/**
 * Error classes for state validation.
 * These errors are defined close to where they are thrown.
 */

/**
 * Error thrown when the task list provided to initialize() differs from persisted runtime state.
 */
class TaskListMismatchError extends Error {
    /**
     * @param {string} message
     * @param {object} mismatchDetails
     * @param {string[]} mismatchDetails.missing - Tasks in persisted state but not in registrations
     * @param {string[]} mismatchDetails.extra - Tasks in registrations but not in persisted state
     * @param {Array<{name: string, field: string, expected: any, actual: any}>} mismatchDetails.differing - Tasks with differing properties
     */
    constructor(message, mismatchDetails) {
        super(message);
        this.name = "TaskListMismatchError";
        this.mismatchDetails = mismatchDetails;
    }
}

/**
 * @param {unknown} object
 * @returns {object is TaskListMismatchError}
 */
function isTaskListMismatchError(object) {
    return object instanceof TaskListMismatchError;
}

module.exports = {
    TaskListMismatchError,
    isTaskListMismatchError,
};
```



> backend/src/scheduler/state_validation/index.js
```javascript
/**
 * State validation module.
 * Encapsulates all functionality related to validating task state against persisted data.
 */

const { analyzeStateChanges } = require("./core");
const { isTaskListMismatchError } = require("./errors");

module.exports = {
    analyzeStateChanges,
    isTaskListMismatchError,
};
```



> backend/src/scheduler/task/identity.js
```javascript
/**
 * Task identity operations for comparing registrations and persisted state.
 */

/** @typedef {import('../types').Registration} Registration */
/** @typedef {import('../types').TaskIdentity} TaskIdentity */

/**
 * Converts a registration to a TaskIdentity for comparison
 * @param {Registration} registration
 * @returns {TaskIdentity}
 */
function registrationToTaskIdentity(registration) {
    const [name, cronExpression, , retryDelay] = registration;
    return {
        name,
        cronExpression,
        retryDelayMs: retryDelay.toMillis(),
    };
}

/**
 * Converts a persisted TaskRecord to a TaskIdentity for comparison
 * @param {import('../../runtime_state_storage/types').TaskRecord} taskRecord
 * @returns {TaskIdentity}
 */
function taskRecordToTaskIdentity(taskRecord) {
    return {
        name: taskRecord.name,
        cronExpression: taskRecord.cronExpression,
        retryDelayMs: taskRecord.retryDelayMs,
    };
}

/**
 * Compares two TaskIdentity objects for equality
 * @param {TaskIdentity} a
 * @param {TaskIdentity} b
 * @returns {boolean}
 */
function taskIdentitiesEqual(a, b) {
    return (a.name === b.name &&
        a.cronExpression === b.cronExpression &&
        a.retryDelayMs === b.retryDelayMs);
}

module.exports = {
    registrationToTaskIdentity,
    taskRecordToTaskIdentity,
    taskIdentitiesEqual,
};

```



> backend/src/scheduler/task/index.js
```javascript

const { isRunning } = require('./methods');
const { makeTask, isTask } = require('./structure');
const { serialize, tryDeserialize } = require('./serialization');
const {
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
} = require('./serialization_errors');

/**
 * @typedef {import('./structure').Task} Task
 */

/**
 * @typedef {import('./structure').Running} Running
 * @typedef {import('./structure').AwaitingRetry} AwaitingRetry
 * @typedef {import('./structure').AwaitingRun} AwaitingRun
 */

/**
 * @typedef {import('./serialization_errors').TaskTryDeserializeError} TaskTryDeserializeError
 */

module.exports = {
    isRunning,
    makeTask,
    isTask,
    serialize,
    tryDeserialize,
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
};

```



> backend/src/scheduler/task/methods.js
```javascript

/**
 * @typedef {import('./structure').Task} Task
 */

const { getLastAttemptTime, getLastSuccessTime, getLastFailureTime } = require('./structure');

/**
 * Check if a task is currently running.
 * @param {Task} task
 * @returns {boolean}
 */
function isRunning(task) {
    const lastAttemptTime = getLastAttemptTime(task);
    
    if (lastAttemptTime === undefined || lastAttemptTime === null) {
        return false;
    }

    // A task is running if the last attempt is more recent than any completion
    
    // Find the most recent completion time using DateTime methods
    let lastCompletionTime = undefined;
    
    const lastSuccessTime = getLastSuccessTime(task);
    const lastFailureTime = getLastFailureTime(task);
    
    if (lastSuccessTime && lastFailureTime) {
        // Both exist, find the later one
        lastCompletionTime = lastSuccessTime.isAfter(lastFailureTime) 
            ? lastSuccessTime 
            : lastFailureTime;
    } else if (lastSuccessTime) {
        lastCompletionTime = lastSuccessTime;
    } else if (lastFailureTime) {
        lastCompletionTime = lastFailureTime;
    }
    
    // If no completion time, task is running since last attempt
    if (!lastCompletionTime) {
        return true;
    }
    
    return lastAttemptTime.isAfter(lastCompletionTime);
}

module.exports = {
    isRunning,
};

```



> backend/src/scheduler/task/serialization.js
```javascript
/**
 * Task serialization and deserialization functions.
 */

const { makeTask, getLastSuccessTime, getLastFailureTime, getLastAttemptTime, getPendingRetryUntil, getSchedulerIdentifier, createStateFromProperties } = require('./structure');
const { tryDeserialize: dateTimeTryDeserialize, isDateTimeTryDeserializeError } = require('../../datetime');
const {
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    TaskInvalidStructureError,
} = require('./serialization_errors');

/**
 * @typedef {import('./structure').Task} Task
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../../datetime').Duration} Duration
 * @typedef {import('../types').Callback} Callback
 * @typedef {import('./serialization_errors').TaskTryDeserializeError} TaskTryDeserializeError
 */

/**
 * @typedef SerializedTask
 * @type {Object}
 * @property {string} name - Task name
 * @property {string} cronExpression - Original cron expression 
 * @property {number} retryDelayMs - Retry delay in milliseconds
 * @property {DateTime} [lastSuccessTime] - Last successful execution time
 * @property {DateTime} [lastFailureTime] - Last failed execution time
 * @property {DateTime} [lastAttemptTime] - Last attempt time
 * @property {DateTime} [pendingRetryUntil] - Pending retry until time
 * @property {string} [schedulerIdentifier] - Identifier of the scheduler instance that started this task
 */

/**
 * Serialize a Task to a plain object.
 * @param {Task} task - The task to serialize
 * @returns {SerializedTask} - The serialized task
 */
function serialize(task) {
    /** @type {SerializedTask} */
    const serialized = {
        name: task.name,
        cronExpression: task.parsedCron.original,
        retryDelayMs: task.retryDelay.toMillis(),
    };
    
    // Extract values from state using helper functions and only include DateTime fields if they are defined
    const lastSuccessTime = getLastSuccessTime(task);
    const lastFailureTime = getLastFailureTime(task);
    const lastAttemptTime = getLastAttemptTime(task);
    const pendingRetryUntil = getPendingRetryUntil(task);
    const schedulerIdentifier = getSchedulerIdentifier(task);
    
    if (lastSuccessTime !== undefined) {
        serialized.lastSuccessTime = lastSuccessTime;
    }
    if (lastFailureTime !== undefined) {
        serialized.lastFailureTime = lastFailureTime;
    }
    if (lastAttemptTime !== undefined) {
        serialized.lastAttemptTime = lastAttemptTime;
    }
    if (pendingRetryUntil !== undefined) {
        serialized.pendingRetryUntil = pendingRetryUntil;
    }
    if (schedulerIdentifier !== undefined) {
        serialized.schedulerIdentifier = schedulerIdentifier;
    }
    return serialized;
}

/**
 * Attempt to deserialize an unknown object into a Task.
 * This requires access to registrations to get the parsed cron expression and callback.
 * Returns the Task on success, or a TaskTryDeserializeError on failure.
 *
 * @param {unknown} obj - The object to attempt to deserialize
 * @param {import('../types').ParsedRegistrations} registrations - The task registrations
 * @returns {Task | TaskTryDeserializeError} - The deserialized Task or error object
 */
function tryDeserialize(obj, registrations) {
    try {
        if (!obj || typeof obj !== "object" || Array.isArray(obj)) {
            return new TaskInvalidStructureError(
                "Object must be a non-null object and not an array",
                obj
            );
        }

        // Validate name field
        if (!("name" in obj)) return new TaskMissingFieldError("name");
        const name = obj.name;
        if (typeof name !== "string") {
            return new TaskInvalidTypeError("name", name, "string");
        }

        // Validate cronExpression field
        if (!("cronExpression" in obj)) return new TaskMissingFieldError("cronExpression");
        const cronExpression = obj.cronExpression;
        if (typeof cronExpression !== "string") {
            return new TaskInvalidTypeError("cronExpression", cronExpression, "string");
        }

        // Validate retryDelayMs field
        if (!("retryDelayMs" in obj)) return new TaskMissingFieldError("retryDelayMs");
        const retryDelayMs = obj.retryDelayMs;
        if (typeof retryDelayMs !== "number" || !Number.isFinite(retryDelayMs) || retryDelayMs < 0) {
            return new TaskInvalidTypeError("retryDelayMs", retryDelayMs, "non-negative number");
        }
        if (!Number.isInteger(retryDelayMs)) {
            return new TaskInvalidTypeError("retryDelayMs", retryDelayMs, "integer");
        }

        // Validate optional DateTime fields and deserialize them
        const dateTimeFields = [
            ["lastSuccessTime", "lastSuccessTime" in obj ? obj.lastSuccessTime : undefined],
            ["lastFailureTime", "lastFailureTime" in obj ? obj.lastFailureTime : undefined],
            ["lastAttemptTime", "lastAttemptTime" in obj ? obj.lastAttemptTime : undefined],
            ["pendingRetryUntil", "pendingRetryUntil" in obj ? obj.pendingRetryUntil : undefined],
        ];

        /** @type {Record<string, DateTime | undefined>} */
        const deserializedDateTimes = {};

        for (const [fieldName, value] of dateTimeFields) {
            if (value !== undefined) {
                if (value === null) {
                    return new TaskInvalidTypeError(String(fieldName), value, "DateTime or undefined (not null)");
                }
                
                const deserializeResult = dateTimeTryDeserialize(value);
                if (isDateTimeTryDeserializeError(deserializeResult)) {
                    return new TaskInvalidTypeError(
                        String(fieldName), 
                        value, 
                        "DateTime or undefined"
                    );
                }
                
                deserializedDateTimes[String(fieldName)] = deserializeResult;
            } else {
                deserializedDateTimes[String(fieldName)] = undefined;
            }
        }

        // Validate schedulerIdentifier field if present
        const schedulerIdentifier = ("schedulerIdentifier" in obj) ? obj.schedulerIdentifier : undefined;
        if (schedulerIdentifier !== undefined && typeof schedulerIdentifier !== "string") {
            return new TaskInvalidTypeError("schedulerIdentifier", schedulerIdentifier, "string or undefined");
        }

        // Look up the registration to get parsed cron and callback
        const registration = registrations.get(name);
        if (registration === undefined) {
            return new TaskInvalidValueError(
                "name",
                name,
                "task not found in registrations"
            );
        }

        const { parsedCron, callback, retryDelay } = registration;

        // Create state from individual properties using helper function
        const state = createStateFromProperties(
            deserializedDateTimes["lastSuccessTime"],
            deserializedDateTimes["lastFailureTime"],
            deserializedDateTimes["lastAttemptTime"],
            deserializedDateTimes["pendingRetryUntil"],
            schedulerIdentifier
        );

        // Create the task using the factory function with the new signature
        return makeTask(
            name,
            parsedCron,
            callback,
            retryDelay,
            state
        );

    } catch (error) {
        return new TaskInvalidValueError(
            "unknown",
            obj,
            `Unexpected error during deserialization: ${error instanceof Error ? error.message : String(error)}`
        );
    }
}

module.exports = {
    serialize,
    tryDeserialize,
};
```



> backend/src/scheduler/task/serialization_errors.js
```javascript
/**
 * Task serialization/deserialization error classes.
 */

/**
 * Base class for task deserialization errors.
 */
class TaskTryDeserializeError extends Error {
    /**
     * @param {string} message
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(message, field, value, expectedType) {
        super(message);
        this.name = "TaskTryDeserializeError";
        this.field = field;
        this.value = value;
        this.expectedType = expectedType;
    }
}

/**
 * Error for missing required fields.
 */
class TaskMissingFieldError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     */
    constructor(field) {
        super(`Missing required field: ${field}`, field, undefined, "any");
        this.name = "TaskMissingFieldError";
    }
}

/**
 * Error for invalid field types.
 */
class TaskInvalidTypeError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} expectedType
     */
    constructor(field, value, expectedType) {
        const actualType = Array.isArray(value) ? 'array' : typeof value;
        super(`Invalid type for field '${field}': expected ${expectedType}, got ${actualType}`, 
              field, value, expectedType);
        this.name = "TaskInvalidTypeError";
        this.actualType = actualType;
    }
}

/**
 * Error for invalid field values.
 */
class TaskInvalidValueError extends TaskTryDeserializeError {
    /**
     * @param {string} field
     * @param {unknown} value
     * @param {string} reason
     */
    constructor(field, value, reason) {
        super(`Invalid value for field '${field}': ${reason}`, field, value, "valid");
        this.name = "TaskInvalidValueError";
        this.reason = reason;
    }
}

/**
 * Error for invalid object structure.
 */
class TaskInvalidStructureError extends TaskTryDeserializeError {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message, "structure", value, "object");
        this.name = "TaskInvalidStructureError";
    }
}

// Type guard functions
/**
 * @param {unknown} object
 * @returns {object is TaskTryDeserializeError}
 */
function isTaskTryDeserializeError(object) {
    return object instanceof TaskTryDeserializeError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskMissingFieldError}
 */
function isTaskMissingFieldError(object) {
    return object instanceof TaskMissingFieldError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidTypeError}
 */
function isTaskInvalidTypeError(object) {
    return object instanceof TaskInvalidTypeError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidValueError}
 */
function isTaskInvalidValueError(object) {
    return object instanceof TaskInvalidValueError;
}

/**
 * @param {unknown} object
 * @returns {object is TaskInvalidStructureError}
 */
function isTaskInvalidStructureError(object) {
    return object instanceof TaskInvalidStructureError;
}

module.exports = {
    TaskTryDeserializeError,
    TaskMissingFieldError,
    TaskInvalidTypeError,
    TaskInvalidValueError,
    TaskInvalidStructureError,
    isTaskTryDeserializeError,
    isTaskMissingFieldError,
    isTaskInvalidTypeError,
    isTaskInvalidValueError,
    isTaskInvalidStructureError,
};
```



> backend/src/scheduler/task/structure.js
```javascript

/**
 * @typedef {import('../../logger').Logger} Logger
 * @typedef {import('../../datetime').Duration} Duration
 * @typedef {import('../types').CronExpression} CronExpression
 * @typedef {import('../../datetime').DateTime} DateTime
 * @typedef {import('../types').Callback} Callback
 */


/**
 * @typedef {object} Running
 * @property {DateTime} lastAttemptTime - Time of the last attempt
 * @property {string} schedulerIdentifier - Identifier of the scheduler that started this task
 */

/**
 * @typedef {object} AwaitingRetry
 * @property {DateTime} lastFailureTime - Time of the last failure
 * @property {DateTime} pendingRetryUntil - Time until which the task is pending retry
 */

/**
 * @typedef {object} AwaitingRun
 * @property {DateTime | null} lastSuccessTime - Time of the last successful run, or null if never run
 * @property {DateTime | null} lastAttemptTime - Time of the last attempt, or null if never attempted
 */

/**
 * @typedef {Running | AwaitingRetry | AwaitingRun } State
 */


/**
 * Nominal type for Task to prevent external instantiation.
 */
class TaskClass {
    /** @type {undefined} */
    __brand = undefined; // nominal typing brand

    /**
     * @param {string} name
     * @param {CronExpression} parsedCron
     * @param {Callback} callback
     * @param {Duration} retryDelay
     * @param {State} state
     */
    constructor(name, parsedCron, callback, retryDelay, state) {
        if (this.__brand !== undefined) {
            throw new Error("Task is a nominal type and cannot be instantiated directly. Use makeTask() instead.");
        }
        this.name = name;
        this.parsedCron = parsedCron;
        this.callback = callback;
        this.retryDelay = retryDelay;
        this.state = state;
    }
}

/**
 * Factory function to create a Task instance.
 * @param {string} name
 * @param {CronExpression} parsedCron
 * @param {Callback} callback
 * @param {Duration} retryDelay
 * @param {State} state
 * @returns {TaskClass}
 */
function makeTask(name, parsedCron, callback, retryDelay, state) {
    return new TaskClass(name, parsedCron, callback, retryDelay, state);
}

/**
 * @param {unknown} value 
 * @returns {value is TaskClass}
 */
function isTask(value) {
    return value instanceof TaskClass;
}

/**
 * Helper function to extract lastAttemptTime from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getLastAttemptTime(task) {
    if ('lastAttemptTime' in task.state) {
        return task.state.lastAttemptTime || undefined;
    }
    return undefined;
}

/**
 * Helper function to extract lastSuccessTime from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getLastSuccessTime(task) {
    if ('lastSuccessTime' in task.state) {
        return task.state.lastSuccessTime || undefined;
    }
    return undefined;
}

/**
 * Helper function to extract lastFailureTime from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getLastFailureTime(task) {
    if ('lastFailureTime' in task.state) {
        return task.state.lastFailureTime;
    }
    return undefined;
}

/**
 * Helper function to extract pendingRetryUntil from task state.
 * @param {Task} task
 * @returns {DateTime | undefined}
 */
function getPendingRetryUntil(task) {
    if ('pendingRetryUntil' in task.state) {
        return task.state.pendingRetryUntil;
    }
    return undefined;
}

/**
 * Helper function to extract schedulerIdentifier from task state.
 * @param {Task} task
 * @returns {string | undefined}
 */
function getSchedulerIdentifier(task) {
    if ('schedulerIdentifier' in task.state) {
        return task.state.schedulerIdentifier;
    }
    return undefined;
}

/**
 * Helper function to create a state object from individual properties (for migration purposes).
 * @param {DateTime | undefined} lastSuccessTime
 * @param {DateTime | undefined} lastFailureTime
 * @param {DateTime | undefined} lastAttemptTime
 * @param {DateTime | undefined} pendingRetryUntil
 * @param {string | undefined} schedulerIdentifier
 * @returns {State}
 */
function createStateFromProperties(lastSuccessTime, lastFailureTime, lastAttemptTime, pendingRetryUntil, schedulerIdentifier) {
    // Priority 1: If we have a pending retry, this is an AwaitingRetry state
    if (pendingRetryUntil && lastFailureTime) {
        /** @type {AwaitingRetry} */
        return {
            lastFailureTime,
            pendingRetryUntil
        };
    }
    
    // Priority 2: If we have lastAttemptTime and schedulerIdentifier (and no completion times), use Running
    if (lastAttemptTime && schedulerIdentifier && !lastSuccessTime && !lastFailureTime) {
        /** @type {Running} */
        return {
            lastAttemptTime,
            schedulerIdentifier
        };
    }
    
    // Default: AwaitingRun state
    /** @type {AwaitingRun} */
    return {
        lastSuccessTime: lastSuccessTime || null,
        lastAttemptTime: lastAttemptTime || null
    };
}

/**
 * @typedef {TaskClass} Task
 */

module.exports = {
    isTask,
    makeTask,
    getLastAttemptTime,
    getLastSuccessTime,
    getLastFailureTime,
    getPendingRetryUntil,
    getSchedulerIdentifier,
    createStateFromProperties,
};

```



> backend/src/scheduler/types.js
```javascript

/**
 * Type definitions for the declarative scheduler.
 */

/** @typedef {import('../datetime').Duration} Duration */
/** @typedef {import('./task').Task} Task */
/** @typedef {import('../runtime_state_storage').TaskRecord} TaskRecord */
/** @typedef {import('../runtime_state_storage').RuntimeState} RuntimeState */
/** @typedef {() => Promise<void>} Callback */
/** @typedef {import('./expression').CronExpression} CronExpression */
/** @typedef {import('./task').TaskTryDeserializeError} TaskTryDeserializeError */

/**
 * Restricted capabilities needed by the scheduler.
 * Only includes the minimal set of capabilities actually used by the scheduler.
 * @typedef {object} SchedulerCapabilities
 * @property {import('../datetime').Datetime} datetime - Datetime utilities
 * @property {import('../logger').Logger} logger - A logger instance
 * @property {import('../runtime_state_storage').RuntimeStateCapability} state - A runtime state storage instance
 * @property {import('../random/seed').NonDeterministicSeed} seed - A random number generator instance
 * @property {import('../sleeper').SleepCapability} sleeper - A sleeper instance
 */

/**
 * @typedef {object} Scheduler
 * @property {Initialize} initialize - Initializes the scheduler with task registrations
 * @property {Stop} stop - Stops the scheduler and cleans up resources
 */

/**
 * Registration tuple defining a scheduled task.
 * @typedef {[string, string, Callback, Duration]} Registration
 * @example
 * // Schedule a daily backup task at 2 AM
 * const registration = [
 *   "daily-backup",           // Task name (must be unique)
 *   "0 2 * * *",             // Cron expression (daily at 2:00 AM)
 *   async () => { ... },     // Async callback function
 *   fromMinutes(30)          // Retry delay (30 minutes)
 * ];
 */

/**
 * @typedef {object} ParsedRegistration
 * @property {string} name
 * @property {CronExpression} parsedCron
 * @property {Callback} callback
 * @property {Duration} retryDelay
 */

/**
 * @typedef {Map<string, ParsedRegistration>} ParsedRegistrations
 */

/**
 * @template T
 * @typedef {(tasks: Map<string, Task>) => T} Transformation
 */

/**
 * @template T
 * @typedef {(tasks: TaskRecord[]) => T} RecordTransformation
 */

/**
 * Task identity for comparison between registrations and persisted state.
 * @typedef {object} TaskIdentity
 * @property {string} name - Unique task name
 * @property {string} cronExpression - Cron expression for scheduling
 * @property {number} retryDelayMs - Retry delay in milliseconds
 */

/**
 * Initialize function that registers tasks with the scheduler.
 * @typedef {(registrations: Array<Registration>) => Promise<void>} Initialize
 * @example
 * // Initialize the scheduler
 * await scheduler.initialize([
 *   ["task1", "0 * * * *", async () => { console.log("hourly"); }, fromMinutes(5)]
 * ]);
 */

/**
 * Stop function that gracefully shuts down the scheduler.
 * @typedef {() => Promise<void>} Stop
 * @example
 * // Graceful shutdown
 * await scheduler.stop();
 */

module.exports = {
    // This module only contains type definitions, no runtime exports needed
};

```
