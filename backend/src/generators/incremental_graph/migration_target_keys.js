/**
 * The migration's graph-side view of its source materialization in target NodeKey
 * representation.
 *
 * `incremental-graph-journal-migrations.md` §9 calls this view `GconvertedBefore`:
 * the source replica's materialized set, every source NodeKey already transported
 * into the target representation, and every `NodeIdentifier` preserved. It is what
 * §11's callback key space is addressed in, and what the target replica's
 * `identifiers_keys_map` becomes.
 */

const {
    makeIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    nodeKeyStringToString,
    stringToNodeKeyString,
} = require("./database");
const { makeJournalVersionCompatibilityError } = require("./journal");

/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./journal_rewrite').HistoryRewriter} HistoryRewriter */
/** @typedef {import('./migration_codec').CodecRejection} CodecRejection */

/**
 * `incremental-graph-journal-migrations.md` §11 addresses the callback by
 * `NodeIdentifier` but reasons about `Kt = rewriteNodeKey(Ks)`, so a `create`
 * collides with a transported target key rather than with the source spelling the
 * identifier lookup happens to hold.
 *
 * @typedef {object} TargetKeyView
 * @property {(identifier: NodeIdentifier) => NodeKeyString | CodecRejection} keyForIdentifier
 * @property {(sourceNodeKeyString: NodeKeyString) => NodeKeyString | CodecRejection} nodeKeyString
 * @property {IdentifierLookup} lookup - Every materialized identifier mapped to its target key.
 * @property {Map<string, string>} index - Identifier text to target key text.
 */

/**
 * Transport the source replica's identifier lookup into target NodeKey space.
 *
 * Every identifier is preserved, so the view is the same materialization under the
 * target representation rather than a new one: a node the migration did not decide
 * about keeps the identifier the source replica persisted for it.
 *
 * @param {IdentifierLookup} sourceLookup
 * @param {HistoryRewriter} rewriter
 * @returns {TargetKeyView | CodecRejection}
 */
function makeTargetKeyView(sourceLookup, rewriter) {
    /** @type {Array<[NodeIdentifier, NodeKeyString]>} */
    const entries = [];
    /** @type {Map<string, string>} */
    const index = new Map();
    for (const [identifierString, sourceKey] of sourceLookup.idToKey.entries()) {
        const targetNodeKeyString = rewriter.nodeKeyString(stringToNodeKeyString(String(sourceKey)));
        if (targetNodeKeyString instanceof Error) {
            return targetNodeKeyString;
        }
        entries.push([nodeIdentifierFromString(identifierString), targetNodeKeyString]);
        index.set(identifierString, nodeKeyStringToString(targetNodeKeyString));
    }
    /**
     * @param {NodeIdentifier} identifier
     * @returns {NodeKeyString | CodecRejection}
     */
    function keyForIdentifier(identifier) {
        const key = index.get(nodeIdentifierToString(identifier));
        if (key === undefined) {
            return makeJournalVersionCompatibilityError(
                "the target key view has no key for " + nodeIdentifierToString(identifier),
                "a target node key for " + nodeIdentifierToString(identifier),
                "none"
            );
        }
        return stringToNodeKeyString(key);
    }
    return {
        keyForIdentifier,
        nodeKeyString: rewriter.nodeKeyString,
        lookup: makeIdentifierLookup(entries),
        index,
    };
}

module.exports = {
    makeTargetKeyView,
};
