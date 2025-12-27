'use strict';

/**
 * Logger module using pino.
 */

const { enableHttpCallsLogging, setup } = require('./setup.js');
const {
    logError,
    logWarning,
    logInfo,
    logDebug,
    printf,
} = require('./log_methods.js');

/** @typedef {import('../environment.js').Environment} Environment */
/** @typedef {import('../notifications.js').Notifier} Notifier */
/** @typedef {import('../filesystem/creator.js').FileCreator} FileCreator */
/** @typedef {import('../filesystem/appender.js').FileAppender} FileAppender */
/** @typedef {import('../filesystem/checker.js').FileChecker} FileChecker */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Notifier} notifier - A notifier instance.
 * @property {FileCreator} creator - A file creator instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileChecker} checker - A file checker instance.
 */

/**
 * @typedef {object} LoggerState
 * @property {import('pino').Logger?} logger - The Pino logger instance.
 * @property {string} logLevel - The current log level.
 * @property {string?} logFile - The log file path, if any.
 * @property {Capabilities?} capabilities - The capabilities instance.
 */

/** @typedef {ReturnType<make>} Logger */

/**
 * Factory returning a Logger interface bound to its state.
 * @param {() => Capabilities} getCapabilities - A function to get the capabilities.
 */
function make(getCapabilities) {
    /** @type {LoggerState} */
    const state = {
        logger: null,
        logLevel: 'debug',
        logFile: null,
        capabilities: null,
    };

    /**
     * @param {import('express').Express} app
     */
    function enableWrapper(app) {
        enableHttpCallsLogging(state, app);
    }

    async function setupWrapper() {
        state.capabilities = getCapabilities();
        await setup(state);
    }

    /**
     * @param {unknown} obj
     * @param {string} msg
     */
    function errorWrapper(obj, msg) {
        logError(state, obj, msg);
    }

    /**
     * @param {unknown} obj
     * @param {string} msg
     */
    function warnWrapper(obj, msg) {
        logWarning(state, obj, msg);
    }

    /**
     * @param {unknown} obj
     * @param {string} msg
     */
    function infoWrapper(obj, msg) {
        logInfo(state, obj, msg);
    }

    /**
     * @param {unknown} obj
     * @param {string} msg
     */
    function debugWrapper(obj, msg) {
        logDebug(state, obj, msg);
    }

    /**
     * @param {string} msg
     */
    function printfWrapper(msg) {
        printf(state, msg);
    }

    return {
        enableHttpCallsLogging: enableWrapper,
        setup: setupWrapper,
        logError: errorWrapper,
        logWarning: warnWrapper,
        logInfo: infoWrapper,
        logDebug: debugWrapper,
        printf: printfWrapper,
    };
}

module.exports = {
    make,
};

