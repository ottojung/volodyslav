/**
 * The two Journal relation functions: causal observation and total conflict
 * authority.
 *
 * Both read only the part of a semantic event which orders it, so they are
 * usable by any record which carries a context and an authority time, and they
 * never depend on a record's own fields.
 */

const {
    compareAuthorityTime,
    compareJournalSequence,
    isSameJournalAuthor,
    journalAuthorToString,
    journalSequenceAtFrontier,
} = require("./types");

/** @typedef {import("./types").AuthorityTime} AuthorityTime */
/** @typedef {import("./types").JournalAuthor} JournalAuthor */
/** @typedef {import("./types").JournalFrontier} JournalFrontier */
/** @typedef {import("./types").JournalRecordId} JournalRecordId */
/** @typedef {import("./types").JournalSequence} JournalSequence */

/**
 * The part of a semantic event which orders it. Both relation functions need no
 * more than this.
 * @typedef {object} CausalEventRef
 * @property {JournalRecordId} id
 * @property {JournalFrontier} context
 * @property {AuthorityTime} authorityTime
 */

/**
 * The part of a record a causal observation check reads.
 * @typedef {object} ContextualRecord
 * @property {JournalRecordId} id
 * @property {JournalFrontier} context
 */

/**
 * Same-writer order follows immutable writer-stream order; cross-writer order
 * follows the context observation. The relation is a genuine transitive
 * partial order for every supported journal.
 * @param {ContextualRecord} event
 * @param {ContextualRecord} other
 * @returns {boolean}
 */
function happenedBefore(event, other) {
    if (isSameJournalAuthor(event.id.author, other.id.author)) {
        return compareJournalSequence(event.id.sequence, other.id.sequence) < 0;
    }
    return (
        compareJournalSequence(
            event.id.sequence,
            journalSequenceAtFrontier(other.context, event.id.author)
        ) <= 0
    );
}

/**
 * Total conflict authority: physical, then logical, then author
 * lexicographically, then sequence. The order is conflict authority, not
 * guaranteed real-world chronology.
 * @param {CausalEventRef} event
 * @param {CausalEventRef} other
 * @returns {number} negative if event < other, 0 if equal, positive if event > other
 */
function authorityCompare(event, other) {
    const byPhysical = compareAuthorityTime(event.authorityTime, other.authorityTime);
    if (byPhysical !== 0) {
        return byPhysical;
    }
    if (isSameJournalAuthor(event.id.author, other.id.author)) {
        return compareJournalSequence(event.id.sequence, other.id.sequence);
    }
    const left = journalAuthorToString(event.id.author);
    const right = journalAuthorToString(other.id.author);
    if (left < right) {
        return -1;
    }
    if (left > right) {
        return 1;
    }
    return compareJournalSequence(event.id.sequence, other.id.sequence);
}

module.exports = {
    authorityCompare,
    happenedBefore,
};
