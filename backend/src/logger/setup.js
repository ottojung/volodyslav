'use strict';

const pino = require('pino').default;
const pinoHttp = require('pino-http').default;

const { logError, logWarning, logInfo } = require('./log_methods.js');

/** @typedef {import('../environment').Environment} Environment */
/** @typedef {import('../notifications').Notifier} Notifier */
/** @typedef {import('../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('../filesystem/checker').FileChecker} FileChecker */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Notifier} notifier - A notifier instance.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileChecker} checker - A file checker instance.
 */

/**
 * @typedef {Object} TransportTarget
 * @property {string} target - The target module name
 * @property {string} level - The log level
 * @property {Object} options - Target specific options
 */

/**
 * @typedef {object} LoggerState
 * @property {import('pino').Logger?} logger - The Pino logger instance.
 * @property {string} logLevel - The current log level.
 * @property {string?} logFile - The log file path, if any.
 * @property {Capabilities?} capabilities - The capabilities instance.
 */

/**
 * @param {LoggerState} state - The logger state.
 * @param {import('express').Express} app
 * @returns {void}
 * @description Sets up HTTP call logging for the given Express app.
 */
function enableHttpCallsLogging(state, app) {
    if (state.logger === null) {
        throw new Error('Logger not initialized');
    }

    app.use(pinoHttp({ logger: state.logger }));
}

/**
 * Creates a console target for logging
 * @param {string} level The log level to use
 * @returns {TransportTarget} A pino transport target for console output
 */
function createConsoleTarget(level) {
    return {
        target: 'pino-pretty',
        level,
        options: {
            colorize: true,
            translateTime: 'yyyy-mm-dd HH:MM:ss.l o',
            ignore: 'pid,hostname',
            destination: process.stderr.fd,
        },
    };
}

/**
 * Creates a file target for logging if possible
 * @param {LoggerState} state - The logger state.
 * @param {string} filePath The path to the log file
 * @param {(() => void)[]} todos Array to collect error messages
 * @returns {Promise<TransportTarget|null>} A pino transport target for file output, or null if file is not writable
 */
async function createFileTarget(state, filePath, todos) {
    if (!filePath) {
        todos.push(() =>
            logWarning(
                state,
                {},
                'Log file path not provided. Continuing with console logging only.'
            )
        );
        return null;
    }

    try {
        if (!state.capabilities) {
            throw new Error('Capabilities not initialized');
        }

        const checker = state.capabilities.checker;
        const creator = state.capabilities.creator;
        const appender = state.capabilities.appender;

        const proof = await checker.fileExists(filePath);
        let file;
        if (proof) {
            file = await checker.instantiate(filePath);
        } else {
            file = await creator.createFile(filePath);
        }

        await appender.appendFile(file, '');

        return {
            target: 'pino/file',
            level: 'debug',
            options: { destination: filePath },
        };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        todos.push(() =>
            logWarning(
                state,
                {},
                `Unable to write to log file ${filePath}: ${message}. Continuing with console logging only.`
            )
        );
        return null;
    }
}

/**
 * Safely gets the log level, with fallback to "debug"
 * @param {LoggerState} state - The logger state.
 * @param {(() => void)[]} todos Array to collect error messages
 * @returns {string} The log level to use
 */
function safeGetLogLevel(state, todos) {
    try {
        if (!state.capabilities) {
            throw new Error('Capabilities not initialized');
        }
        return state.capabilities.environment.logLevel();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        todos.push(() => logError(state, {}, `Unable to get log level: ${message}`));
        return 'debug';
    }
}

/**
 * Safely gets the log file path
 * @param {LoggerState} state - The logger state.
 * @param {(() => void)[]} todos Array to collect error messages
 * @returns {string?} The log file path or null if not available
 */
function safeGetLogFilePath(state, todos) {
    try {
        if (!state.capabilities) {
            throw new Error('Capabilities not initialized');
        }
        return state.capabilities.environment.logFile();
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        todos.push(() => logError(state, {}, `Unable to get log file: ${message}`));
        return null;
    }
}

/**
 * @param {LoggerState} state - The logger state.
 * @returns {Promise<void>}
 */
async function setup(state) {
    /** @type {(() => void)[]} */
    const todos = [];

    /** @type {TransportTarget[]} */
    const targets = [];

    const logLevelValue = safeGetLogLevel(state, todos);
    todos.push(() => logInfo(state, {}, `Log level set to: ${logLevelValue}`));

    targets.push(createConsoleTarget(logLevelValue));

    const logFilePath = safeGetLogFilePath(state, todos);
    if (logFilePath) {
        todos.push(() => logInfo(state, {}, `Log file path set to: ${logFilePath}`));
        const fileTarget = await createFileTarget(state, logFilePath, todos);
        if (fileTarget) {
            targets.push(fileTarget);
        }
    }

    const transport = pino.transport({
        targets: targets,
    });

    state.logger = pino({ level: logLevelValue }, transport);
    state.logLevel = logLevelValue;
    state.logFile = logFilePath;

    for (const todo of todos) {
        todo();
    }
}

module.exports = {
    enableHttpCallsLogging,
    setup,
};

