/**
 * Logger module using pino.
 */

const pino = require("pino").default;
const pinoHttp = require("pino-http").default;
const { logLevel } = require("./environment");
const { notifyAboutError } = require("./notifications");

// Pretty-print logs
const transport = pino.transport({
    target: "pino-pretty",
    options: {
        colorize: true,
        translateTime: "yyyy-mm-dd HH:MM:ss.l o",
        ignore: "pid,hostname",
    },
});

/** Pino logger instance. @type {pino.Logger} */
const baseLogger = pino({ level: logLevel() }, transport);

/**
 * Logs an error message and sends a notification.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} [msg] Optional message when the first argument is an object
 * @returns {void}
 */
function logError(obj, msg) {
    // Call the original error method with proper typing
    baseLogger.error(obj, msg);

    // Extract the error message for notification
    let message;
    if (typeof msg === 'string') {
        message = msg;
    } else if (obj instanceof Error) {
        message = obj.message;
    } else {
        message = String(obj);
    }

    // Send notification
    notifyAboutError(message).catch((err) => {
        baseLogger.error({ error: err }, 'Failed to send error notification');
    });
}

// Create a wrapper logger that adds notifications for errors
/** @type {pino.Logger} */
const logger = {
    ...baseLogger,
    error: logError,
};

/**
 * @param {import('express').Express} app
 * @returns {void}
 * @description Sets up HTTP call logging for the given Express app.
 */
function setupHttpCallsLogging(app) {
    app.use(pinoHttp({ baseLogger }));
}

const { error, info, warn, debug, fatal } = logger;

module.exports = {
    setupHttpCallsLogging,
    error,
    info,
    warn,
    debug,
    fatal,
}
