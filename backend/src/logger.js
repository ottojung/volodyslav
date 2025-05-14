/**
 * Logger module using pino.
 */

const pino = require("pino").default;
const pinoHttp = require("pino-http").default;
const { logLevel, logFile } = require("./environment");
const { notifyAboutError } = require("./notifications");
const fs = require("fs").promises;
const path = require("path");

/** Pino logger instance. @type {pino.Logger} */
let logger;

/**
 * @param {import('express').Express} app
 * @returns {void}
 * @description Sets up HTTP call logging for the given Express app.
 */
function enableHttpCallsLogging(app) {
    app.use(pinoHttp({ logger }));
}

/**
 * Sets up the logger.
 * @description Initializes the logger with the specified log level and file.
 * @returns {Promise<void>}
 */
async function setup() {
    const logFilePath = logFile();
    // Ensure the directory for the log file exists.
    await fs.mkdir(path.dirname(logFilePath), { recursive: true });

    const transport = pino.transport({
        targets: [
            {
                target: "pino-pretty",
                level: logLevel(),
                options: {
                    colorize: true,
                    translateTime: "yyyy-mm-dd HH:MM:ss.l o",
                    ignore: "pid,hostname",
                },
            },
            {
                target: "pino/file",
                level: "debug",
                options: { destination: logFilePath },
            },
        ],
    });

    logger = pino({ level: logLevel() }, transport);
}

/**
 * Logs an error message and sends a notification.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logError(obj, msg) {
    // Call the original error method with proper typing
    logger.error(obj, msg);

    // Extract the error message for notification
    let message;
    if (typeof msg === "string") {
        message = msg;
    } else if (obj instanceof Error) {
        message = obj.message;
    } else {
        message = String(obj);
    }

    // Send notification
    notifyAboutError(message).catch((err) => {
        logger.error({ error: err }, "Failed to send error notification");
    });
}

/**
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logWarning(obj, msg) {
    logger.warn(obj, msg);
}

/**
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logInfo(obj, msg) {
    logger.info(obj, msg);
}

/**
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logDebug(obj, msg) {
    logger.debug(obj, msg);
}

module.exports = {
    enableHttpCallsLogging,
    setup,
    logError,
    logWarning,
    logInfo,
    logDebug,
};
