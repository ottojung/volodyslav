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
 * @property {import('./generators').Interface} interface - The incremental graph interface capability.
 */

/**
 * Retrieves the current ontology from the event log.
 * Always returns an Ontology (empty by default when none has been saved).
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @returns {Promise<import('./ontology/structure').Ontology>} - The current ontology.
 */
async function getOntology(capabilities) {
    const ontology = await capabilities.interface.getOntology();

    capabilities.logger.logDebug(
        {
            typeCount: ontology.types.length,
            modifierCount: ontology.modifiers.length,
        },
        `Retrieved ontology with ${ontology.types.length} types and ${ontology.modifiers.length} modifiers`
    );

    return ontology;
}

/**
 * Saves a new ontology to the event log.
 *
 * @param {Capabilities} capabilities - An object containing the capabilities.
 * @param {import('./ontology/structure').Ontology} ontology - The new ontology to save.
 * @returns {Promise<void>}
 */
async function setOntology(capabilities, ontology) {
    await capabilities.interface.setOntology(ontology);

    capabilities.logger.logInfo(
        {
            typeCount: ontology.types.length,
            modifierCount: ontology.modifiers.length,
        },
        `Saved ontology with ${ontology.types.length} types and ${ontology.modifiers.length} modifiers`
    );
}

module.exports = { getOntology, setOntology };
