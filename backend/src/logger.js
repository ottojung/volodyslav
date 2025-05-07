/**
 * Logger module using pino.
 */

const pino = require('pino').default;
const { logLevel } = require('./environment');
const { notifyAboutError } = require('./notifications');

// Pretty-print logs
const transport = pino.transport({
    target: 'pino-pretty',
    options: {
        colorize: true,
        translateTime: 'yyyy-mm-dd HH:MM:ss.l o',
        ignore: 'pid,hostname'
    }
});

/** Pino logger instance. @type {pino.Logger} */
const baseLogger = pino({ level: logLevel() }, transport);

// Create a wrapper logger that adds notifications for errors
/** @type {pino.Logger} */
const logger = {
    ...baseLogger,
    /** @type {import('pino').LogFn} */
    error(/** @type {object | string} */ firstArg, /** @type {string | undefined} */ msg, /** @type {...any} */ ...args) {
        // Call the original error method with proper typing
        if (typeof firstArg === 'string') {
            baseLogger.error(firstArg, ...args);
        } else {
            baseLogger.error(firstArg, msg, ...args);
        }
        
        // Extract the error message for notification
        let message;
        const lastArg = args[args.length - 1];

        if (typeof msg === 'string') {
            message = msg;
        } else if (typeof firstArg === 'object' && firstArg !== null) {
            const obj = /** @type {{msg?: string, message?: string}} */ (firstArg);
            message = obj.msg || obj.message || JSON.stringify(firstArg);
        } else if (typeof firstArg === 'string') {
            message = firstArg;
        } else {
            message = String(firstArg);
        }
        
        // Send notification
        notifyAboutError(message).catch(err => {
            baseLogger.warn({ error: err }, 'Failed to send error notification');
        });
    }
};

module.exports = logger;
