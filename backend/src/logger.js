/**
 * Logger module using pino.
 */

const pino = require("pino").default;
const pinoHttp = require("pino-http").default;
const { logLevel, logFile } = require("./environment");
const { notifyAboutError } = require("./notifications");
const fs = require("fs").promises;
const path = require("path");

/** Pino logger instance. @type {pino.Logger?} */
let logger = null;

/**
 * @param {import('express').Express} app
 * @returns {void}
 * @description Sets up HTTP call logging for the given Express app.
 */
function enableHttpCallsLogging(app) {
    if (logger === null) {
        throw new Error("Logger not initialized");
    }

    app.use(pinoHttp({ logger }));
}

/**
 * Sets up the logger.
 * @description Initializes the logger with the specified log level and file.
 * @returns {Promise<void>}
 */
async function setup() {
    const targets = [];
    const errors = [];

    let logLevelValue;
    try {
        logLevelValue = logLevel();
    } catch (error) {
        errors.push("Unable to get log level");
        logLevelValue = "debug";
    }

    targets.push({
        target: "pino-pretty",
        level: logLevelValue,
        options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss.l o",
            ignore: "pid,hostname",
        },
    });

    try {
        // Try to get the log file path
        const logFilePath = logFile();

        if (logFilePath) {
            // Ensure the directory for the log file exists.
            try {
                await fs.mkdir(path.dirname(logFilePath), { recursive: true });

                // Try to write to the file to verify it's writable
                await fs.appendFile(logFilePath, "");

                // If we get here, the file is writable, add it to targets
                targets.push({
                    target: "pino/file",
                    level: "debug",
                    options: { destination: logFilePath },
                });
            } catch (error) {
                // Explicitly typing the error
                const err = /** @type {Error} */ (error);
                errors.push(
                    `Unable to write to log file ${logFilePath}: ${err.message}. Continuing with console logging only.`
                );
            }
        } else {
            errors.push(
                "Log file path not provided. Continuing with console logging only."
            );
        }
    } catch (error) {
        // Explicitly typing the error
        const err = /** @type {Error} */ (error);
        errors.push(`Logger setup issue: ${err.message}`);
    }

    const transport = pino.transport({
        targets: targets,
    });

    logger = pino({ level: "debug" }, transport);

    for (const error of errors) {
        logError({}, error);
    }
}

/**
 * Logs an error message and sends a notification.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logError(obj, msg) {
    // Call the original error method with proper typing
    if (logger !== null) {
        logger.error(obj, msg);
    } else {
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.error(obj, msg);
    }

    // Send notification
    notifyAboutError(msg).catch((err) => {
        if (logger !== null) {
            logger.error({ error: err }, "Failed to send error notification");
        } else {
            // Fallback to console if logger is not initialized
            console.error("Logger not initialized");
            console.error({ error: err }, "Failed to send error notification");
        }
    });
}

/**
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logWarning(obj, msg) {
    if (logger !== null) {
        logger.warn(obj, msg);
    } else {
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.warn(obj, msg);
    }
}

/**
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logInfo(obj, msg) {
    if (logger !== null) {
        logger.info(obj, msg);
    } else {
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.info(obj, msg);
    }
}

/**
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logDebug(obj, msg) {
    if (logger !== null) {
        logger.debug(obj, msg);
    } else {
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.debug(obj, msg);
    }
}

module.exports = {
    enableHttpCallsLogging,
    setup,
    logError,
    logWarning,
    logInfo,
    logDebug,
};
