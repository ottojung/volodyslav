/**
 * The deterministic order and validation basis of one publication's staged intents.
 *
 * `incremental-graph-journal-emission.md` §Publication order requires one publication
 * to use an order extending the semantic dependencies: a value before the certificate
 * naming it, a referenced same-publication input before that certificate, and a cause
 * before the invalidation or deletion it causes. Canonical NodeKey order breaks the
 * ties semantics leaves unconstrained, but it does not by itself put a dependency
 * before its dependent, so this module completes the canonical order into a
 * dependency order and builds each certificate's basis from the occurrences the
 * publication either inherits or creates.
 *
 * An intent which names an input occurrence the publication does not create and does
 * not inherit is reported: emission never invents a basis entry.
 */

/** @typedef {import("./errors").AnyJournalError} JournalError */
/** @typedef {import("./basis").ValidationBasis} ValidationBasis */
/** @typedef {import("./basis").ValidationBasisEntry} ValidationBasisEntry */
/** @typedef {import("./types").JournalRecordId} JournalRecordId */
/** @typedef {import("../database/node_key").NodeKey} NodeKey */
/** @typedef {import("./emission").EmissionIntent} EmissionIntent */
/** @typedef {import("./emission").MaterializeInput} MaterializeInput */

const { makeJournalPublicationError } = require("./errors");
const { makeValidationBasisEntry, nodeKeyToCanonicalString, sortValidationBasis } = require("./basis");

/**
 * The rank which orders intents of one node by the causality semantics require:
 * a materialization before a deletion of it, a deletion or invalidation before a
 * revalidation of the same occurrence, and a revalidation last so that it can only
 * observe invalidation the same publication already recorded.
 *
 * @param {EmissionIntent["kind"]} kind
 * @returns {number}
 */
function intentKindRank(kind) {
    if (kind === "materialize") {
        return 0;
    }
    if (kind === "delete") {
        return 1;
    }
    if (kind === "invalidate-node") {
        return 2;
    }
    if (kind === "invalidate-value") {
        return 3;
    }
    return 4;
}

/**
 * @param {EmissionIntent} intent
 * @returns {NodeKey}
 */
function nodeOfIntent(intent) {
    return intent.node;
}

/**
 * @param {EmissionIntent} left
 * @param {EmissionIntent} right
 * @returns {number}
 */
function compareNodeKeys(left, right) {
    const leftText = nodeKeyToCanonicalString(nodeOfIntent(left));
    const rightText = nodeKeyToCanonicalString(nodeOfIntent(right));
    if (leftText < rightText) {
        return -1;
    }
    return leftText > rightText ? 1 : 0;
}

/**
 * The canonical order which breaks ties between intents that semantics do not
 * otherwise constrain: canonical persisted NodeKey order, then the record-kind
 * order of `intentKindRank`.
 *
 * @param {EmissionIntent} left
 * @param {EmissionIntent} right
 * @returns {number}
 */
function compareIntents(left, right) {
    const byNode = compareNodeKeys(left, right);
    if (byNode !== 0) {
        return byNode;
    }
    return intentKindRank(left.kind) - intentKindRank(right.kind);
}

/**
 * Order the intents so that a node whose value occurrence this publication creates is
 * finalized before any certificate which names that occurrence.
 *
 * @param {ReadonlyArray<EmissionIntent>} ordered - intents in canonical order.
 * @returns {Array<EmissionIntent> | JournalError}
 */
function orderIntents(ordered) {
    const materializedHere = new Set();
    for (const intent of ordered) {
        if (intent.kind === "materialize") {
            materializedHere.add(nodeKeyToCanonicalString(intent.node));
        }
    }
    const remaining = ordered.slice();
    /** @type {Array<EmissionIntent>} */
    const result = [];
    /** @type {Set<string>} */
    const created = new Set();
    while (remaining.length > 0) {
        /** @type {number} */
        let picked = -1;
        for (let index = 0; index < remaining.length; index++) {
            const candidate = remaining[index];
            if (candidate === undefined) {
                continue;
            }
            if (candidate.kind !== "materialize" && candidate.kind !== "revalidate") {
                picked = index;
                break;
            }
            const ready = candidate.inputs.every((entry) => {
                if (entry.pending !== true) {
                    return true;
                }
                const canonicalInput = nodeKeyToCanonicalString(entry.input);
                return created.has(canonicalInput) || !materializedHere.has(canonicalInput);
            });
            if (ready) {
                picked = index;
                break;
            }
        }
        if (picked < 0) {
            return makeJournalPublicationError(
                "the publication's validation bases name value occurrences which only the " +
                    "publication itself creates, in an order no publication can satisfy"
            );
        }
        const [chosen] = remaining.splice(picked, 1);
        if (chosen === undefined) {
            return makeJournalPublicationError("the publication's intents could not be ordered");
        }
        if (chosen.kind === "materialize") {
            created.add(nodeKeyToCanonicalString(chosen.node));
        }
        result.push(chosen);
    }
    return result;
}

/**
 * Build the canonical validation basis of a settled materialization or revalidation:
 * one entry per current direct input, in canonical persisted NodeKey order.
 *
 * An input marked `pending` names the value occurrence this publication creates for
 * its node, which the `ValueEvent` of that node has already allocated. An input which
 * stays unresolved is a caller which observed an input occurrence this publication
 * neither creates nor inherits, and is reported rather than given a basis entry.
 *
 * @param {ReadonlyArray<MaterializeInput>} inputs
 * @param {Map<string, JournalRecordId>} createdOccurrences - canonical NodeKey of a node this publication materialized, to the `ValueId` allocated for it.
 * @returns {ValidationBasis | JournalError}
 */
function basisOfIntents(inputs, createdOccurrences) {
    /** @type {Array<ValidationBasisEntry>} */
    const entries = [];
    for (const entry of inputs) {
        if (entry.pending === true) {
            const created = createdOccurrences.get(nodeKeyToCanonicalString(entry.input));
            if (created === undefined) {
                return makeJournalPublicationError(
                    "a validation basis names input " + nodeKeyToCanonicalString(entry.input) +
                        " whose value occurrence this publication does not create"
                );
            }
            entries.push(makeValidationBasisEntry(entry.input, created));
            continue;
        }
        entries.push(makeValidationBasisEntry(entry.input, entry.value));
    }
    return sortValidationBasis(entries);
}

module.exports = {
    basisOfIntents,
    compareIntents,
    orderIntents,
};
