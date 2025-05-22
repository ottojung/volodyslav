/**
 * Logger module using pino.
 */

const pino = require("pino").default;
const pinoHttp = require("pino-http").default;
const fs = require("fs").promises;
const path = require("path");

/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./notifications').Notifier} Notifier */

/**
 * @typedef {object} Capabilities
 * @property {Environment} environment - An environment instance.
 * @property {Notifier} notifier - A notifier instance.
 */

/**
 * @typedef {Object} TransportTarget
 * @property {string} target - The target module name
 * @property {string} level - The log level
 * @property {Object} options - Target specific options
 */

/**
 * @typedef {object} LoggerState
 * @property {pino.Logger?} logger - The Pino logger instance.
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
        throw new Error("Logger not initialized");
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
                "Log file path not provided. Continuing with console logging only."
            )
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
        todos.push(() =>
            logWarning(
                state,
                {},
                `Unable to write to log file ${filePath}: ${err.message}. Continuing with console logging only.`
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
            throw new Error("Capabilities not initialized");
        }
        return state.capabilities.environment.logLevel();
    } catch (error) {
        const err = /** @type {Error} */ (error);
        todos.push(() =>
            logError(state, {}, `Unable to get log level: ${err.message}`)
        );
        return "debug";
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
            throw new Error("Capabilities not initialized");
        }
        return state.capabilities.environment.logFile();
    } catch (error) {
        const err = /** @type {Error} */ (error);
        todos.push(() =>
            logError(state, {}, `Unable to get log file: ${err.message}`)
        );
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

    // Get log level safely
    const logLevelValue = safeGetLogLevel(state, todos);
    todos.push(() => logInfo(state, {}, `Log level set to: ${logLevelValue}`));

    // Always add console target
    targets.push(createConsoleTarget(logLevelValue));

    // Try to add file target if possible
    const logFilePath = safeGetLogFilePath(state, todos);
    if (logFilePath) {
        todos.push(() =>
            logInfo(state, {}, `Log file path set to: ${logFilePath}`)
        );
        const fileTarget = await createFileTarget(state, logFilePath, todos);
        if (fileTarget) {
            targets.push(fileTarget);
        }
    }

    // Create the transport with available targets
    const transport = pino.transport({
        targets: targets,
    });

    // Initialize the logger and record in state
    state.logger = pino({ level: logLevelValue }, transport);
    state.logLevel = logLevelValue;
    state.logFile = logFilePath;

    // Execute all collected todos.
    for (const todo of todos) {
        todo();
    }
}

/**
 * @param {LoggerState} state - The logger state.
 * @param {unknown} obj The error object, message string, or object with error details
 * @param {string} msg
 * @returns {void}
 */
function logError(state, obj, msg) {
    // Call the original error method with proper typing
    if (state.logger !== null) {
        state.logger.error(msg, { obj });
    } else {
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.error(msg, { obj });
    }

    // Send notification
    state.capabilities?.notifier.notifyAboutError(msg).catch((err) => {
        if (state.logger !== null) {
            state.logger.error("Failed to send error notification", {
                error: err,
            });
        } else {
            // Fallback to console if logger is not initialized
            console.error("Logger not initialized");
            console.error("Failed to send error notification", { error: err });
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
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.warn(msg, { obj });
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
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.info(msg, { obj });
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
        // Fallback to console if logger is not initialized
        console.error("Logger not initialized");
        console.debug(msg, { obj });
    }
}

/** @typedef {ReturnType<make>} Logger */

/**
 * Factory returning a Logger interface bound to its state.
 * @param {() => Capabilities} getCapabilities - A function to get the capabilities.
 */
function make(getCapabilities) {
    /** @type {LoggerState} */
    const state = {
        logger: null,
        logLevel: "debug",
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

    return {
        enableHttpCallsLogging: enableWrapper,
        setup: setupWrapper,
        logError: errorWrapper,
        logWarning: warnWrapper,
        logInfo: infoWrapper,
        logDebug: debugWrapper,
    };
}

module.exports = {
    make,
};
