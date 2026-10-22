/**
 * Journal 3 error classes.
 *
 * The Journal failure categories are distinct operational meanings, so every
 * one of them keeps its own class. Lifecycle code must be able to tell
 * incompatibility, unsupported lifecycle state, forked identity, malformed
 * history, projection failure and storage failure apart.
 *
 * These classes are additive to the existing `incremental_graph/errors.js`,
 * `database/replica_errors.js` and `migration_errors.js` families; they do not
 * replace them.
 */

/**
 * Base class of every Journal-specific error, so callers can separate Journal
 * failures from the pre-Journal error families at one boundary.
 */
class JournalError extends Error {
    /**
     * @param {string} name
     * @param {string} message
     */
    constructor(name, message) {
        super(message);
        this.name = name;
    }
}

/**
 * Two records claim one `(author, sequence)` identity with different canonical
 * current-format meaning.
 */
class JournalForkError extends JournalError {
    /**
     * @param {string} recordId
     * @param {string} firstMeaning - Canonical current-format meaning of the first record.
     * @param {string} secondMeaning - Canonical current-format meaning of the conflicting record.
     */
    constructor(recordId, firstMeaning, secondMeaning) {
        super(
            "JournalForkError",
            `Writer coordinate ${recordId} has two different canonical meanings: ` +
                `${firstMeaning} and ${secondMeaning}. Immutable writer-history disagreement ` +
                `is not an ordinary graph conflict.`
        );
        this.recordId = recordId;
        this.firstMeaning = firstMeaning;
        this.secondMeaning = secondMeaning;
    }
}

/**
 * @param {string} recordId
 * @param {string} firstMeaning
 * @param {string} secondMeaning
 * @returns {JournalForkError}
 */
function makeJournalForkError(recordId, firstMeaning, secondMeaning) {
    return new JournalForkError(recordId, firstMeaning, secondMeaning);
}

/**
 * @param {unknown} object
 * @returns {object is JournalForkError}
 */
function isJournalForkError(object) {
    return object instanceof JournalForkError;
}

/**
 * A canonical bootstrap artifact belongs to this installation's continuing
 * writer identity, but the still-local pre-Journal graph is no longer the
 * semantic state that artifact represents.
 */
class JournalBootstrapForkError extends JournalError {
    /**
     * @param {string} localWriter - The continuing writer identity of the local installation.
     * @param {string} artifactCreatorWriter - The creator writer recorded in the canonical artifact.
     * @param {string} detail - What failed to match.
     */
    constructor(localWriter, artifactCreatorWriter, detail) {
        super(
            "JournalBootstrapForkError",
            `Canonical bootstrap artifact for creator ${artifactCreatorWriter} does not describe ` +
                `local writer ${localWriter}: ${detail}. Nothing was authored; explicit recovery ` +
                `or operator action is required.`
        );
        this.localWriter = localWriter;
        this.artifactCreatorWriter = artifactCreatorWriter;
        this.detail = detail;
    }
}

/**
 * @param {string} localWriter
 * @param {string} artifactCreatorWriter
 * @param {string} detail
 * @returns {JournalBootstrapForkError}
 */
function makeJournalBootstrapForkError(localWriter, artifactCreatorWriter, detail) {
    return new JournalBootstrapForkError(localWriter, artifactCreatorWriter, detail);
}

/**
 * @param {unknown} object
 * @returns {object is JournalBootstrapForkError}
 */
function isJournalBootstrapForkError(object) {
    return object instanceof JournalBootstrapForkError;
}

/**
 * A claimed committed writer prefix is not contiguous.
 */
class JournalGapError extends JournalError {
    /**
     * @param {string} author
     * @param {string} frontierSequence - Highest retained sequence claimed for the writer.
     * @param {string} missingSequence - The sequence which is absent.
     */
    constructor(author, frontierSequence, missingSequence) {
        super(
            "JournalGapError",
            `Writer ${author} claims a committed prefix through ${frontierSequence} but ` +
                `${author}:${missingSequence} is absent. Active supported history may not expose a hole.`
        );
        this.author = author;
        this.frontierSequence = frontierSequence;
        this.missingSequence = missingSequence;
    }
}

/**
 * @param {string} author
 * @param {string} frontierSequence
 * @param {string} missingSequence
 * @returns {JournalGapError}
 */
function makeJournalGapError(author, frontierSequence, missingSequence) {
    return new JournalGapError(author, frontierSequence, missingSequence);
}

/**
 * @param {unknown} object
 * @returns {object is JournalGapError}
 */
function isJournalGapError(object) {
    return object instanceof JournalGapError;
}

/**
 * A semantic-event context is not a genuine causally closed frontier.
 */
class JournalCausalClosureError extends JournalError {
    /**
     * @param {string} recordId
     * @param {string} rule - Which closure rule was violated.
     * @param {string} detail
     */
    constructor(recordId, rule, detail) {
        super(
            "JournalCausalClosureError",
            `Semantic event ${recordId} has a context which is not a causally closed frontier ` +
                `(${rule}): ${detail}`
        );
        this.recordId = recordId;
        this.rule = rule;
        this.detail = detail;
    }
}

/**
 * @param {string} recordId
 * @param {string} rule
 * @param {string} detail
 * @returns {JournalCausalClosureError}
 */
function makeJournalCausalClosureError(recordId, rule, detail) {
    return new JournalCausalClosureError(recordId, rule, detail);
}

/**
 * @param {unknown} object
 * @returns {object is JournalCausalClosureError}
 */
function isJournalCausalClosureError(object) {
    return object instanceof JournalCausalClosureError;
}

/**
 * An event references a ValueId which was not in its causal past.
 */
class JournalReferenceCausalityError extends JournalError {
    /**
     * @param {string} recordId
     * @param {string} referencedRecordId
     * @param {string} detail
     */
    constructor(recordId, referencedRecordId, detail) {
        super(
            "JournalReferenceCausalityError",
            `Record ${recordId} references ${referencedRecordId}, which it had not causally ` +
                `observed: ${detail}`
        );
        this.recordId = recordId;
        this.referencedRecordId = referencedRecordId;
        this.detail = detail;
    }
}

/**
 * @param {string} recordId
 * @param {string} referencedRecordId
 * @param {string} detail
 * @returns {JournalReferenceCausalityError}
 */
function makeJournalReferenceCausalityError(recordId, referencedRecordId, detail) {
    return new JournalReferenceCausalityError(recordId, referencedRecordId, detail);
}

/**
 * @param {unknown} object
 * @returns {object is JournalReferenceCausalityError}
 */
function isJournalReferenceCausalityError(object) {
    return object instanceof JournalReferenceCausalityError;
}

/**
 * A record cannot be decoded or validated under the current Journal format
 * contract.
 */
class JournalRecordValidationError extends JournalError {
    /**
     * @param {string} detail
     * @param {string} recordId - The offending record identity, or "unknown" before an id was read.
     */
    constructor(detail, recordId) {
        super("JournalRecordValidationError", `Invalid Journal record (${recordId}): ${detail}`);
        this.detail = detail;
        this.recordId = recordId;
    }
}

/**
 * @param {string} detail
 * @param {string} recordId
 * @returns {JournalRecordValidationError}
 */
function makeJournalRecordValidationError(detail, recordId) {
    return new JournalRecordValidationError(detail, recordId);
}

/**
 * @param {unknown} object
 * @returns {object is JournalRecordValidationError}
 */
function isJournalRecordValidationError(object) {
    return object instanceof JournalRecordValidationError;
}

/**
 * Independently valid state cannot be interpreted under the compatibility
 * contract of the requested operation.
 */
class JournalVersionCompatibilityError extends JournalError {
    /**
     * @param {string} detail
     * @param {string} expectedVersion
     * @param {string} foundVersion
     */
    constructor(detail, expectedVersion, foundVersion) {
        super(
            "JournalVersionCompatibilityError",
            `Incompatible Journal state (expected ${expectedVersion}, found ${foundVersion}): ${detail}`
        );
        this.detail = detail;
        this.expectedVersion = expectedVersion;
        this.foundVersion = foundVersion;
    }
}

/**
 * @param {string} detail
 * @param {string} expectedVersion
 * @param {string} foundVersion
 * @returns {JournalVersionCompatibilityError}
 */
function makeJournalVersionCompatibilityError(detail, expectedVersion, foundVersion) {
    return new JournalVersionCompatibilityError(detail, expectedVersion, foundVersion);
}

/**
 * @param {unknown} object
 * @returns {object is JournalVersionCompatibilityError}
 */
function isJournalVersionCompatibilityError(object) {
    return object instanceof JournalVersionCompatibilityError;
}

/**
 * The established-writer rollback condition: the local writer is ahead of the
 * state it is being asked to accept.
 */
class JournalWriterBehindError extends JournalError {
    /**
     * @param {string} localWriter
     * @param {string} localHeadSequence
     * @param {string} sourceHeadSequence
     */
    constructor(localWriter, localHeadSequence, sourceHeadSequence) {
        super(
            "JournalWriterBehindError",
            `Local writer ${localWriter} is at ${localWriter}:${localHeadSequence}, ahead of the ` +
                `source's ${localWriter}:${sourceHeadSequence}. This is unsupported state, not a ` +
                `request to repair the receiver.`
        );
        this.localWriter = localWriter;
        this.localHeadSequence = localHeadSequence;
        this.sourceHeadSequence = sourceHeadSequence;
    }
}

/**
 * @param {string} localWriter
 * @param {string} localHeadSequence
 * @param {string} sourceHeadSequence
 * @returns {JournalWriterBehindError}
 */
function makeJournalWriterBehindError(localWriter, localHeadSequence, sourceHeadSequence) {
    return new JournalWriterBehindError(localWriter, localHeadSequence, sourceHeadSequence);
}

/**
 * @param {unknown} object
 * @returns {object is JournalWriterBehindError}
 */
function isJournalWriterBehindError(object) {
    return object instanceof JournalWriterBehindError;
}

/**
 * Structurally valid retained history cannot produce the required supported
 * IncrementalGraph projection, or a maintenance transition claims target
 * equivalence but replay disagrees.
 */
class JournalProjectionError extends JournalError {
    /**
     * @param {string} detail
     * @param {string} nodeKeyString - The semantic node involved, or "unknown".
     */
    constructor(detail, nodeKeyString) {
        super("JournalProjectionError", `Journal projection failed for ${nodeKeyString}: ${detail}`);
        this.detail = detail;
        this.nodeKeyString = nodeKeyString;
    }
}

/**
 * @param {string} detail
 * @param {string} nodeKeyString
 * @returns {JournalProjectionError}
 */
function makeJournalProjectionError(detail, nodeKeyString) {
    return new JournalProjectionError(detail, nodeKeyString);
}

/**
 * @param {unknown} object
 * @returns {object is JournalProjectionError}
 */
function isJournalProjectionError(object) {
    return object instanceof JournalProjectionError;
}

/**
 * Durable graph+Journal publication or cutover failed operationally rather
 * than semantically.
 */
class JournalPublicationError extends JournalError {
    /**
     * @param {string} detail
     */
    constructor(detail) {
        super("JournalPublicationError", `Journal publication failed: ${detail}`);
        this.detail = detail;
    }
}

/**
 * @param {string} detail
 * @returns {JournalPublicationError}
 */
function makeJournalPublicationError(detail) {
    return new JournalPublicationError(detail);
}

/**
 * @param {unknown} object
 * @returns {object is JournalPublicationError}
 */
function isJournalPublicationError(object) {
    return object instanceof JournalPublicationError;
}

/**
 * A required stable source could not be opened or read completely for
 * operational reasons.
 */
class JournalSourceReadError extends JournalError {
    /**
     * @param {string} detail
     */
    constructor(detail) {
        super("JournalSourceReadError", `Journal source could not be read completely: ${detail}`);
        this.detail = detail;
    }
}

/**
 * @param {string} detail
 * @returns {JournalSourceReadError}
 */
function makeJournalSourceReadError(detail) {
    return new JournalSourceReadError(detail);
}

/**
 * @param {unknown} object
 * @returns {object is JournalSourceReadError}
 */
function isJournalSourceReadError(object) {
    return object instanceof JournalSourceReadError;
}

/**
 * Every failure the Journal record layer reports. A validator returns one of
 * these or undefined, so a caller can branch on the guards below.
 * @typedef {JournalError | JournalForkError | JournalBootstrapForkError | JournalGapError | JournalCausalClosureError | JournalReferenceCausalityError | JournalRecordValidationError | JournalVersionCompatibilityError | JournalWriterBehindError | JournalProjectionError | JournalPublicationError | JournalSourceReadError} AnyJournalError
 */

/**
 * @param {unknown} object
 * @returns {object is JournalError}
 */
function isJournalError(object) {
    return object instanceof JournalError;
}

module.exports = {
    JournalError,
    isJournalError,
    makeJournalForkError,
    isJournalForkError,
    makeJournalBootstrapForkError,
    isJournalBootstrapForkError,
    makeJournalGapError,
    isJournalGapError,
    makeJournalCausalClosureError,
    isJournalCausalClosureError,
    makeJournalReferenceCausalityError,
    isJournalReferenceCausalityError,
    makeJournalRecordValidationError,
    isJournalRecordValidationError,
    makeJournalVersionCompatibilityError,
    isJournalVersionCompatibilityError,
    makeJournalWriterBehindError,
    isJournalWriterBehindError,
    makeJournalProjectionError,
    isJournalProjectionError,
    makeJournalPublicationError,
    isJournalPublicationError,
    makeJournalSourceReadError,
    isJournalSourceReadError,
};
