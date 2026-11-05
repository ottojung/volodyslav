/**
 * The scope-maxima field codecs of the durable retained replay state.
 *
 * The counted proof summary of `incremental-graph-journal-storage.md` §Change-bounded
 * proof summary holds the admitted invalidations as coordinate maxima keyed by the
 * scope each declares: a node, a `(node, occurrence)` or a `(node, occurrence, input)`.
 * This module encodes and decodes those maxima and the summary's validation and selected
 * maps, which together are the whole of the summary's containers.
 *
 * Every field is decoded strictly: a scope which is not the shape this codec writes is
 * reported as an error, so the entry point can treat it as the missing/stale case.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').ValidateEvent} ValidateEvent */
/** @typedef {import('../journal/oracle/invalidations').CoordinateMaximum} CoordinateMaximum */
/** @typedef {import('./proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */

const {
    encodeJournalRecord,
    journalSequenceToString,
    makeJournalSequence,
} = require("../journal");
const { ProofSummaryClass } = require("./proof_summary");
const {
    compareText,
    decodeSelected,
    decodeValidationMap,
    encodeSelected,
    fieldOf,
    malformed,
} = require("./state_codec_records");

/**
 * One coordinate maximum as a sorted list of `[writer, sequence]` text pairs.
 * @param {CoordinateMaximum} maximum
 * @returns {Array<[string, string]>}
 */
function encodeMaximum(maximum) {
    return [...maximum.entries()]
        .sort(([left], [right]) => compareText(left, right))
        .map(([name, sequence]) => [name, journalSequenceToString(sequence)]);
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {CoordinateMaximum | JournalError}
 */
function decodeMaximum(value, what) {
    if (!Array.isArray(value)) {
        return malformed(what);
    }
    /** @type {CoordinateMaximum} */
    const maximum = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || typeof entry[1] !== "string") {
            return malformed(what + " entry");
        }
        const sequence = makeJournalSequence(entry[1]);
        if (sequence instanceof Error) {
            return sequence;
        }
        maximum.set(entry[0], sequence);
    }
    return maximum;
}

/**
 * The counted summary's containers as one plain object.
 * @param {ProofSummary} proofs
 * @returns {object}
 */
function encodeProofs(proofs) {
    /** @type {Array<[string, Array<[string, string]>]>} */
    const certificates = [];
    for (const [nodeKeyString, byRecord] of proofs.certificates) {
        certificates.push([
            nodeKeyString,
            [...byRecord.entries()]
                .sort(([left], [right]) => compareText(left, right))
                .map(([recordId, record]) => [recordId, encodeJournalRecord(record)]),
        ]);
    }
    return {
        selected: encodeSelected(proofs.selected),
        certificates,
        nodeScoped: [...proofs.nodeScoped.entries()].map(([nodeKeyString, maximum]) => [
            nodeKeyString,
            encodeMaximum(maximum),
        ]),
        valueScoped: [...proofs.valueScoped.entries()].map(([nodeKeyString, byValue]) => [
            nodeKeyString,
            [...byValue.entries()].map(([valueId, maximum]) => [valueId, encodeMaximum(maximum)]),
        ]),
        proofScoped: [...proofs.proofScoped.entries()].map(([nodeKeyString, byValue]) => [
            nodeKeyString,
            [...byValue.entries()].map(([valueId, byInput]) => [
                valueId,
                [...byInput.entries()].map(([inputKeyString, maximum]) => [inputKeyString, encodeMaximum(maximum)]),
            ]),
        ]),
    };
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Map<string, Map<string, CoordinateMaximum>> | JournalError}
 */
function decodeValueScoped(value, what) {
    if (!Array.isArray(value)) {
        return malformed(what);
    }
    /** @type {Map<string, Map<string, CoordinateMaximum>>} */
    const scopes = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !Array.isArray(entry[1])) {
            return malformed(what + " entry");
        }
        /** @type {Map<string, CoordinateMaximum>} */
        const byValue = new Map();
        for (const inner of entry[1]) {
            if (!Array.isArray(inner) || inner.length !== 2 || typeof inner[0] !== "string") {
                return malformed(what + " inner entry");
            }
            const maximum = decodeMaximum(inner[1], what + " maximum");
            if (maximum instanceof Error) {
                return maximum;
            }
            byValue.set(inner[0], maximum);
        }
        scopes.set(entry[0], byValue);
    }
    return scopes;
}

/**
 * @param {unknown} value
 * @param {string} what
 * @returns {Map<string, Map<string, Map<string, CoordinateMaximum>>> | JournalError}
 */
function decodeProofScoped(value, what) {
    if (!Array.isArray(value)) {
        return malformed(what);
    }
    /** @type {Map<string, Map<string, Map<string, CoordinateMaximum>>>} */
    const scopes = new Map();
    for (const entry of value) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !Array.isArray(entry[1])) {
            return malformed(what + " entry");
        }
        /** @type {Map<string, Map<string, CoordinateMaximum>>} */
        const byValue = new Map();
        for (const inner of entry[1]) {
            if (!Array.isArray(inner) || inner.length !== 2 || typeof inner[0] !== "string" || !Array.isArray(inner[1])) {
                return malformed(what + " inner entry");
            }
            /** @type {Map<string, CoordinateMaximum>} */
            const byInput = new Map();
            for (const deepest of inner[1]) {
                if (!Array.isArray(deepest) || deepest.length !== 2 || typeof deepest[0] !== "string") {
                    return malformed(what + " deepest entry");
                }
                const maximum = decodeMaximum(deepest[1], what + " maximum");
                if (maximum instanceof Error) {
                    return maximum;
                }
                byInput.set(deepest[0], maximum);
            }
            byValue.set(inner[0], byInput);
        }
        scopes.set(entry[0], byValue);
    }
    return scopes;
}

/**
 * @param {unknown} value
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {ProofSummary | JournalError}
 */
function decodeProofs(value, currentInputKeysOfNode) {
    if (typeof value !== "object" || value === null) {
        return malformed("proofs");
    }
    const selected = decodeSelected(fieldOf(value, "selected"), "proofs.selected");
    if (selected instanceof Error) {
        return selected;
    }
    const certificatesValue = fieldOf(value, "certificates");
    if (!Array.isArray(certificatesValue)) {
        return malformed("proofs.certificates");
    }
    /** @type {Map<string, Map<string, ValidateEvent>>} */
    const certificates = new Map();
    for (const entry of certificatesValue) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            return malformed("proofs.certificates entry");
        }
        const records = decodeValidationMap(entry[1], "proofs.certificates records");
        if (records instanceof Error) {
            return records;
        }
        certificates.set(entry[0], records);
    }
    const nodeScopedValue = fieldOf(value, "nodeScoped");
    if (!Array.isArray(nodeScopedValue)) {
        return malformed("proofs.nodeScoped");
    }
    /** @type {Map<string, CoordinateMaximum>} */
    const nodeScoped = new Map();
    for (const entry of nodeScopedValue) {
        if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string") {
            return malformed("proofs.nodeScoped entry");
        }
        const maximum = decodeMaximum(entry[1], "proofs.nodeScoped maximum");
        if (maximum instanceof Error) {
            return maximum;
        }
        nodeScoped.set(entry[0], maximum);
    }
    const valueScoped = decodeValueScoped(fieldOf(value, "valueScoped"), "proofs.valueScoped");
    if (valueScoped instanceof Error) {
        return valueScoped;
    }
    const proofScoped = decodeProofScoped(fieldOf(value, "proofScoped"), "proofs.proofScoped");
    if (proofScoped instanceof Error) {
        return proofScoped;
    }
    return new ProofSummaryClass(
        selected,
        currentInputKeysOfNode,
        certificates,
        nodeScoped,
        valueScoped,
        proofScoped
    );
}

module.exports = {
    decodeMaximum,
    decodeProofs,
    decodeProofScoped,
    decodeValueScoped,
    encodeMaximum,
    encodeProofs,
};
