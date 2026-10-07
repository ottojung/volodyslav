/**
 * The Journal staging area of one graph transaction.
 *
 * A graph write is only half of a publication: the other half is the semantic event
 * which explains it. Staging is what makes a publication's records members of the
 * same atomic write as the graph mutations they describe — nothing here writes, and
 * the commit seam turns the staged intents into Journal operations of the batch it is
 * already about to issue.
 *
 * An intent which names an input occurrence states only the node; this module
 * resolves whether the occurrence is the committed one or the one this same
 * publication creates, so a caller cannot name an occurrence which does not exist.
 */

/** @typedef {import('./graph_state').TransactionJournal} TransactionJournal */
/** @typedef {import('./database/node_key').NodeKey} NodeKey */
/** @typedef {import('./database/root_database').JournalDatabase} JournalDatabase */
/** @typedef {import('./journal/emission').EmissionIntent} EmissionIntent */
/** @typedef {import('./journal/types').JournalRecordId} JournalRecordId */

const { nodeKeyToCanonicalString, makeJournalPublicationError } = require('./journal');
const { readCurrentOccurrence } = require('./journal_store');

/**
 * Create the Journal staging area of one transaction.
 *
 * The staged intents are held in memory until the commit seam finalizes them, which
 * is the only point at which durable coordinates are allocated. `inputOccurrence`
 * resolves the value occurrence a certificate names: an input this transaction has
 * already staged a materialization for is one this same publication creates, and any
 * other input must have a committed occurrence.
 *
 * @param {JournalDatabase} journalDatabase
 * @returns {TransactionJournal}
 */
function makeTransactionJournal(journalDatabase) {
    /** @type {Array<EmissionIntent>} */
    const intents = [];
    /** @type {Set<string>} */
    const materializedHere = new Set();
    return {
        stage(intent) {
            intents.push(intent);
            if (intent.kind === "materialize") {
                materializedHere.add(nodeKeyToCanonicalString(intent.node));
            }
        },
        staged() {
            return intents;
        },
        async inputOccurrence(node) {
            const canonicalNode = nodeKeyToCanonicalString(node);
            if (materializedHere.has(canonicalNode)) {
                return { input: node, pending: true };
            }
            return { input: node, value: await requireOccurrence(journalDatabase, node) };
        },
        async requireCommittedOccurrence(node) {
            if (materializedHere.has(nodeKeyToCanonicalString(node))) {
                throw makeJournalPublicationError(
                    "a value-scoped record of this transaction names " + nodeKeyToCanonicalString(node) +
                        ", whose value occurrence this same publication creates; the record must name " +
                        "a committed occurrence"
                );
            }
            return requireOccurrence(journalDatabase, node);
        },
    };
}

/**
 * The committed value occurrence of a node, which a certificate of a dependent must
 * name. A node with no committed occurrence has no Journal value to validate against,
 * and is reported rather than validated against nothing.
 *
 * @param {JournalDatabase} journalDatabase
 * @param {NodeKey} node
 * @returns {Promise<JournalRecordId>}
 */
async function requireOccurrence(journalDatabase, node) {
    const occurrence = await readCurrentOccurrence(journalDatabase, node);
    if (occurrence instanceof Error) {
        throw occurrence;
    }
    if (occurrence === undefined) {
        throw makeJournalPublicationError(
            "the node " + nodeKeyToCanonicalString(node) +
                " has no committed journal value occurrence to validate against"
        );
    }
    return occurrence;
}


module.exports = {
    makeTransactionJournal,
};
