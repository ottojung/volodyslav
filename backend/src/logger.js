/**
 * Logger module using pino.
 */

const pino = require("pino").default;
const pinoHttp = require("pino-http").default;
const { logLevel } = require("./environment");

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

// Create a wrapper logger that adds notifications for errors
/** @type {pino.Logger} */
const logger = {
    ...baseLogger,
};

/**
 * @param {import('express').Express} app
 * @returns {void}
 * @description Sets up HTTP call logging for the given Express app.
 */
function setupHttpCallsLogging(app) {
    app.use(pinoHttp({ logger }));
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
