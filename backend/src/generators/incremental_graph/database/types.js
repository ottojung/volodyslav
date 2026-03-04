/**
 * Type definitions for Database capabilities.
 */

/** @typedef {import('../../../filesystem/checker').FileChecker} FileChecker */
/** @typedef {import('../../../filesystem/creator').FileCreator} FileCreator */
/** @typedef {import('../../../filesystem/reader').FileReader} FileReader */
/** @typedef {import('../../../logger').Logger} Logger */
/** @typedef {import('../../../level_database').LevelDatabase} LevelDatabase */
/** @typedef {import('../../../environment').Environment} Environment */
/** @typedef {import('../../../subprocess/command').Command} Command */

/**
 * @template K, V
 * @typedef {import('level').Level<K, V>} Level
 */

/**
 * Capabilities needed for database operations
 * @typedef {object} DatabaseCapabilities
 * @property {FileChecker} checker - A file checker instance
 * @property {FileCreator} creator - A file creator instance
 * @property {FileReader} reader - A file reader instance
 * @property {Environment} environment - An environment instance
 * @property {Logger} logger - A logger instance
 * @property {LevelDatabase} levelDatabase - A level database instance
 * @property {Command} git - A command instance for Git operations.
 */

class VersionClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;
    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("Version cannot be instantiated");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is Version}
 */
function castToVersion(_value) {
    return true;
}

/**
 * @param {string} VersionStr 
 * @returns {Version}
 */
function stringToVersion(VersionStr) {
    if (castToVersion(VersionStr)) {
        return VersionStr;
    }
    throw new Error("Invalid version string");
}

/**
 * @param {Version} Version
 * @returns {string}
 */
function versionToString(Version) {
    if (typeof Version === "string") {
        return Version;
    }
    throw new Error("Invalid version type");
}

/**
 * @typedef {VersionClass} Version
 */

/**
 * @typedef {import('../../../event').Event} Event
 */

/**
 * @typedef {import('../../individual/meta_events').MetaEvent} MetaEvent
 */

/**
 * @typedef {import('../../individual/event_context/compute').EventContextEntry} ContextEntry
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
 * Raw input text of a single event.
 * @typedef {object} InputEntry
 * @property {'input'} type - The type of the entry
 * @property {string} value - The raw input text of the event
 */

/**
 * Estimated calorie count for a single event.
 * @typedef {object} CaloriesEntry
 * @property {'calories'} type - The type of the entry
 * @property {number} value - The estimated number of calories
 */

/**
 * Database Value Disjoint Union Type
 * @typedef {AllEventsEntry | MetaEventsEntry | EventContextDatabaseEntry | InputEntry | CaloriesEntry} ComputedValue
 */

/**
 * Freshness state for a database value
 * @typedef {'up-to-date' | 'potentially-outdated'} Freshness
 */

/**
 * Counter for tracking node value changes.
 * A monotonic integer that increments when the persisted value changes.
 * @typedef {number} Counter
 */

/**
 * @typedef {ComputedValue | Freshness | InputsRecord | NodeKeyString[] | Counter} DatabaseStoredValue
 */

/**
 * A database put operation.
 * @template T
 * @typedef {{ type: 'put', sublevel: SimpleSublevel<T>, key: DatabaseKey, value: T }} DatabasePutOperation
 */

/**
 * A database delete operation.
 * @template T
 * @typedef {{ type: 'del', sublevel: SimpleSublevel<T>, key: DatabaseKey }} DatabaseDelOperation
 */

/**
 * @template L, K, V
 * @typedef {import('abstract-level').AbstractBatchPutOperation<L, K, V>} AbstractBatchPutOperation
 */

/**
 * @template L, K
 * @typedef {import('abstract-level').AbstractBatchDelOperation<L, K>} AbstractBatchDelOperation
 */

/**
 * A batch operation for the database.
 * @typedef {DatabasePutOperation<ComputedValue> | DatabasePutOperation<Freshness> | DatabasePutOperation<InputsRecord> | DatabasePutOperation<NodeKeyString[]> | DatabasePutOperation<Counter> | DatabaseDelOperation<ComputedValue> | DatabaseDelOperation<Freshness> | DatabaseDelOperation<InputsRecord> | DatabaseDelOperation<NodeKeyString[]> | DatabaseDelOperation<Counter>} DatabaseBatchOperation
 */

/**
 * A record storing the input dependencies of a node and their counters.
 * @typedef {object} InputsRecord
 * @property {string[]} inputs - Array of canonical input node names
 * @property {number[]} inputCounters - Array of counter values for each input (required when inputs.length > 0)
 */

class SchemaPatternClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;
    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("SchemaPattern cannot be instantiated");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is SchemaPattern}
 */
function castToSchemaPattern(_value) {
    return true;
}

/**
 * @param {string} schemaPatternStr 
 * @returns {SchemaPattern}
 */
function stringToSchemaPattern(schemaPatternStr) {
    if (castToSchemaPattern(schemaPatternStr)) {
        return schemaPatternStr;
    }
    throw new Error("Invalid schema pattern string");
}

/**
 * @param {SchemaPattern} schemaPattern
 * @returns {string}
 */
function schemaPatternToString(schemaPattern) {
    if (typeof schemaPattern === "string") {
        return schemaPattern;
    }
    throw new Error("Invalid schema pattern type");
}

/**
 * An expression string pattern used in node definitions.
 * @typedef {SchemaPatternClass} SchemaPattern
 */

class NodeKeyStringClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;
    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("NodeKeyString cannot be instantiated");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is NodeKeyString}
 */
function castToNodeKeyString(_value) {
    return true;
}

/**
 * @param {string} nodeKeyStr 
 * @returns {NodeKeyString}
 */
function stringToNodeKeyString(nodeKeyStr) {
    if (castToNodeKeyString(nodeKeyStr)) {
        return nodeKeyStr;
    }
    throw new Error("Invalid node key string");
}

/**
 * @param {NodeKeyString} nodeKeyString
 * @returns {string}
 */
function nodeKeyStringToString(nodeKeyString) {
    if (typeof nodeKeyString === "string") {
        return nodeKeyString;
    }
    throw new Error("Invalid node key string type");
}

/**
 * A serialized node key string for storage.
 * @typedef {NodeKeyStringClass} NodeKeyString
 */

class NodeNameClass {
    /**
     * @private
     * @type {undefined}
     */
    __brand;
    constructor() {
        if (this.__brand !== undefined) {
            throw new Error("NodeName cannot be instantiated");
        }
    }
}

/**
 * @param {string} _value
 * @returns {_value is NodeName}
 */
function castToNodeName(_value) {
    return true;
}

/**
 * @param {string} nodeNameStr 
 * @returns {NodeName}
 */
function stringToNodeName(nodeNameStr) {
    if (castToNodeName(nodeNameStr)) {
        return nodeNameStr;
    }
    throw new Error("Invalid node name string");
}

/**
 * @param {NodeName} nodeName
 * @returns {string}
 */
function nodeNameToString(nodeName) {
    if (typeof nodeName === "string") {
        return nodeName;
    }
    throw new Error("Invalid node name type");
}

/**
 * The head/functor part of SchemaPattern.
 * @typedef {NodeNameClass} NodeName
 */

/**
 * @template F
 * @template K
 * @template V
 * @typedef {import('abstract-level').AbstractLevel<F, K, V>} AbstractLevel
 */

/**
 * @template D
 * @template F
 * @template K
 * @template V
 * @typedef {import('abstract-level').AbstractSublevel<D, F, K, V>} AbstractSublevel
 */

/** 
 * @typedef {NodeKeyString} DatabaseKey
 */

/**
 * @typedef {string | Buffer<ArrayBufferLike> | Uint8Array<ArrayBufferLike>} SublevelFormat
 */

/**
 * @typedef {Level<DatabaseKey, DatabaseStoredValue>} RootLevelType
 */

/**
 * @typedef {AbstractSublevel<RootLevelType, SublevelFormat, DatabaseKey, DatabaseStoredValue>} SchemaSublevelType
 */

/**
 * @template T
 * @typedef {AbstractSublevel<AbstractSublevel<RootLevelType, SublevelFormat, DatabaseKey, DatabaseStoredValue>, SublevelFormat, DatabaseKey, T>} SimpleSublevel
 */

module.exports = {
    versionToString,
    stringToVersion,
    VersionClass,
    nodeNameToString,
    stringToNodeName,
    NodeNameClass,
    nodeKeyStringToString,
    stringToNodeKeyString,
    NodeKeyStringClass,
    schemaPatternToString,
    stringToSchemaPattern,
    SchemaPatternClass,
};
