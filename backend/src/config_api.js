const { transaction } = require("./event_log_storage");

/** @typedef {import('./filesystem/deleter').FileDeleter} FileDeleter */
/** @typedef {import('./random/seed').NonDeterministicSeed} NonDeterministicSeed */
/** @typedef {import('./filesystem/copier').FileCopier} FileCopier */
/** @typedef {import('./filesystem/writer').FileWriter} FileWriter */
/** @typedef {import('./filesystem/appender').FileAppender} FileAppender */
/** @typedef {import('./filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('./filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('./subprocess/command').Command} Command */
/** @typedef {import('./environment').Environment} Environment */
/** @typedef {import('./logger').Logger} Logger */
/** @typedef {import('./sleeper').SleepCapability} SleepCapability */

/**
 * @typedef {object} Capabilities
 * @property {NonDeterministicSeed} seed - A random number generator instance.
 * @property {FileDeleter} deleter - A file deleter instance.
 * @property {FileCopier} copier - A file copier instance.
 * @property {FileWriter} writer - A file writer instance.
 * @property {FileAppender} appender - A file appender instance.
 * @property {FileCreator} creator - A directory creator instance.
 * @property {FileChecker} checker - A file checker instance.
 * @property {Command} git - A command instance for Git operations.
 * @property {Environment} environment - An environment instance.
 * @property {Logger} logger - A logger instance.
 * @property {import('./filesystem/reader').FileReader} reader - A file reader instance.
 * @property {import('./datetime').Datetime} datetime - Datetime utilities.
 * @property {SleepCapability} sleeper - A sleeper instance.
 */

/**
 * Retrieves the current configuration from the event log.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {Promise<import('./config/structure').Config | null>} - The current config or null if not found.
 */
async function getConfig(capabilities) {
    const config = await transaction(capabilities, async (storage) => {
        return await storage.getExistingConfig();
    });

    capabilities.logger.logDebug(
        {
            configExists: config !== null,
            shortcutCount: config?.shortcuts?.length || 0,
        },
        `Retrieved config: ${config ? 'found' : 'not found'} with ${config?.shortcuts?.length || 0} shortcuts`
    );

    return config;
}

/**
 * Saves a new configuration to the event log.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {import('./config/structure').Config} config - The new config to save.
 * @returns {Promise<void>}
 */
async function setConfig(capabilities, config) {
    await transaction(capabilities, async (storage) => {
        storage.setConfig(config);
    });

    capabilities.logger.logInfo(
        {
            shortcutCount: config.shortcuts.length,
        },
        `Saved config with ${config.shortcuts.length} shortcuts`
    );
}

module.exports = { getConfig, setConfig };
