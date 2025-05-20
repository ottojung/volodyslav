/**
 * Logger module using pino.
 */

const pino = require("pino").default;
const pinoHttp = require("pino-http").default;
const { notifyAboutError } = require("./notifications");
const fs = require("fs").promises;
const path = require("path");

/** @typedef {import('./environment').Environment} Environment */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 */

/** Pino logger instance. @type {pino.Logger?} */
let logger = null;

/**
 * @typedef {Object} TransportTarget
 * @property {string} target - The target module name
 * @property {string} level - The log level
 * @property {Object} options - Target specific options
 */

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
 * Creates a console target for logging
 * @param {string} level The log level to use
 * @returns {TransportTarget} A pino transport target for console output
 */
function createConsoleTarget(level) {
    return {
        target: "pino-pretty",
        level,
        options: {
            colorize: true,
            translateTime: "yyyy-mm-dd HH:MM:ss.l o",
            ignore: "pid,hostname",
            destination: process.stderr.fd, // Redirect logs to stderr instead of stdout
        },
    };
}

/**
 * Creates a file target for logging if possible
 * @param {string} filePath The path to the log file
 * @param {string[]} errors Array to collect error messages
 * @returns {Promise<TransportTarget|null>} A pino transport target for file output, or null if file is not writable
 */
async function createFileTarget(filePath, errors) {
    if (!filePath) {
        errors.push(
            "Log file path not provided. Continuing with console logging only."
        );
        return null;
    }

    try {
        // Ensure the directory for the log file exists
        await fs.mkdir(path.dirname(filePath), { recursive: true });

        // Try to write to the file to verify it's writable
        await fs.appendFile(filePath, "");

        // If we get here, the file is writable
        return {
            target: "pino/file",
            level: "debug",
            options: { destination: filePath },
        };
    } catch (error) {
        // Explicitly typing the error
        const err = /** @type {Error} */ (error);
        errors.push(
            `Unable to write to log file ${filePath}: ${err.message}. Continuing with console logging only.`
        );
        return null;
    }
}

/**
 * Safely gets the log level, with fallback to "debug"
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string[]} errors Array to collect error messages
 * @returns {string} The log level to use
 */
function safeGetLogLevel(capabilities, errors) {
    try {
        return capabilities.environment.logLevel();
    } catch (error) {
        const err = /** @type {Error} */ (error);
        errors.push(`Unable to get log level: ${err.message}`);
        return "debug";
    }
}

/**
 * Safely gets the log file path
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {string[]} errors Array to collect error messages
 * @returns {string|null} The log file path or null if not available
 */
function safeGetLogFilePath(capabilities, errors) {
    try {
        return capabilities.environment.logFile();
    } catch (error) {
        const err = /** @type {Error} */ (error);
        errors.push(`Logger setup issue: ${err.message}`);
        return null;
    }
}

/**
 * Sets up the logger.
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @description Initializes the logger with the specified log level and file.
 * @returns {Promise<void>}
 */
async function setup(capabilities) {
    /** @type {string[]} */
    const errors = [];
    /** @type {string[]} */
    const infos = [];

    /** @type {TransportTarget[]} */
    const targets = [];

    // Get log level safely
    const logLevelValue = safeGetLogLevel(capabilities, errors);
    infos.push(`Log level set to: ${logLevelValue}`);

    // Always add console target
    targets.push(createConsoleTarget(logLevelValue));

    // Try to add file target if possible
    const logFilePath = safeGetLogFilePath(capabilities, errors);
    if (logFilePath) {
        infos.push(`Log file path set to: ${logFilePath}`);
        const fileTarget = await createFileTarget(logFilePath, errors);
        if (fileTarget) {
            targets.push(fileTarget);
        }
    }

    // Create the transport with available targets
    const transport = pino.transport({
        targets: targets,
    });

    // Initialize the logger
    logger = pino({ level: logLevelValue }, transport);

    // Report any setup errors
    for (const error of errors) {
        logError({}, error);
    }

    // Report any setup info
    for (const info of infos) {
        logInfo({}, info);
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
