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
 * @typedef {import('../../../event').SerializedEvent} SerializedEvent
 */

/**
 * @typedef {import('../../../transcribe').Transcription} Transcription
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
 * @property {Array<SerializedEvent>} events - Array of serialized events
 */

/**
 * @typedef {object} ConfigEntry
 * @property {'config'} type - The type of the entry
 * @property {import('../../../config/structure').Config | null} config - The configuration or null if not found
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
 * Full structure of a single event, indexed by event ID.
 * @typedef {object} EventEntry
 * @property {'event'} type - The type of the entry
 * @property {SerializedEvent} value - The serialized event object
 */

/**
 * Basic context for a single event, indexed by event ID.
 * @typedef {object} BasicContextEntry
 * @property {'basic_context'} type - The type of the entry
 * @property {string} eventId - The event ID the context belongs to
 * @property {Array<SerializedEvent>} events - The serialized context events
 */

/**
 * Estimated calorie count for a single event.
 * @typedef {object} CaloriesEntry
 * @property {'calories'} type - The type of the entry
 * @property {number | 'N/A'} value - The estimated number of calories, or 'N/A' when not applicable
 */


/**
 * @typedef {object} TranscriptionError
 * @property {string} message
 */

/**
 * @typedef {Transcription | TranscriptionError} TranscriptionResult
 */

/**
 * AI transcription for a single asset path.
 * @typedef {object} TranscriptionEntry
 * @property {'transcription'} type - The type of the entry
 * @property {TranscriptionResult} value - The transcription payload
 */

/**
 * Combined event and transcription for a specific audio file associated with an event.
 * @typedef {object} EventTranscriptionEntry
 * @property {'event_transcription'} type - The type of the entry
 * @property {Event} event - The associated event
 * @property {TranscriptionResult} transcription - The AI transcription
 */

/**
 * Events sorted by date in descending order (most recent first).
 * @typedef {object} SortedEventsDescendingEntry
 * @property {'sorted_events_descending'} type - The type of the entry
 * @property {Array<SerializedEvent>} events - All serialized events sorted by date descending
 */

/**
 * Events sorted by date in ascending order (oldest first).
 * @typedef {object} SortedEventsAscendingEntry
 * @property {'sorted_events_ascending'} type - The type of the entry
 * @property {Array<SerializedEvent>} events - All serialized events sorted by date ascending
 */

/**
 * The first `n` events in descending date order (newest first).
 * A small, fast-to-read subset used to serve the first page of results
 * without pulling the full sorted list from the database.
 * `n` is stored alongside the events so callers can assert the binding.
 * @typedef {object} LastNEntriesEntry
 * @property {'last_entries'} type - The type of the entry
 * @property {number} n - The number of entries requested (binding value)
 * @property {Array<SerializedEvent>} events - At most n events, newest first
 */

/**
 * The first `n` events in ascending date order (oldest first).
 * A small, fast-to-read subset used to serve the first page of results
 * when ascending order is requested, without pulling the full sorted list.
 * `n` is stored alongside the events so callers can assert the binding.
 * @typedef {object} FirstNEntriesEntry
 * @property {'first_entries'} type - The type of the entry
 * @property {number} n - The number of entries requested (binding value)
 * @property {Array<SerializedEvent>} events - At most n events, oldest first
 */

/**
 * The total count of all events in the event log.
 * Derived directly from `all_events` so it is always in sync.
 * @typedef {object} EventsCountEntry
 * @property {'events_count'} type - The type of the entry
 * @property {number} count - Total number of events
 */

/**
 * The list of audio file paths associated with an event.
 * Computed by scanning the event's assets directory.
 * @typedef {object} EventAudiosListEntry
 * @property {'event_audios_list'} type - The type of the entry
 * @property {SerializedEvent} event - The serialized event these audio files belong to
 * @property {string[]} audioPaths - Sorted relative paths (relative to assets root) of audio files
 */

/**
 * The diary content for a specific (event, audio) pair.
 * Combines typed text from the event with transcribed audio recording text.
 * Returns "N/A" when the event is not a diary entry.
 * @typedef {object} EntryDiaryContentEntry
 * @property {'entry_diary_content'} type - The type of the entry
 * @property {{ typed_text: string | undefined, transcribed_audio_recording: string | undefined } | 'N/A'} value - The diary content
 */

/**
 * The rolling diary summary node. Stores the current structured markdown summary,
 * the max diary entry date incorporated, and a map of processed transcription paths
 * with their last-processed modification timestamps.
 * @typedef {object} DiaryMostImportantInfoSummaryEntry
 * @property {'diary_most_important_info_summary'} type - The type of the entry
 * @property {string} markdown - The current summary markdown
 * @property {string} summaryDate - ISO date of the max entry date incorporated
 * @property {Record<string, string>} processedTranscriptions - Map of relativeAssetPath to lastProcessedModificationTimeISO
 * @property {string} updatedAt - ISO timestamp of when this summary was last updated
 * @property {string} model - The model used for the last update
 * @property {string} version - Version string for the summary format
 */

/**
 * Database Value Disjoint Union Type
 * @typedef {AllEventsEntry | SortedEventsDescendingEntry | SortedEventsAscendingEntry | LastNEntriesEntry | FirstNEntriesEntry | EventsCountEntry | ConfigEntry | MetaEventsEntry | EventContextDatabaseEntry | EventEntry | BasicContextEntry | CaloriesEntry | TranscriptionEntry | EventTranscriptionEntry | EventAudiosListEntry | EntryDiaryContentEntry | DiaryMostImportantInfoSummaryEntry} ComputedValue
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
 * Record storing the creation and last-modification timestamps of a node.
 * Both timestamps are ISO 8601 strings (e.g. "2026-03-07T10:18:20.735Z").
 * @typedef {object} TimestampRecord
 * @property {string} createdAt - ISO string of when the node was first given a value
 * @property {string} modifiedAt - ISO string of when the node's value last changed
 */

/**
 * @typedef {ComputedValue | Freshness | InputsRecord | NodeKeyString[] | Counter | TimestampRecord} DatabaseStoredValue
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
 * @typedef {DatabasePutOperation<ComputedValue> | DatabasePutOperation<Freshness> | DatabasePutOperation<InputsRecord> | DatabasePutOperation<NodeKeyString[]> | DatabasePutOperation<Counter> | DatabasePutOperation<TimestampRecord> | DatabaseDelOperation<ComputedValue> | DatabaseDelOperation<Freshness> | DatabaseDelOperation<InputsRecord> | DatabaseDelOperation<NodeKeyString[]> | DatabaseDelOperation<Counter> | DatabaseDelOperation<TimestampRecord>} DatabaseBatchOperation
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
