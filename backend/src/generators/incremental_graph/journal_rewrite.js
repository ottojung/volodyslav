/**
 * The whole-history rewrite one Journal-aware migration applies to its source
 * replica, and the target-key view of that replica's materialized set.
 *
 * `incremental-graph-journal-migrations.md` §9 step 1 rewrites all retained history
 * into the target representation before the semantic decisions of §11 are collected,
 * and §9 calls the target-key view of the pre-migration projection
 * `GconvertedBefore`: the source replica's materialized set, every source NodeKey
 * already transported into the target representation, and every `NodeIdentifier`
 * preserved. Both halves of one migration address the same nodes through this one
 * rewriter, so a retained record and the graph state the same cutover writes cannot
 * disagree about which node key a materialized node has.
 */

const {
    encodeJournalRecord,
    isComputedValue,
    isNodeKey,
    makeDeleteEvent,
    makeInvalidateEvent,
    makeJournalVersionCompatibilityError,
    makeNodeScope,
    makeProofScope,
    makeValidateEvent,
    makeValidationBasisEntry,
    makeValueEvent,
    makeValueScope,
    nodeKeyToCanonicalString,
    sortValidationBasis,
    tryDecodeJournalRecord,
} = require("./journal");
const {
    deserializeNodeKey,
    journalTextToString,
    nodeKeyStringToString,
    serializeNodeKey,
    stringToNodeKeyString,
} = require("./database");

/** @typedef {import('./journal/errors').AnyJournalError} AnyJournalError */
/** @typedef {import('./journal/records').JournalRecord} JournalRecord */
/** @typedef {import('./journal/records').SemanticEvent} SemanticEvent */
/** @typedef {import('./journal/basis').InvalidateScope} InvalidateScope */
/** @typedef {import('./journal/basis').ValidationBasis} ValidationBasis */
/** @typedef {import('./database/node_key').NodeKey} NodeKey */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */
/** @typedef {import('./database/types').JournalText} JournalText */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./database/types').NodeKeyString} NodeKeyString */
/** @typedef {import('./migration_codec').JournalFormatCodec} JournalFormatCodec */
/** @typedef {import('./migration_codec').CodecRejection} CodecRejection */

/** The one node-key text prefix the Journal's occurrence index occupies. */
const OCCURRENCE_KEY_PREFIX = "occurrence|";

/** The one author-and-coordinate prefix a retained record occupies. */
const RECORD_KEY_PREFIX = "record|";

/**
 * The one whole-history rewrite of one replica.
 *
 * §9a's injectivity law is a contract of the codec definition over the complete
 * supported source NodeKey domain, which no replica can enumerate. What a
 * replica can do is notice that its own retained history already witnesses a
 * violation: two distinct source node keys this rewrite actually met, which the
 * codec sent to one target key. Observing that is the defensive rejection §9a
 * requires; not observing it is not offered as proof that the law holds.
 *
 * @typedef {object} HistoryRewriter
 * @property {(sourceNodeKey: NodeKey) => NodeKey | CodecRejection} nodeKey
 * @property {(sourceNodeKey: NodeKey, payload: ComputedValue) => ComputedValue | CodecRejection} payload
 * @property {(sourceNodeKeyString: NodeKeyString) => NodeKeyString | CodecRejection} nodeKeyString
 * @property {(recordText: string, label: string) => string | CodecRejection} recordText
 * @property {(occurrenceKeyText: string, label: string) => string | CodecRejection} occurrenceKeyText
 */

/**
 * @param {unknown} value
 * @returns {value is PromiseLike<unknown>}
 */
function isThenable(value) {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    return "then" in value && typeof value.then === "function";
}

/**
 * The rejection §9a requires for a record the current-format constructors refused
 * after the codec rewrote it.
 * @param {import('./journal/records').JournalRecord} record
 * @param {AnyJournalError} error
 * @returns {CodecRejection}
 */
function noTargetRepresentation(record, error) {
    return makeJournalVersionCompatibilityError(
        "retained journal record " + String(record.id) + " has no deterministic target " +
            "representation: " + error.message,
        "a target representation of " + String(record.id),
        "none"
    );
}

/**
 * Make the rewriter of one whole-history rewrite.
 *
 * The collision state is held by the returned object rather than passed in, so
 * one call rewrites one replica's retained history as one observation: a key met
 * in an early record is still remembered when a later record maps onto it. The
 * same rewriter is the one which transports the migration's graph-side key view,
 * so one migration observes each key once.
 *
 * @param {JournalFormatCodec} codec
 * @returns {HistoryRewriter}
 */
function makeHistoryRewriter(codec) {
    /** @type {Map<string, string>} */
    const targetBySource = new Map();
    /** @type {Map<string, string>} */
    const sourceByTarget = new Map();

    /**
     * @param {NodeKey} sourceNodeKey
     * @returns {NodeKey | CodecRejection}
     */
    function nodeKey(sourceNodeKey) {
        const sourceText = nodeKeyToCanonicalString(sourceNodeKey);
        const remembered = targetBySource.get(sourceText);
        if (remembered !== undefined) {
            return deserializeNodeKey(stringToNodeKeyString(remembered));
        }
        /** @type {unknown} */
        let rewritten;
        try {
            rewritten = codec.rewriteNodeKey(sourceNodeKey);
        } catch (error) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's rewriteNodeKey threw for source node key " +
                    sourceText + ": " + String(error),
                "a node key for " + sourceText,
                "a thrown transform"
            );
        }
        if (isThenable(rewritten)) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's rewriteNodeKey returned a promise for source node key " +
                    sourceText + "; a journal format codec transform must be synchronous",
                "a node key for " + sourceText,
                "a promise"
            );
        }
        if (isNodeKey(rewritten) !== true) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's rewriteNodeKey did not return a node key for source node key " +
                    sourceText,
                "a node key for " + sourceText,
                String(typeof rewritten)
            );
        }
        const targetNodeKey = rewritten;
        const targetText = nodeKeyToCanonicalString(targetNodeKey);
        const existingSource = sourceByTarget.get(targetText);
        if (existingSource !== undefined && existingSource !== sourceText) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's journal format codec maps distinct source node keys " +
                    existingSource + " and " + sourceText + " onto one target node key " + targetText +
                    ", so it is not injective over the source NodeKey domain",
                "distinct target node keys for distinct source node keys",
                "one target node key " + targetText
            );
        }
        targetBySource.set(sourceText, targetText);
        sourceByTarget.set(targetText, sourceText);
        return targetNodeKey;
    }

    /**
     * @param {NodeKey} sourceNodeKey
     * @param {ComputedValue} payload
     * @returns {ComputedValue | CodecRejection}
     */
    function payload(sourceNodeKey, payload) {
        const sourceText = nodeKeyToCanonicalString(sourceNodeKey);
        /** @type {unknown} */
        let rewritten;
        try {
            rewritten = codec.rewriteComputedValue(sourceNodeKey, payload);
        } catch (error) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's rewriteComputedValue threw for source node key " +
                    sourceText + ": " + String(error),
                "a computed value for " + sourceText,
                "a thrown transform"
            );
        }
        if (isThenable(rewritten)) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's rewriteComputedValue returned a promise for source node key " +
                    sourceText + "; a journal format codec transform must be synchronous",
                "a computed value for " + sourceText,
                "a promise"
            );
        }
        if (typeof rewritten !== "object" || rewritten === null || Array.isArray(rewritten)
            || isComputedValue(rewritten) !== true) {
            return makeJournalVersionCompatibilityError(
                "the migration definition's rewriteComputedValue did not return a computed value for source node key " +
                    sourceText,
                "a computed value for " + sourceText,
                String(typeof rewritten)
            );
        }
        return rewritten;
    }

    /**
     * @param {SemanticEvent} source
     * @param {NodeKey} node
     * @returns {JournalRecord | CodecRejection}
     */
    function semanticEvent(source, node) {
        const fields = {
            id: source.id,
            context: source.context,
            authorityTime: source.authorityTime,
            node,
        };
        if (source.kind === "value") {
            const rewrittenPayload = payload(source.node, source.payload);
            if (rewrittenPayload instanceof Error) {
                return rewrittenPayload;
            }
            const event = makeValueEvent(
                fields,
                source.nodeIdentifier,
                rewrittenPayload,
                source.createdAt,
                source.modifiedAt,
                source.reason
            );
            if (event instanceof Error) {
                return noTargetRepresentation(source, event);
            }
            return event;
        }
        if (source.kind === "delete") {
            const event = makeDeleteEvent(fields, source.reason);
            if (event instanceof Error) {
                return noTargetRepresentation(source, event);
            }
            return event;
        }
        if (source.kind === "validate") {
            /** @type {ValidationBasis} */
            const basis = [];
            for (const entry of source.basis) {
                const input = nodeKey(entry.input);
                if (input instanceof Error) {
                    return input;
                }
                basis.push(makeValidationBasisEntry(input, entry.value));
            }
            const event = makeValidateEvent(
                fields,
                source.value,
                sortValidationBasis(basis),
                source.reason
            );
            if (event instanceof Error) {
                return noTargetRepresentation(source, event);
            }
            return event;
        }
        /** @type {InvalidateScope} */
        let scope;
        if (source.scope.kind === "node") {
            scope = makeNodeScope();
        } else if (source.scope.kind === "value") {
            scope = makeValueScope(source.scope.value);
        } else {
            const input = nodeKey(source.scope.input);
            if (input instanceof Error) {
                return input;
            }
            scope = makeProofScope(source.scope.value, input);
        }
        const event = makeInvalidateEvent(fields, scope, source.reason);
        if (event instanceof Error) {
            return noTargetRepresentation(source, event);
        }
        return event;
    }

    /**
     * @param {JournalRecord} record
     * @returns {JournalRecord | CodecRejection}
     */
    function record(record) {
        if (record.kind === "writer-state") {
            return record;
        }
        const node = nodeKey(record.node);
        if (node instanceof Error) {
            return node;
        }
        return semanticEvent(record, node);
    }

    /**
     * @param {string} text
     * @param {string} label
     * @returns {string | CodecRejection}
     */
    function recordText(text, label) {
        const decoded = tryDecodeJournalRecord(text);
        if (decoded instanceof Error) {
            return makeJournalVersionCompatibilityError(
                "retained journal record " + label + " has no deterministic target representation: " +
                    decoded.message,
                "a target representation of " + label,
                "none"
            );
        }
        const rewritten = record(decoded);
        if (rewritten instanceof Error) {
            return rewritten;
        }
        return encodeJournalRecord(rewritten);
    }

    /**
     * @param {string} keyText - The `occurrence|<canonical node key>` key without
     *   its prefix.
     * @param {string} label
     * @returns {string | CodecRejection}
     */
    function occurrenceKeyText(keyText, label) {
        const sourceKey = deserializeNodeKey(stringToNodeKeyString(keyText));
        const sourceText = nodeKeyStringToString(serializeNodeKey(sourceKey));
        if (sourceText !== keyText) {
            return makeJournalVersionCompatibilityError(
                "the retained journal occurrence index entry " + label +
                    " does not name a canonical node key",
                "a canonical node key at " + label,
                keyText
            );
        }
        const targetNodeKey = nodeKey(sourceKey);
        if (targetNodeKey instanceof Error) {
            return targetNodeKey;
        }
        return nodeKeyStringToString(serializeNodeKey(targetNodeKey));
    }

    /**
     * @param {NodeKeyString} sourceNodeKeyString
     * @returns {NodeKeyString | CodecRejection}
     */
    function nodeKeyString(sourceNodeKeyString) {
        const rewritten = nodeKey(deserializeNodeKey(sourceNodeKeyString));
        if (rewritten instanceof Error) {
            return rewritten;
        }
        return stringToNodeKeyString(nodeKeyStringToString(serializeNodeKey(rewritten)));
    }

    return { nodeKey, payload, nodeKeyString, recordText, occurrenceKeyText };
}

/**
 * One Journal sublevel entry after the source->target codec has rewritten it.
 *
 * @typedef {object} RewrittenJournalEntry
 * @property {string} keyText - The key the entry occupies in the target.
 * @property {string} text - The text the entry carries in the target.
 */

/**
 * Rewrite one Journal sublevel entry through the source->target codec.
 *
 * The three key families of `journal_database.js` do not all carry a NodeKey:
 * a `record|` entry carries it inside the record text, an `occurrence|` entry
 * carries it as the key itself, and the committed-pair metadata entry carries
 * none. Rewriting retained history therefore rewrites the first two and carries
 * the third through, because a retained occurrence index entry whose node key
 * changed representation would otherwise name a node no record names.
 *
 * @param {string} keyText - The Journal sublevel key as stored.
 * @param {JournalText} value - The stored text of that key.
 * @param {HistoryRewriter} rewriter
 * @returns {RewrittenJournalEntry | CodecRejection}
 */
function rewriteJournalEntry(keyText, value, rewriter) {
    const text = journalTextToString(value);
    if (keyText.startsWith(OCCURRENCE_KEY_PREFIX)) {
        const rewrittenKey = rewriter.occurrenceKeyText(
            keyText.slice(OCCURRENCE_KEY_PREFIX.length),
            keyText
        );
        if (rewrittenKey instanceof Error) {
            return rewrittenKey;
        }
        return { keyText: OCCURRENCE_KEY_PREFIX + rewrittenKey, text };
    }
    if (keyText.startsWith(RECORD_KEY_PREFIX)) {
        const rewrittenText = rewriter.recordText(text, keyText);
        if (rewrittenText instanceof Error) {
            return rewrittenText;
        }
        return { keyText, text: rewrittenText };
    }
    return { keyText, text };
}

module.exports = {
    makeHistoryRewriter,
    rewriteJournalEntry,
};
