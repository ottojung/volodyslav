/**
 * The transport-neutral `InstallationRecoverySource` and the §4 absent-state
 * decision, `database-lifecycle.md` §4.
 *
 * §4 makes the completely absent local database the one external-loss case, and
 * makes its recovery a decision rather than a fallback: startup queries a
 * transport-neutral `InstallationRecoverySource`, and the answer is exactly one
 * of `Exists(ContinuationSafeSnapshot)`, `DefinitelyAbsent`, or
 * `IndeterminateOrError`. Only definite absence permits fresh creation; an
 * indeterminate or failed query is fatal and never falls back to fresh creation
 * or to a synchronization from an empty local database.
 *
 * The source is an abstraction carried on the capabilities as deployment
 * configuration, exactly like the cohort bootstrap source: the concrete
 * transport which answers the query is supplied by the deployment, and this
 * module owns only the decision vocabulary and the receiver-less restore which
 * materializes a held snapshot into a fresh local database.
 */

const {
    isAuthorityTime,
    isJournalAuthor,
    isJournalFrontier,
    isJournalRecord,
    isJournalSequence,
    isPlainRecord,
    isProjection,
    journalAuthorToString,
    makeJournalPublicationError,
} = require("./journal");
const { GRAPH_SCHEME_KEY, LAST_NODE_INDEX_KEY } = require("./database");
const { getRootDatabase } = require("./database");
const { planSyncPublication } = require("./journal_publish");

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('./journal/records').JournalRecord} JournalRecord */
/** @typedef {import('./journal/emission').CommittedWriterState} CommittedWriterState */
/** @typedef {import('./journal/oracle/projection').Projection} Projection */
/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').DatabaseCapabilities} DatabaseCapabilities */

/**
 * The fields a continuation-safe recovery snapshot is validated from.
 *
 * The fields are typed with the branded types a snapshot carries, matching the
 * `makeCanonicalBootstrapSnapshot` pattern: the runtime validation re-checks each
 * field so a value decoded from a transport is still refused when it is absent or
 * ill-typed, while the typedef lets the constructor accept the validated shape.
 *
 * @typedef {object} ContinuationSafeSnapshotFields
 * @property {JournalAuthor} localWriter
 * @property {ReadonlyArray<JournalRecord>} records
 * @property {Projection} projection
 * @property {CommittedWriterState} writerState
 * @property {string} databaseVersion
 * @property {string} graphSchemeString
 */

/**
 * A held recovery snapshot which is continuation-safe at its frontier.
 *
 * The properties that this class carries are:
 * - `localWriter` is the continuing installation identity the restore adopts;
 * - `records` is the retained journal history to restore, already in one
 *   canonical current-format encoding;
 * - `projection` is exactly the projection those records lower to;
 * - `writerState` is the committed writer state the retained history leaves
 *   behind, so the restored database allocates its next own-writer coordinate
 *   over history it already holds;
 * - `databaseVersion` and `graphSchemeString` are the committed-pair metadata
 *   the snapshot was cut under, which the normal migration gate revalidates.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through these functions:
 *   - `makeContinuationSafeSnapshot(...)`: satisfies the properties because it
 *     validates every field against its type before constructing the value, and
 *     returns a `JournalError` instead of a snapshot when any field is absent
 *     or ill-typed.
 *
 * The `writerState` field carries a full `CommittedWriterState` (writer head,
 * committed frontier, authority high-water and allocator watermark), because the
 * restore lowers it through `planSyncPublication`, which serializes exactly that
 * shape into the journal state record.
 */
class ContinuationSafeSnapshotClass {
    /**
     * @param {JournalAuthor} localWriter
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {Projection} projection
     * @param {CommittedWriterState} writerState
     * @param {string} databaseVersion
     * @param {string} graphSchemeString
     */
    constructor(localWriter, records, projection, writerState, databaseVersion, graphSchemeString) {
        this.localWriter = localWriter;
        this.records = records;
        this.projection = projection;
        this.writerState = writerState;
        this.databaseVersion = databaseVersion;
        this.graphSchemeString = graphSchemeString;
        Object.freeze(this);
    }
}

/** @typedef {ContinuationSafeSnapshotClass} ContinuationSafeSnapshot */

/**
 * @param {unknown} value
 * @returns {value is ContinuationSafeSnapshot}
 */
function isContinuationSafeSnapshot(value) {
    return value instanceof ContinuationSafeSnapshotClass;
}

/**
 * Validate and construct one continuation-safe recovery snapshot.
 *
 * @param {ContinuationSafeSnapshotFields} fields
 * @returns {ContinuationSafeSnapshot | JournalError}
 */
function makeContinuationSafeSnapshot(fields) {
    if (!isPlainRecord(fields)) {
        return makeJournalPublicationError("a continuation-safe snapshot is not an object");
    }
    for (const key of Object.keys(fields)) {
        if (key !== "localWriter" && key !== "records" && key !== "projection" &&
            key !== "writerState" && key !== "databaseVersion" && key !== "graphSchemeString") {
            return makeJournalPublicationError(
                "a continuation-safe snapshot carries the unknown field " + JSON.stringify(key)
            );
        }
    }
    if (!isJournalAuthor(fields.localWriter)) {
        return makeJournalPublicationError("a continuation-safe snapshot has no local writer");
    }
    if (!Array.isArray(fields.records) || !fields.records.every(isJournalRecord)) {
        return makeJournalPublicationError("a continuation-safe snapshot retains no journal records");
    }
    if (!isProjection(fields.projection)) {
        return makeJournalPublicationError("a continuation-safe snapshot carries no projection");
    }
    const state = fields.writerState;
    if (!isPlainRecord(state) || !isJournalAuthor(state.localWriter) ||
        !isJournalSequence(state.writerHead) || !isJournalFrontier(state.committedFrontier) ||
        !isAuthorityTime(state.authorityHighWater) || typeof state.allocatorWatermark !== "number") {
        return makeJournalPublicationError("a continuation-safe snapshot carries no committed writer state");
    }
    if (typeof fields.databaseVersion !== "string" || typeof fields.graphSchemeString !== "string") {
        return makeJournalPublicationError("a continuation-safe snapshot carries no committed-pair metadata");
    }
    return new ContinuationSafeSnapshotClass(
        fields.localWriter,
        fields.records,
        fields.projection,
        state,
        fields.databaseVersion,
        fields.graphSchemeString
    );
}

/**
 * `queryInstallationRecovery()` answered `Exists`.
 *
 * The properties that this class carries are:
 * - `snapshot` is a validated continuation-safe snapshot whose restore is
 *   authorized.
 *
 * The proof of those properties is guaranteed by:
 * - `observeInstallationRecovery(raw)`: produces this variant only from a value
 *   accepted by `isContinuationSafeSnapshot`, which holds only for the frozen
 *   instances built by `makeContinuationSafeSnapshot`.
 *
 * @param {ContinuationSafeSnapshot} snapshot
 */
class RecoveryExistsClass {
    /**
     * @param {ContinuationSafeSnapshot} snapshot
     */
    constructor(snapshot) {
        this.snapshot = snapshot;
        Object.freeze(this);
    }
}

/** @typedef {RecoveryExistsClass} RecoveryExists */

/**
 * @param {unknown} value
 * @returns {value is RecoveryExists}
 */
function isRecoveryExists(value) {
    return value instanceof RecoveryExistsClass;
}

/**
 * `queryInstallationRecovery()` answered `DefinitelyAbsent`.
 *
 * The properties that this class carries are:
 * - the installation definitely holds no recoverable synchronized state at the
 *   moment of the query, so fresh creation is allowed.
 *
 * The proof of those properties is guaranteed by:
 * - `observeInstallationRecovery(raw)`: produces this variant only from the
 *   explicit `null` absence token, which is neither a snapshot nor a failure.
 *
 * @extends {undefined}
 */
class RecoveryDefinitelyAbsentClass {
    /**
     * @returns {never}
     */
    delete() {
        throw new Error("RecoveryDefinitelyAbsent is immutable");
    }

    /**
     * @returns {never}
     */
    clear() {
        throw new Error("RecoveryDefinitelyAbsent is immutable");
    }
}

/** @typedef {RecoveryDefinitelyAbsentClass} RecoveryDefinitelyAbsent */

/** The one absence answer a recovery source can give. */
const RECOVERY_DEFINITELY_ABSENT = new RecoveryDefinitelyAbsentClass();
Object.freeze(RECOVERY_DEFINITELY_ABSENT);

/**
 * @param {unknown} value
 * @returns {value is RecoveryDefinitelyAbsent}
 */
function isRecoveryDefinitelyAbsent(value) {
    return value instanceof RecoveryDefinitelyAbsentClass;
}

/**
 * The recovery query outcome is unknown or failed.
 *
 * The properties that this class carries are:
 * - the installation's recoverable state is **not** known, so startup must fail
 *   and must not create fresh state or synchronize from an empty local database.
 *
 * The proof of those properties is guaranteed by:
 * - `observeInstallationRecovery(raw)`: every unrecognized transport result,
 *   every thrown value and every failure the transport reports as an error
 *   becomes this variant, so no path through this module can read an unknown
 *   outcome as an absence or as a selection.
 *
 * @param {string} detail
 */
class RecoveryIndeterminateClass {
    /**
     * @param {string} detail
     */
    constructor(detail) {
        this.detail = detail;
        Object.freeze(this);
    }
}

/** @typedef {RecoveryIndeterminateClass} RecoveryIndeterminate */

/**
 * @param {unknown} value
 * @returns {value is RecoveryIndeterminate}
 */
function isRecoveryIndeterminate(value) {
    return value instanceof RecoveryIndeterminateClass;
}

/**
 * The transport-neutral `InstallationRecoverySource`.
 *
 * The properties that this class carries are:
 * - `queryInstallationRecovery` observes whether recoverable synchronized state
 *   exists for this installation.
 *
 * The proof of those properties is guaranteed by:
 * - `makeInstallationRecoverySource(operations)`: accepts an operations object
 *   only when the member is a function, so every `InstallationRecoverySource`
 *   value answers the §4 query and it cannot be missing.
 *
 * @param {() => unknown} queryInstallationRecovery
 */
class InstallationRecoverySourceClass {
    /**
     * @param {() => unknown} queryInstallationRecovery
     */
    constructor(queryInstallationRecovery) {
        this.queryInstallationRecovery = queryInstallationRecovery;
        Object.freeze(this);
    }
}

/** @typedef {InstallationRecoverySourceClass} InstallationRecoverySource */

/**
 * @param {unknown} value
 * @returns {value is InstallationRecoverySource}
 */
function isInstallationRecoverySource(value) {
    return value instanceof InstallationRecoverySourceClass;
}

/**
 * Configure the installation recovery source from its transport-neutral
 * operation.
 * @param {object} operations
 * @param {() => unknown} operations.queryInstallationRecovery
 * @returns {InstallationRecoverySource | JournalError}
 */
function makeInstallationRecoverySource(operations) {
    if (!isPlainRecord(operations)) {
        return makeJournalPublicationError("an installation recovery source is not an object");
    }
    for (const key of Object.keys(operations)) {
        if (key !== "queryInstallationRecovery") {
            return makeJournalPublicationError(
                "an installation recovery source carries the unknown operation " + JSON.stringify(key)
            );
        }
    }
    if (typeof operations.queryInstallationRecovery !== "function") {
        return makeJournalPublicationError("an installation recovery source cannot observe recoverable state");
    }
    return new InstallationRecoverySourceClass(operations.queryInstallationRecovery);
}

/**
 * Describe a transport value in the vocabulary of §4 query results.
 * @param {unknown} raw
 * @returns {string}
 */
function describeRawResult(raw) {
    if (raw instanceof Error) {
        return raw.message;
    }
    if (isPlainRecord(raw)) {
        const detail = raw["detail"];
        if (typeof detail === "string") {
            return detail;
        }
    }
    return "the installation recovery source returned a value which is not a query result";
}

/**
 * Normalize one query result into exactly one §4 variant.
 *
 * The transport's absence token is `null`, a snapshot answers `Exists`, and a
 * thrown value, a reported error or anything unrecognized answers
 * `IndeterminateOrError`. Fail-closed is the point: §4.1 forbids treating an
 * unanswerable question as an answer, because doing so would let a completely
 * absent installation invent fresh state over recoverable synchronized history.
 *
 * @param {unknown} raw
 * @returns {RecoveryExists | RecoveryDefinitelyAbsent | RecoveryIndeterminate}
 */
function observeInstallationRecovery(raw) {
    if (isContinuationSafeSnapshot(raw)) {
        return new RecoveryExistsClass(raw);
    }
    if (raw === null) {
        return RECOVERY_DEFINITELY_ABSENT;
    }
    return new RecoveryIndeterminateClass(describeRawResult(raw));
}

/**
 * Ask the installation whether recoverable synchronized state exists,
 * normalizing the answer.
 * @param {InstallationRecoverySource} source
 * @returns {Promise<RecoveryExists | RecoveryDefinitelyAbsent | RecoveryIndeterminate>}
 */
async function queryInstallationRecovery(source) {
    if (!isInstallationRecoverySource(source)) {
        throw new Error("the installation recovery source is not a configured source");
    }
    try {
        return observeInstallationRecovery(await source.queryInstallationRecovery());
    } catch (error) {
        return observeInstallationRecovery(error);
    }
}

/**
 * The committed-pair metadata one restored snapshot installs.
 *
 * @param {ContinuationSafeSnapshot} snapshot
 * @param {SchemaStorage} target
 * @returns {Array<*>}
 */
function committedPairOperations(snapshot, target) {
    return [
        target.global.putOp("version", snapshot.databaseVersion),
        target.global.putOp(GRAPH_SCHEME_KEY, snapshot.graphSchemeString),
        target.global.putOp("fingerprint", journalAuthorToString(snapshot.localWriter)),
    ];
}

/**
 * Restore a completely absent installation from a held continuation-safe
 * snapshot, `database-lifecycle.md` §4.2.
 *
 * The restore is receiver-less: it does not synchronize from the snapshot or
 * reset a receiver to it, because there is no already-established writable
 * receiver identity to adopt. It materializes the snapshot's retained history
 * and projection into a fresh local database under the snapshot's own writer
 * identity, reconstructing the writer head, allocator watermark, authority
 * high-water and materialized graph the snapshot carries. The normal migration
 * and bootstrap gates then run over the restored database exactly as they would
 * over any other local database, so a snapshot cut at an older supported
 * Journal version is upgraded by the ordinary gate rather than by a
 * restore-specific path.
 *
 * The journal and projection are lowered through `planSyncPublication`, the one
 * place which knows how a projection becomes persisted graph bytes, so the
 * restored database's graph is exactly `project(records)` by the same rule a
 * synchronization or reset uses.
 *
 * @param {DatabaseCapabilities} capabilities
 * @param {ContinuationSafeSnapshot} snapshot
 * @returns {Promise<void>}
 */
async function restoreAbsentFrom(capabilities, snapshot) {
    if (!isContinuationSafeSnapshot(snapshot)) {
        throw makeJournalPublicationError("the recovery snapshot is not a continuation-safe snapshot");
    }
    const rootDatabase = await getRootDatabase(capabilities);
    try {
        const target = rootDatabase.getSchemaStorage();
        const outcome = {
            records: snapshot.records,
            projection: snapshot.projection,
            publication: { writerState: snapshot.writerState },
        };
        const operations = [
            ...await planSyncPublication({ target, outcome }),
            ...committedPairOperations(snapshot, target),
            // The committed writer state is the snapshot's own record of the
            // allocator watermark, so it is what the restore installs: the
            // watermark a projection reconstructs from retained writer-state
            // records is the greatest one the retained stream happens to state,
            // which is not the watermark the destroyed database held.
            target.global.putOp(LAST_NODE_INDEX_KEY, snapshot.writerState.allocatorWatermark),
        ];
        await target.batch(operations);
    } finally {
        await rootDatabase.close();
    }
}

module.exports = {
    isContinuationSafeSnapshot,
    isInstallationRecoverySource,
    isRecoveryDefinitelyAbsent,
    isRecoveryExists,
    isRecoveryIndeterminate,
    makeContinuationSafeSnapshot,
    makeInstallationRecoverySource,
    queryInstallationRecovery,
    restoreAbsentFrom,
};
