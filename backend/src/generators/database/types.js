/**
 * Type definitions for Database capabilities.
 */

/** @typedef {import('../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../logger').Logger} Logger */

/**
 * Environment with pathToVolodyslavDataDirectory method
 * @typedef {object} DatabaseEnvironment
 * @property {() => string} pathToVolodyslavDataDirectory - Get path to Volodyslav data directory
 */

/**
 * Capabilities needed for database operations
 * @typedef {object} DatabaseCapabilities
 * @property {FileChecker} checker - A file checker instance
 * @property {FileCreator} creator - A file creator instance
 * @property {DatabaseEnvironment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 */

/**
 * @typedef {import('../../event').Event} Event
 */

/**
 * @typedef {import('../individual/meta_events').MetaEvent} MetaEvent
 */

/**
 * @typedef {import('../individual/event_context/compute').EventContextEntry} ContextEntry
 */

/**
 * @typedef {object} AllEventsEntry
 * @property {'all_events'} type - The type of the entry
 * @property {Array<Event>} events - Array of events
 */

/**
 * @typedef {object} MetaEventsEntry
 * @property {'meta_events'} type - The type of the entry
 * @property {Array<MetaEvent>} meta_events - Array of meta events
 */

/**
 * @typedef {object} EventContextDatabaseEntry
 * @property {'event_context'} type - The type of the entry
 * @property {Array<ContextEntry>} contexts - Array of event contexts
 */

/**
 * Database Value Disjoint Union Type
 * @typedef {AllEventsEntry | MetaEventsEntry | EventContextDatabaseEntry} DatabaseValue
 */

/**
 * Version number for tracking value changes.
 * Version increments when a node's value changes.
 * @typedef {number} Version
 */

/**
 * Dependency versions snapshot with explicit type marker.
 * Maps dependency keys to their version numbers at the time of computation.
 * @typedef {object} DependencyVersions
 * @property {'dependency_versions'} __type - Type marker for dependency versions
 * @property {Record<string, Version>} versions - Map of dependency keys to versions
 */

/**
 * Freshness state for a database value.
 * Used to track if a node might need recomputation.
 * @typedef {'up-to-date' | 'potentially-outdated'} Freshness
 */

/**
 * Constructs the version key for a given database key.
 * @param {string} key - The database key
 * @returns {string} The version key
 */
function versionKey(key) {
    return `version(${key})`;
}

/**
 * Constructs the freshness key for a given database key.
 * @param {string} key - The database key
 * @returns {string} The freshness key
 */
function freshnessKey(key) {
    return `freshness(${key})`;
}

/**
 * Constructs the dependency versions key for a given database key.
 * @param {string} key - The database key
 * @returns {string} The dependency versions key
 */
function depVersionsKey(key) {
    return `dep_versions(${key})`;
}

/**
 * Creates a DependencyVersions object.
 * @param {Record<string, Version>} versions - Map of dependency keys to versions
 * @returns {DependencyVersions}
 */
function makeDependencyVersions(versions) {
    return {
        __type: "dependency_versions",
        versions,
    };
}

/**
 * Type guard to check if a value is a Version.
 * @param {unknown} value
 * @returns {value is Version}
 */
function isVersion(value) {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

/**
 * Type guard to check if a value is a Freshness state.
 * @param {unknown} value
 * @returns {value is Freshness}
 */
function isFreshness(value) {
    return value === "up-to-date" || value === "potentially-outdated";
}

/**
 * Type guard to check if a value is DependencyVersions.
 * @param {unknown} value
 * @returns {value is DependencyVersions}
 */
function isDependencyVersions(value) {
    if (value === null || value === undefined || typeof value !== "object") {
        return false;
    }
    // Check for type marker
    if (!("__type" in value) || value["__type"] !== "dependency_versions") {
        return false;
    }
    // Check versions field exists and all values are valid versions
    if (!("versions" in value) || typeof value["versions"] !== "object") {
        return false;
    }
    const versions = value["versions"];
    if (versions === null) {
        return false;
    }
    for (const v of Object.values(versions)) {
        if (!isVersion(v)) {
            return false;
        }
    }
    return true;
}

/**
 * Type guard to check if a value is a DatabaseValue.
 * Since DatabaseValue is a union of specific object types, we check if it's
 * an object and not a Version, DependencyVersions, or Freshness string.
 * @param {unknown} value
 * @returns {value is DatabaseValue}
 */
function isDatabaseValue(value) {
    return (
        value !== null &&
        value !== undefined &&
        typeof value === "object" &&
        !isVersion(value) &&
        !isDependencyVersions(value) &&
        !isFreshness(value)
    );
}

module.exports = {
    versionKey,
    freshnessKey,
    depVersionsKey,
    makeDependencyVersions,
    isVersion,
    isFreshness,
    isDependencyVersions,
    isDatabaseValue,
};
