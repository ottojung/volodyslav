/**
 * Logger module using pino.
 */

const pino = require('pino').default;

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
const logger = pino({ level: process.env.LOG_LEVEL || 'info' }, transport);

module.exports = logger;
