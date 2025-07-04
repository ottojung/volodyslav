'use strict';

/**
 * Internal logging methods for pino logger.
 */

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
 * @typedef {object} LoggerState
 * @property {import('pino').Logger?} logger - The Pino logger instance.
 * @property {string} logLevel - The current log level.
 * @property {string?} logFile - The log file path, if any.
 * @property {Capabilities?} capabilities - The capabilities instance.
 */

/**
 * @param {LoggerState} state - The logger state.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logError(state, obj, msg) {
    if (state.logger !== null) {
        state.logger.error(obj, msg);
    } else {
        console.error('Logger not initialized');
        console.error(obj, msg);
    }

    state.capabilities?.notifier?.notifyAboutError(msg).catch((error) => {
        if (state.logger !== null) {
            state.logger.error('Failed to send error notification', { error });
        } else {
            console.error('Logger not initialized');
            console.error('Failed to send error notification', { error });
        }
    });
}

/**
 * @param {LoggerState} state - The logger state.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logWarning(state, obj, msg) {
    if (state.logger !== null) {
        state.logger.warn(obj, msg);
    } else {
        console.warn('Logger not initialized');
        console.warn(obj, msg);
    }
}

/**
 * @param {LoggerState} state - The logger state.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logInfo(state, obj, msg) {
    if (state.logger !== null) {
        state.logger.info(obj, msg);
    } else {
        console.info('Logger not initialized');
        console.info(obj, msg);
    }
}

/**
 * @param {LoggerState} state - The logger state.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logDebug(state, obj, msg) {
    if (state.logger !== null) {
        state.logger.debug(obj, msg);
    } else {
        console.debug('Logger not initialized');
        console.debug(obj, msg);
    }
}

/**
 * Simple printf-like helper.
 * Prints the given arguments to stderr without any additional handling.
 *
 * @param {LoggerState} _state - The logger state (unused).
 * @param {string} msg
 * @returns {void}
 */
function printf(_state, msg) {
    console.log(msg);
}

module.exports = {
    logError,
    logWarning,
    logInfo,
    logDebug,
    printf,
};

