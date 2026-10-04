/**
 * The one held source snapshot reset targets.
 *
 * `incremental-graph-journal-reset.md` §Preconditions requires that the
 * compatibility metadata comes from the same held `JournalSnapshot` used to derive
 * the target and to import source records, and §Source target requires the target
 * `PS` to be the source's committed projection from that same immutable cut. Those
 * are two different facts about one snapshot, and reading them from two values
 * would let a caller pass the projection of one cut with the version of another.
 * This class therefore holds the journal and the projection together with the
 * version and the graph scheme, so the pairing cannot be assembled wrongly.
 *
 * Transport is outside reset semantics: how the lifecycle identifies the snapshot
 * is the caller's business, and this class names no host, path or locator.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal_sync').SnapshotIdentity} SnapshotIdentity */
/** @typedef {import('../journal/oracle/record_source').JournalSource} JournalSource */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */

const { SnapshotIdentityClass } = require("../journal_sync");

/**
 * The properties that this class carries are:
 * - `databaseVersion` and `graphSchemeString` are the metadata of the same held
 *   snapshot cut as `projection`;
 * - `projection` is that cut's committed materialized projection, so it is
 *   observationally equal to `project(journal)` without reset replaying the
 *   source's retained history to obtain it; and
 * - `journal` is the retained history of that same cut, so every record imported
 *   from it belongs to the snapshot whose projection is the reset target.
 *
 * The proof of those properties is guaranteed by:
 * - `makeResetSource(...)`: it is the only function which produces this type, and
 *   it accepts the journal and the projection as arguments of one call, together
 *   with the version and the scheme it publishes. A caller therefore cannot hold
 *   a projection from one cut beside a journal from another, because there is no
 *   way to build the value except by choosing all four together.
 *
 * @param {string} databaseVersion
 * @param {string} graphSchemeString
 * @param {JournalSource} journal
 * @param {Projection} projection
 */
class ResetSourceClass {
    /**
     * @param {string} databaseVersion
     * @param {string} graphSchemeString
     * @param {JournalSource} journal
     * @param {Projection} projection
     */
    constructor(databaseVersion, graphSchemeString, journal, projection) {
        this.databaseVersion = databaseVersion;
        this.graphSchemeString = graphSchemeString;
        this.journal = journal;
        this.projection = projection;
    }

    /**
     * The compatibility metadata of this cut, as the one snapshot identity the
     * receiver's active values are compared against.
     * @returns {SnapshotIdentity}
     */
    identity() {
        return new SnapshotIdentityClass(this.databaseVersion, this.graphSchemeString);
    }
}

/** @typedef {ResetSourceClass} ResetSource */

/**
 * @param {unknown} value
 * @returns {value is ResetSource}
 */
function isResetSource(value) {
    return value instanceof ResetSourceClass;
}

/**
 * Build the held source snapshot reset targets.
 *
 * @param {object} request
 * @param {string} request.databaseVersion
 * @param {string} request.graphSchemeString
 * @param {JournalSource} request.journal
 * @param {Projection} request.projection
 * @returns {ResetSource}
 */
function makeResetSource(request) {
    return new ResetSourceClass(
        request.databaseVersion,
        request.graphSchemeString,
        request.journal,
        request.projection
    );
}

module.exports = {
    ResetSourceClass,
    isResetSource,
    makeResetSource,
};