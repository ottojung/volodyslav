/**
 * Reading a persisted replica as the held Journal 3 snapshot a reset targets.
 *
 * `incremental-graph-journal-reset.md` §Source target names `PS` as "the source's
 * committed materialized projection from the same immutable cut as S's frontier/
 * records", and states that reset "reads the committed projection directly and does
 * **not** replay the source's retained history to obtain its target". This module is
 * that read: it takes one replica namespace which holds the held snapshot's own
 * committed rows, and produces the `ResetSource` which pairs those rows with the
 * snapshot's retained journal, version and graph scheme.
 *
 * Reading the committed rows rather than projecting the retained journal is what makes
 * the target what §Source target says it is. The projection the oracle computes from a
 * journal is a claim about what replay would produce; the committed rows are what the
 * snapshot actually persisted, and a caller which needs a target equal to those rows
 * must not receive a recomputed approximation of them instead.
 *
 * ## What a committed projection persists, and what it does not
 *
 * A Journal 3 replica persists, per materialized occurrence, its payload (`values`),
 * its two timestamps (`timestamps`), its derived freshness (`freshness`), its current
 * `ValueId` (the Journal sublevel's `occurrence|` key) and its incoming validity edges
 * (`valid`, stored inverted as dependency to dependents). Its `identifiers_keys_map`
 * names the semantic key each physical identifier stands for. Those are exactly the
 * fields §Source target lists as observable semantics: presence, payload,
 * `NodeIdentifier`, `createdAt`/`modifiedAt`, freshness and validity edges.
 *
 * A replica does not persist the per-node `SelectedCertificate` the oracle derives, so
 * the `NodeFreshness` this module builds carries no certificate. That is a statement
 * about the storage format rather than an approximation: every occurrence field reset
 * consumes is a persisted row, and reset reads `PS.occurrences` rather than a
 * certificate.
 *
 * The self-proof-readiness sets are derived with the oracle's own definition restricted
 * to the committed rows: a present node is self-proof-ready exactly when it is validated
 * against every one of its current direct inputs, which is `|validInputs| ==
 * |currentInputKeysOfNode|`. A supported committed projection has no
 * `unmarkedPropagatedStaleness`, and the set is reported rather than assumed away so a
 * caller can see the violation instead of a target which silently omits it.
 */

const {
    deserializeNodeKey,
    GRAPH_SCHEME_KEY,
    IDENTIFIERS_KEY,
    journalTextToString,
    LAST_NODE_INDEX_KEY,
    nodeIdToKeyFromLookup,
    nodeKeyStringToString,
    nodeKeyToIdFromLookup,
    parseIdentifierLookup,
    stringToNodeKeyString,
} = require('../database');
/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/oracle/projection').NodeFreshness} NodeFreshness */
/** @typedef {import('../journal/oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('../database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('../database/node_key').NodeKey} NodeKey */
/** @typedef {import('../database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('../journal_reset').ResetSource} ResetSource */
/** @typedef {Set<string>} NodeInputKeys */
/** @typedef {import('../journal_reset/proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */

const {
    makeJournalAuthor,
    makeJournalSourceReadError,
    makeReplicaSource,
    NodeFreshnessClass,
    parseJournalRecordId,
    ProjectionClass,
} = require("../journal");
const { makeResetSource } = require("../journal_reset");
const { makeJournalOccurrenceKey, readRetainedJournal } = require("../journal_store");

/** The `freshness` row value which means the occurrence is up to date. */
const UP_TO_DATE = 'up-to-date';

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {string}
 */
function requiredText(value, what) {
    if (typeof value !== 'string') {
        throw makeJournalSourceReadError(
            'the held reset source snapshot holds no readable ' + what
        );
    }
    return value;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {number}
 */
function requiredCount(value, what) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
        throw makeJournalSourceReadError(
            'the held reset source snapshot holds no readable ' + what
        );
    }
    return value;
}

/**
 * The incoming validity edges of every present node, read out of the `valid`
 * sublevel's inverted form.
 *
 * The sublevel stores, per dependency identifier, the identifiers of the dependents
 * whose incoming edge it proves, so the edge set of one dependent is the set of
 * dependencies whose entry names it. A dependency or dependent identifier the
 * `identifiers_keys_map` does not resolve names no semantic node, and therefore
 * belongs to no edge set.
 *
 * @param {SchemaStorage} storage
 * @param {IdentifierLookup} lookup
 * @returns {Promise<Map<string, NodeInputKeys>>}
 */
async function validInputsByNodeKey(storage, lookup) {
    /** @type {Map<string, NodeInputKeys>} */
    const validInputs = new Map();
    for await (const dependency of storage.valid.keys()) {
        const dependents = await storage.valid.get(dependency);
        if (dependents === undefined) {
            throw makeJournalSourceReadError(
                'the held reset source snapshot names a validity edge key with no stored dependents'
            );
        }
        const dependencyKey = nodeIdToKeyFromLookup(lookup, dependency);
        if (dependencyKey === undefined) {
            continue;
        }
        for (const dependent of dependents) {
            const dependentKey = nodeIdToKeyFromLookup(lookup, dependent);
            if (dependentKey === undefined) {
                continue;
            }
            const existing = validInputs.get(nodeKeyStringToString(dependentKey));
            if (existing === undefined) {
                validInputs.set(
                    nodeKeyStringToString(dependentKey),
                    new Set([nodeKeyStringToString(dependencyKey)])
                );
                continue;
            }
            existing.add(nodeKeyStringToString(dependencyKey));
        }
    }
    return validInputs;
}

/**
 * The `ValueId` the replica persists as a node's current value occurrence.
 *
 * @param {SchemaStorage} storage
 * @param {NodeKey} node
 * @returns {Promise<JournalRecordId | undefined>}
 */
async function readOccurrenceOf(storage, node) {
    const raw = await storage.journal.get(makeJournalOccurrenceKey(node));
    if (raw === undefined) {
        return undefined;
    }
    const parsed = parseJournalRecordId(journalTextToString(raw));
    return parsed instanceof Error ? undefined : parsed;
}

/**
 * @typedef {object} HeldResetSourceRequest
 * @property {SchemaStorage} storage - The replica namespace which holds the held
 *   snapshot's committed rows and retained journal.
 * @property {CurrentInputKeysOfNode} currentInputKeysOfNode - The current schema's
 *   direct inputs per node, which the snapshot's own graph scheme fixes for both sides.
 * @property {string} fingerprint - The snapshot replica's own writer identity, which is
 *   the local writer its committed allocator watermark belongs to.
 */

/**
 * Read one persisted replica as the held snapshot a reset targets.
 *
 * @param {HeldResetSourceRequest} request
 * @returns {Promise<{source: ResetSource} | {error: JournalError}>}
 */
async function readHeldResetSource(request) {
    const { storage, currentInputKeysOfNode, fingerprint } = request;

    const databaseVersion = requiredText(await storage.global.get('version'), 'database version');
    const graphSchemeString = requiredText(
        await storage.global.get(GRAPH_SCHEME_KEY),
        'graph scheme'
    );
    const lastNodeIndex = requiredCount(
        await storage.global.get(LAST_NODE_INDEX_KEY),
        'allocator watermark'
    );
    const lookup = parseIdentifierLookup(
        await storage.global.get(IDENTIFIERS_KEY),
        'held reset source snapshot'
    );

    const localWriter = makeJournalAuthor(fingerprint);
    if (localWriter instanceof Error) {
        return { error: localWriter };
    }

    const replica = await readRetainedJournal(storage.journal);
    if (replica instanceof Error) {
        return { error: replica };
    }

    const validInputs = await validInputsByNodeKey(storage, lookup);

    /** @type {ProjectedOccurrence[]} */
    const occurrences = [];
    /** @type {Map<string, NodeFreshness>} */
    const freshness = new Map();
    /** @type {Set<string>} */
    const selfProofReadyNodes = new Set();
    /** @type {Set<string>} */
    const unmarkedPropagatedStaleness = new Set();

    const nodeKeyStrings = [...lookup.keyToId.keys()].sort();
    for (const nodeKeyString of nodeKeyStrings) {
        const nodeIdentifier = nodeKeyToIdFromLookup(lookup, stringToNodeKeyString(nodeKeyString));
        if (nodeIdentifier === undefined) {
            continue;
        }
        const payload = await storage.values.get(nodeIdentifier);
        if (payload === undefined) {
            return {
                error: makeJournalSourceReadError(
                    'the held reset source snapshot persists no value for ' + nodeKeyString
                ),
            };
        }
        const rowFreshness = await storage.freshness.get(nodeIdentifier);
        if (rowFreshness === undefined) {
            return {
                error: makeJournalSourceReadError(
                    'the held reset source snapshot persists no freshness for ' + nodeKeyString
                ),
            };
        }
        const timestamps = await storage.timestamps.get(nodeIdentifier);
        if (timestamps === undefined) {
            return {
                error: makeJournalSourceReadError(
                    'the held reset source snapshot persists no timestamps for ' + nodeKeyString
                ),
            };
        }
        const nodeKey = deserializeNodeKey(stringToNodeKeyString(nodeKeyString));
        const valueId = await readOccurrenceOf(storage, nodeKey);
        if (valueId === undefined) {
            return {
                error: makeJournalSourceReadError(
                    'the held reset source snapshot persists no value occurrence for ' + nodeKeyString
                ),
            };
        }
        const isFresh = rowFreshness === UP_TO_DATE;
        const inputs = validInputs.get(nodeKeyString) ?? new Set();
        freshness.set(nodeKeyString, new NodeFreshnessClass(isFresh, new Set(inputs), undefined));
        occurrences.push({
            nodeKeyString,
            nodeKey,
            valueId,
            nodeIdentifier,
            payload,
            createdAt: timestamps.createdAt,
            modifiedAt: timestamps.modifiedAt,
            fresh: isFresh,
            validInputs: new Set(inputs),
        });
        if (inputs.size === currentInputKeysOfNode(nodeKeyString).length) {
            selfProofReadyNodes.add(nodeKeyString);
            if (!isFresh) {
                unmarkedPropagatedStaleness.add(nodeKeyString);
            }
        }
    }

    return {
        source: makeResetSource({
            databaseVersion,
            graphSchemeString,
            journal: makeReplicaSource(replica),
            projection: new ProjectionClass(
                occurrences,
                freshness,
                lastNodeIndex,
                localWriter,
                selfProofReadyNodes,
                unmarkedPropagatedStaleness
            ),
        }),
    };
}

module.exports = {
    readHeldResetSource,
};