/**
 * The canonical bootstrap artifact, `incremental-graph-journal-migrations.md` §3.
 *
 * The artifact is the **original frozen bootstrap cut**, not an arbitrary current
 * Journal snapshot, so it is represented here as a single-writer cut which is
 * replayable under its own stored version and schema and exposes no later
 * history. Holding one is a proof-carrying value: because the constructor
 * validates well-formedness, causal closure and exact frontier agreement, every
 * later pass may read the artifact's records without re-deciding whether they are
 * intelligible.
 *
 * `incremental-graph-journal-migrations.md` §3 supports joining an artifact only
 * on exact equality of its version and graph scheme with the running release's
 * configured bootstrap target, so `artifactSupportsBootstrapTarget` is the
 * admission check and it fails `JournalVersionCompatibilityError` rather than
 * adapting an artifact to the running release.
 *
 * This module is pure. It reads no clock and performs no I/O.
 */

const {
    makeJournalRecordValidationError,
    makeJournalVersionCompatibilityError,
} = require("../errors");
const {
    compareJournalSequence,
    isJournalAuthor,
    journalAuthorToString,
    isJournalFrontier,
    journalSequenceAtFrontier,
    makeJournalFrontier,
    makeJournalSequence,
    isJournalSequence,
} = require("../types");
const { isJournalRecord } = require("../records");
const { makeJournalReplica, replicaFrontier } = require("../replica");
const { validateJournalReplica } = require("../well_formedness");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../records').JournalRecord} JournalRecord */
/** @typedef {import('../types').JournalAuthor} JournalAuthor */
/** @typedef {import('../types').JournalFrontier} JournalFrontier */
/** @typedef {import('../types').JournalRecordId} JournalRecordId */
/** @typedef {import('../types').JournalSequence} JournalSequence */
/** @typedef {import('../replica').JournalReplica} JournalReplica */
/** @typedef {import('../../database/types').Version} Version */

/**
 * The sequence a caller named, or the reason the name is not a coordinate.
 *
 * A coordinate which is not canonical is an error rather than an absent
 * coordinate, because `incremental-graph-journal-api.md` snapshot law 4 forbids a
 * range from silently skipping coordinates: a caller that named `junk` must learn
 * that it named nothing, not that the cut holds nothing at that coordinate.
 *
 * @param {JournalSequence | string} value
 * @returns {JournalSequence | JournalError}
 */
function namedSequence(value) {
    if (isJournalSequence(value)) {
        return value;
    }
    return makeJournalSequence(value);
}

/**
 * Whether a caller named the single writer which authored this cut.
 * @param {JournalAuthor} creatorWriter
 * @param {JournalAuthor | string} author
 * @returns {boolean}
 */
function isOwnWriter(creatorWriter, author) {
    const named = isJournalAuthor(author) ? author : undefined;
    return named !== undefined && journalAuthorToString(named) === journalAuthorToString(creatorWriter);
}

/**
 * Whether a value is the exact database version text a bootstrap target names, so
 * that a cut always carries a version to compare rather than an absent value.
 * @param {unknown} value
 * @returns {boolean}
 */
function isDatabaseVersionText(value) {
    return typeof value === "string" && value.length > 0;
}

/**
 * The cut's record at one own-writer coordinate, or `undefined` when the cut does
 * not contain that coordinate.
 * @param {JournalAuthor} creatorWriter
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {JournalAuthor | string} author
 * @param {JournalSequence | string} sequence
 * @returns {JournalRecord | undefined | JournalError}
 */
function ownWriterRecord(creatorWriter, records, author, sequence) {
    if (!isOwnWriter(creatorWriter, author)) {
        return undefined;
    }
    const wanted = namedSequence(sequence);
    if (wanted instanceof Error) {
        return wanted;
    }
    return records.find((record) => compareJournalSequence(record.id.sequence, wanted) === 0);
}

/**
 * The immutable original bootstrap cut published for one cohort.
 *
 * The properties that this class carries are:
 * - `records` is exactly the canonical bootstrap cut: one causally closed
 *   own-writer prefix starting at sequence 1, and no later history;
 * - `creatorWriter` is the writer which authored every record in it, and it is the
 *   Journal `JournalAuthor` the canonical creator used for its existing durable
 *   `DatabaseFingerprint`;
 * - `bootstrapFrontier` is the creator frontier immediately after those records
 *   and before any ordinary post-bootstrap operation;
 * - `databaseVersion` and `graphSchemeString` are the bootstrap target this cut was
 *   authored under, which `artifactSupportsBootstrapTarget` compares exactly.
 *
 * The proof of those properties is guaranteed by:
 * - `makeCanonicalBootstrapSnapshot(request)`: builds a `JournalReplica` from the
 *   supplied records, so contiguity and writer-state monotonicity hold;
 *   `validateJournalReplica` then proves there are no holes, forks or dangling
 *   references and that the cut is causally closed; the constructor rejects a cut
 *   naming more than one writer, requires `bootstrapFrontier` to equal the replica
 *   frontier, and requires every record's author to be `creatorWriter`. It also
 *   requires an exact non-empty `databaseVersion` string and a non-empty
 *   `graphSchemeString`, so `artifactSupportsBootstrapTarget` and
 *   `publishedArtifactIsStagedCandidate` compare two versions rather than one
 *   version and an absent value.
 *
 * @param {ReadonlyArray<JournalRecord>} records
 * @param {JournalAuthor} creatorWriter
 * @param {JournalFrontier} bootstrapFrontier
 * @param {Version} databaseVersion
 * @param {string} graphSchemeString
 */
class CanonicalBootstrapSnapshotClass {
    /**
     * @param {ReadonlyArray<JournalRecord>} records
     * @param {JournalAuthor} creatorWriter
     * @param {JournalFrontier} bootstrapFrontier
     * @param {Version} databaseVersion
     * @param {string} graphSchemeString
     */
    constructor(records, creatorWriter, bootstrapFrontier, databaseVersion, graphSchemeString) {
        this.records = Object.freeze(records.slice());
        this.creatorWriter = creatorWriter;
        this.bootstrapFrontier = bootstrapFrontier;
        this.databaseVersion = databaseVersion;
        this.graphSchemeString = graphSchemeString;
        Object.freeze(this);
    }

    /**
     * The record at an own-writer coordinate of the cut, or `undefined` when the
     * cut does not contain that coordinate. A coordinate which is not a canonical
     * coordinate is an error, so a caller cannot mistake a malformed name for an
     * absent record (`incremental-graph-journal-api.md` snapshot law 4).
     * @param {JournalAuthor | string} author
     * @param {JournalSequence | string} sequence
     * @returns {JournalRecord | undefined | JournalError}
     */
    get(author, sequence) {
        return ownWriterRecord(this.creatorWriter, this.records, author, sequence);
    }

    /**
     * Iterate the cut after an exclusive own-writer coordinate, through an
     * inclusive one. An absent exclusive coordinate starts at the beginning of
     * the cut, which is frontier zero. A range which names a coordinate that is
     * not canonical is an error instead of an iterable, so a range never silently
     * skips coordinates (`incremental-graph-journal-api.md` snapshot law 4).
     * @param {JournalAuthor | string} author
     * @param {JournalSequence | string | undefined} afterExclusive
     * @param {JournalSequence | string} throughInclusive
     * @returns {AsyncIterable<JournalRecord> | JournalError}
     */
    iterate(author, afterExclusive, throughInclusive) {
        const through = namedSequence(throughInclusive);
        if (through instanceof Error) {
            return through;
        }
        const after =
            afterExclusive === undefined ? undefined : namedSequence(afterExclusive);
        if (after instanceof Error) {
            return after;
        }
        const records = !isOwnWriter(this.creatorWriter, author)
            ? []
            : this.records.filter((record) => {
                      const own = record.id.sequence;
                  if (after !== undefined && compareJournalSequence(own, after) <= 0) {
                      return false;
                  }
                  return compareJournalSequence(own, through) <= 0;
              });
        return {
            [Symbol.asyncIterator]: async function* () {
                for (const record of records) {
                    yield record;
                }
            },
        };
    }
}

/** @typedef {CanonicalBootstrapSnapshotClass} CanonicalBootstrapSnapshot */

/**
 * @param {unknown} value
 * @returns {value is CanonicalBootstrapSnapshot}
 */
function isCanonicalBootstrapSnapshot(value) {
    return value instanceof CanonicalBootstrapSnapshotClass;
}

/**
 * @typedef {object} CanonicalBootstrapSnapshotRequest
 * @property {ReadonlyArray<JournalRecord>} records - The bootstrap cut to hold.
 * @property {JournalAuthor} creatorWriter - The writer which authored every record.
 * @property {JournalFrontier} bootstrapFrontier - The creator frontier immediately
 *   after the cut.
 * @property {Version} databaseVersion - The bootstrap target the cut was authored under.
 * @property {string} graphSchemeString - The graph scheme the cut was authored under.
 */

/**
 * Hold an immutable canonical bootstrap cut, or report why it cannot be held.
 *
 * The frontier is not taken from the caller's belief about the cut: it must equal
 * the frontier the records themselves describe, because §3 requires the artifact to
 * expose exactly the records through `bootstrapFrontier` and no later history.
 *
 * @param {CanonicalBootstrapSnapshotRequest} request
 * @returns {CanonicalBootstrapSnapshot | JournalError}
 */
function makeCanonicalBootstrapSnapshot(request) {
    const { records, creatorWriter, bootstrapFrontier, databaseVersion, graphSchemeString } = request;
    if (!Array.isArray(records) || records.length === 0) {
        return makeJournalRecordValidationError("a canonical bootstrap cut is not an empty record set", "unknown");
    }
    for (const record of records) {
        if (!isJournalRecord(record)) {
            return makeJournalRecordValidationError("a canonical bootstrap cut holds something which is not a record", "unknown");
        }
    }
    if (!isJournalAuthor(creatorWriter)) {
        return makeJournalRecordValidationError("a canonical bootstrap cut names no journal creator", "unknown");
    }
    if (!isJournalFrontier(bootstrapFrontier)) {
        return makeJournalRecordValidationError("a canonical bootstrap cut names no bootstrap frontier", "unknown");
    }
    if (!isDatabaseVersionText(databaseVersion)) {
        return makeJournalRecordValidationError("a canonical bootstrap cut persists no database version", "unknown");
    }
    if (typeof graphSchemeString !== "string" || graphSchemeString.length === 0) {
        return makeJournalRecordValidationError("a canonical bootstrap cut persists no graph scheme string", "unknown");
    }
    const creatorName = journalAuthorToString(creatorWriter);
    for (const record of records) {
        const authorName = journalAuthorToString(record.id.author);
        if (authorName !== creatorName) {
            return makeJournalRecordValidationError(
                "a canonical bootstrap cut records the foreign writer " + authorName + ", which a single-writer cut cannot hold",
                authorName
            );
        }
    }
    const replica = makeJournalReplica([[creatorWriter, records]]);
    if (replica instanceof Error) {
        return replica;
    }
    const wellFormed = validateJournalReplica(replica);
    if (wellFormed !== undefined) {
        return wellFormed;
    }
    const reached = replicaFrontier(replica);
    const described = makeJournalFrontier([[creatorWriter, journalSequenceAtFrontier(bootstrapFrontier, creatorWriter)]]);
    if (described instanceof Error) {
        return described;
    }
    const reachedText = JSON.stringify([...reached]);
    const describedText = JSON.stringify([...described]);
    if (reachedText !== describedText) {
        return makeJournalRecordValidationError(
            "a canonical bootstrap cut claims the bootstrap frontier " +
                describedText +
                " while its records reach " +
                reachedText +
                ", so the frontier is not a function of the cut it holds",
            creatorName
        );
    }
    return new CanonicalBootstrapSnapshotClass(
        records,
        creatorWriter,
        reached,
        databaseVersion,
        graphSchemeString
    );
}

/**
 * @typedef {object} BootstrapTarget
 * @property {Version} databaseVersion - The running release's configured bootstrap target version.
 * @property {string} graphSchemeString - The running release's configured bootstrap target graph scheme.
 */

/**
 * Whether the running release supports joining this artifact, as
 * `incremental-graph-journal-migrations.md` §3 requires by exact equality of both
 * stored target fields. There is no decoder or migration ladder for artifacts
 * whose target differs, so the answer is a compatibility failure and not an
 * adaptation.
 * @param {CanonicalBootstrapSnapshot} artifact
 * @param {BootstrapTarget} target
 * @returns {JournalError | undefined}
 */
function artifactSupportsBootstrapTarget(artifact, target) {
    if (!isCanonicalBootstrapSnapshot(artifact)) {
        return makeJournalRecordValidationError("the canonical bootstrap artifact is not an artifact", "unknown");
    }
    if (artifact.databaseVersion !== target.databaseVersion) {
        return makeJournalVersionCompatibilityError(
            `the canonical bootstrap artifact was authored under database version ${artifact.databaseVersion}, which this release does not join`,
            String(target.databaseVersion),
            String(artifact.databaseVersion)
        );
    }
    if (artifact.graphSchemeString !== target.graphSchemeString) {
        return makeJournalVersionCompatibilityError(
            "the canonical bootstrap artifact was authored under graph scheme " +
                JSON.stringify(artifact.graphSchemeString) +
                ", which this release does not join",
            target.graphSchemeString,
            artifact.graphSchemeString
        );
    }
    return undefined;
}

/**
 * The cut's records exposed through the replica interface every Journal consumer
 * already speaks, so an artifact is not a second way of reading history.
 * @param {CanonicalBootstrapSnapshot} artifact
 * @returns {JournalReplica}
 */
function canonicalArtifactReplica(artifact) {
    if (!isCanonicalBootstrapSnapshot(artifact)) {
        throw new Error("the canonical bootstrap artifact is not an artifact");
    }
    const replica = makeJournalReplica([[artifact.creatorWriter, artifact.records]]);
    if (replica instanceof Error) {
        throw new Error("the canonical bootstrap artifact holds an unintelligible cut");
    }
    return replica;
}

module.exports = {
    artifactSupportsBootstrapTarget,
    canonicalArtifactReplica,
    isCanonicalBootstrapSnapshot,
    makeCanonicalBootstrapSnapshot,
};