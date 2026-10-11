/**
 * Pass J2 of `incremental-graph-journal-migrations.md` §7.3: local proof, direct
 * stale evidence, and the exact-shared proof barriers.
 *
 * The pass has two halves, because §7.3 gives them opposite rules.
 *
 * - A locally authored occurrence which won ordinary authority gets a certificate
 *   whose basis names the joining occurrences it was actually validated against. When
 *   a joining input occurrence loses to a different canonical occurrence, that basis
 *   entry names a `ValueId` replay does not select, so replay observes the mismatch
 *   and the occurrence is hard stale instead of the join manufacturing a validity
 *   edge for a combination no legacy replica ever held. Persisted stale evidence for
 *   that occurrence follows as a value-scoped invalidation.
 * - An exact-shared occurrence keeps the canonical certificate, and this pass only
 *   lowers the shared basis conservatively: a proof-scoped barrier retires every
 *   canonical validity edge the joining legacy graph does not also hold, and the OR of
 *   both sides' direct stale evidence becomes a value-scoped invalidation when the
 *   canonical cut does not already record one. Joining-only proof never strengthens an
 *   exact-shared occurrence.
 */

const { nodeKeyStringToString } = require("../../database");
const { makeJournalPublicationError } = require("../errors");
const { journalRecordIdToString } = require("../types");
const {
    makeProofScope,
    makeValidationBasisEntry,
    makeValueScope,
    nodeKeyToCanonicalString,
} = require("../basis");
const { makeInvalidateEvent, makeValidateEvent } = require("../records");
const {
    canonicalValidityEdges,
    holdsStaleEvidence,
    semanticInputKeys,
} = require("./joining_support");

/** @typedef {import('../errors').AnyJournalError} JournalError */
/** @typedef {import('../records').JournalRecord} JournalRecord */
/** @typedef {import('../basis').ValidationBasis} ValidationBasis */
/** @typedef {import('./joining_support').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./joining_support').JoiningCursorClass} JoiningCursor */
/** @typedef {import('./legacy_state').LegacyBootstrapState} LegacyBootstrapState */
/** @typedef {import('../oracle/projection').Projection} Projection */

/**
 * @typedef {object} JoiningProofRequest
 * @property {LegacyBootstrapState} legacyState - The joining replica's persisted
 *   pre-Journal graph.
 * @property {ReadonlyArray<JournalRecord>} canonicalRecords - The canonical cut's
 *   records, which hold the canonical certificate and the canonical stale evidence.
 * @property {Map<string, import('../types').JournalRecordId>} valueIdOf - Each
 *   materialized joining node's occurrence identity, as Pass J1 established it.
 * @property {Set<string>} locallyAuthored - The nodes whose occurrence Pass J1
 *   authored, which are exactly the nodes this pass gives local proof.
 * @property {Projection} selected - The replay of the canonical cut together with the
 *   joining values, which decides which locally authored occurrences are current.
 * @property {JoiningCursor} cursor - The joining replica's record cursor.
 * @property {CurrentInputKeysOfNode} currentInputKeysOfNode - The current graph
 *   schema's direct inputs per node.
 */

/**
 * @param {JoiningProofRequest} request
 * @returns {JournalError | undefined}
 */
function authorJoiningProof(request) {
    const {
        legacyState,
        canonicalRecords,
        valueIdOf,
        locallyAuthored,
        selected,
        cursor,
        currentInputKeysOfNode,
    } = request;
    /** @type {Map<string, import('../oracle/projection').ProjectedOccurrence>} */
    const selectedOccurrences = new Map(
        selected.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
    for (const legacyNode of legacyState.nodes) {
        const key = nodeKeyStringToString(legacyNode.nodeKeyString);
        const occurrenceValueId = valueIdOf.get(key);
        if (occurrenceValueId === undefined) {
            return makeJournalPublicationError(
                "the joining bootstrap lost the occurrence of the materialized node " + key
            );
        }
        const valueIdText = journalRecordIdToString(occurrenceValueId);
        if (locallyAuthored.has(key)) {
            const current = selectedOccurrences.get(key);
            if (current === undefined || journalRecordIdToString(current.valueId) !== valueIdText) {
                continue;
            }
            const inputs = semanticInputKeys(key, currentInputKeysOfNode);
            if (inputs instanceof Error) {
                return inputs;
            }
            /** @type {ValidationBasis} */
            const basis = [];
            for (const input of inputs) {
                const named = valueIdOf.get(nodeKeyToCanonicalString(input));
                basis.push(
                    makeValidationBasisEntry(input, named === undefined ? "unknown" : named)
                );
            }
            const allocated = cursor.allocate(false, undefined);
            if ("error" in allocated) {
                return allocated.error;
            }
            const certificate = makeValidateEvent(
                { ...allocated.fields, node: legacyNode.node },
                occurrenceValueId,
                basis,
                "bootstrap"
            );
            if (certificate instanceof Error) {
                return certificate;
            }
            cursor.append(certificate);
            if (!legacyNode.upToDate) {
                const invalidation = cursor.allocate(false, undefined);
                if ("error" in invalidation) {
                    return invalidation.error;
                }
                const stale = makeInvalidateEvent(
                    { ...invalidation.fields, node: legacyNode.node },
                    makeValueScope(occurrenceValueId),
                    "bootstrap"
                );
                if (stale instanceof Error) {
                    return stale;
                }
                cursor.append(stale);
            }
            continue;
        }

        const canonicalEdges = canonicalValidityEdges(canonicalRecords, valueIdText);
        const joiningEdges = new Set(legacyNode.directInputKeys.map(nodeKeyToCanonicalString));
        for (const input of [...canonicalEdges.keys()].sort()) {
            if (joiningEdges.has(input)) {
                continue;
            }
            const inputNode = canonicalEdges.get(input);
            if (inputNode === undefined) {
                return makeJournalPublicationError(
                    "the canonical validity edge into " + key + " lost the semantic identity of " + input
                );
            }
            const barrier = cursor.allocate(false, undefined);
            if ("error" in barrier) {
                return barrier.error;
            }
            const record = makeInvalidateEvent(
                { ...barrier.fields, node: legacyNode.node },
                makeProofScope(occurrenceValueId, inputNode),
                "bootstrap"
            );
            if (record instanceof Error) {
                return record;
            }
            cursor.append(record);
        }
        const canonicalStale = holdsStaleEvidence(canonicalRecords, key, valueIdText);
        const joinedSharedStaleEvidence = canonicalStale || !legacyNode.upToDate;
        if (
            joinedSharedStaleEvidence &&
            !holdsStaleEvidence([...canonicalRecords, ...cursor.records], key, valueIdText)
        ) {
            const stale = cursor.allocate(false, undefined);
            if ("error" in stale) {
                return stale.error;
            }
            const record = makeInvalidateEvent(
                { ...stale.fields, node: legacyNode.node },
                makeValueScope(occurrenceValueId),
                "bootstrap"
            );
            if (record instanceof Error) {
                return record;
            }
            cursor.append(record);
        }
    }


    return undefined;
}

module.exports = {
    authorJoiningProof,
};
