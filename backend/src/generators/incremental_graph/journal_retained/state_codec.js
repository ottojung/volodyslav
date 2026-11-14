/**
 * The durable codec of the retained replay state.
 *
 * `incremental-graph-journal-storage.md` §Change-bounded proof summary requires the
 * active/staged Journal state to provide, or be accompanied by, an incrementally
 * maintained derived summary, and requires imported/reset-authored records to update a
 * staged summary before cutover. §Derived indexes requires a maintained index to be
 * updated in durable staging before the state it describes becomes active. A state
 * which is only ever rebuilt by traversal cannot satisfy either clause: it has to
 * survive the process which published the records, because the synchronization and
 * reset lifecycles close and reopen the database and reconstruct the receiver's
 * retained state without scanning its history.
 *
 * This module is that survival. It serializes exactly the containers
 * `retained.js`'s state class declares — the head selection, the counted proof
 * summary's selected occurrences, certificates and scope maxima, the resolved
 * certificate of the last cut, the selected occurrence of the last cut, the admitted
 * writers and lengths, and the local writer's allocator watermark — using the Journal
 * layer's own canonical record text and identity helpers. Deserializing rebuilds the
 * same classes, so a consumer cannot tell a decoded state from a maintained one.
 *
 * The per-field encode/decode lives in `state_codec_fields.js`; this module assembles
 * the state and decides the format and local-writer checks. `currentInputKeysOfNode` is
 * a function and is therefore not encoded: it is supplied by the caller from the schema
 * the state is being read under, exactly as `buildRetainedReplayState` takes it.
 *
 * A state which does not decode is rejected rather than partially accepted: a
 * malformed summary is the missing/stale-summary case §Change-bounded proof summary
 * reserves for explicit rebuild/maintenance, so the caller fails closed instead of
 * consuming a summary which describes a different admitted state.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('../journal/types').JournalSequence} JournalSequence */
/** @typedef {import('./proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */
/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

const {
    journalAuthorToString,
    journalSequenceToString,
    makeJournalAuthor,
    makeJournalSourceReadError,
} = require("../journal");
const {
    RETAINED_STATE_FORMAT,
    RETAINED_STATE_VERSION,
    decodeCertificates,
    decodeHeads,
    decodeSelected,
    encodeCertificates,
    encodeHeads,
    encodeSelected,
    malformed,
} = require("./state_codec_records");
const {
    decodeMaximum,
    decodeProofs,
    encodeProofs,
} = require("./state_codec_scopes");
const { ProofSummaryClass } = require("./proof_summary");
const { RetainedReplayStateClass } = require("./retained");

/**
 * The empty retained replay state of a journal which retains nothing.
 *
 * A genuinely fresh replica holds no record, so its summary is empty rather than
 * missing: initializing it is not a scan of retained history and is the one state a
 * publication can start from without one.
 *
 * @param {JournalAuthor} localWriter
 * @param {CurrentInputKeysOfNode} currentInputKeysOfNode
 * @returns {RetainedReplayState}
 */
function makeEmptyRetainedReplayState(localWriter, currentInputKeysOfNode) {
    return new RetainedReplayStateClass(
        new Map(),
        new ProofSummaryClass(new Map(), currentInputKeysOfNode, new Map(), new Map(), new Map(), new Map()),
        new Map(),
        new Map(),
        new Set(),
        new Map(),
        new Map(),
        0,
        localWriter,
        currentInputKeysOfNode
    );
}

/**
 * The canonical JSON body of a retained replay state.
 * @param {RetainedReplayState} state
 * @returns {object}
 */
function encodeState(state) {
    return {
        format: RETAINED_STATE_FORMAT,
        version: RETAINED_STATE_VERSION,
        localWriter: journalAuthorToString(state.localWriter),
        lastNodeIndex: state.lastNodeIndex,
        writers: [...state.writers.keys()].sort(),
        admittedLengths: [...state.admittedLengths.entries()]
            .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
            .map(([name, sequence]) => [name, journalSequenceToString(sequence)]),
        touched: [...state.touched].sort(),
        heads: encodeHeads(state.heads),
        selected: encodeSelected(state.selected),
        certificates: encodeCertificates(state.certificates),
        proofs: encodeProofs(state.proofs),
    };
}

/**
 * The canonical JSON text of a retained replay state.
 *
 * @param {RetainedReplayState} state
 * @returns {string}
 */
function serializeRetainedReplayState(state) {
    return JSON.stringify(encodeState(state));
}

/**
 * Rebuild one retained replay state from its canonical text.
 *
 * The state is only accepted when the text is the format this codec writes and every
 * field decodes. A caller which receives an error treats the summary as missing and
 * enters explicit rebuild/maintenance, exactly as §Change-bounded proof summary
 * requires of a summary which is absent or does not describe the receiver.
 *
 * @param {string} text
 * @param {object} request
 * @param {JournalAuthor} request.localWriter - The receiver's own writer, which the
 *   decoded state must name. The state's local writer is stored in the text and is
 *   checked against this value, so a summary built for another writer is refused here
 *   as well as by the correspondence check.
 * @param {CurrentInputKeysOfNode} request.currentInputKeysOfNode
 * @returns {RetainedReplayState | JournalError}
 */
function deserializeRetainedReplayState(text, request) {
    const { localWriter, currentInputKeysOfNode } = request;
    let parsed;
    try {
        parsed = JSON.parse(text);
    } catch {
        return malformed("the state text is not valid JSON");
    }
    if (typeof parsed !== "object" || parsed === null) {
        return malformed("the state is not an object");
    }
    if (parsed.format !== RETAINED_STATE_FORMAT) {
        return malformed("the state format tag");
    }
    if (parsed.version !== RETAINED_STATE_VERSION) {
        return malformed("the state codec version");
    }
    if (typeof parsed.localWriter !== "string") {
        return malformed("localWriter");
    }
    const storedWriter = makeJournalAuthor(parsed.localWriter);
    if (storedWriter instanceof Error) {
        return storedWriter;
    }
    if (journalAuthorToString(storedWriter) !== journalAuthorToString(localWriter)) {
        return makeJournalSourceReadError(
            "the persisted retained replay state was built for local writer " +
                JSON.stringify(parsed.localWriter) +
                " but this receiver's writer is " +
                JSON.stringify(journalAuthorToString(localWriter))
        );
    }
    if (typeof parsed.lastNodeIndex !== "number" || !Number.isSafeInteger(parsed.lastNodeIndex) || parsed.lastNodeIndex < 0) {
        return malformed("lastNodeIndex");
    }
    if (!Array.isArray(parsed.writers) || parsed.writers.some((/** @type {unknown} */ name) => typeof name !== "string")) {
        return malformed("writers");
    }
    /** @type {Map<string, JournalAuthor>} */
    const writers = new Map();
    for (const name of parsed.writers) {
        const author = makeJournalAuthor(name);
        if (author instanceof Error) {
            return author;
        }
        writers.set(name, author);
    }
    const admitted = decodeMaximum(parsed.admittedLengths, "admittedLengths");
    if (admitted instanceof Error) {
        return admitted;
    }
    /** @type {Map<string, JournalSequence>} */
    const admittedLengths = new Map();
    for (const [name, sequence] of admitted) {
        admittedLengths.set(name, sequence);
    }
    if (!Array.isArray(parsed.touched) || parsed.touched.some((/** @type {unknown} */ name) => typeof name !== "string")) {
        return malformed("touched");
    }
    const heads = decodeHeads(parsed.heads);
    if (heads instanceof Error) {
        return heads;
    }
    const selected = decodeSelected(parsed.selected, "selected");
    if (selected instanceof Error) {
        return selected;
    }
    const certificates = decodeCertificates(parsed.certificates);
    if (certificates instanceof Error) {
        return certificates;
    }
    const proofs = decodeProofs(parsed.proofs, currentInputKeysOfNode);
    if (proofs instanceof Error) {
        return proofs;
    }
    return new RetainedReplayStateClass(
        heads,
        proofs,
        certificates,
        selected,
        new Set(parsed.touched),
        writers,
        admittedLengths,
        parsed.lastNodeIndex,
        localWriter,
        currentInputKeysOfNode
    );
}

module.exports = {
    RETAINED_STATE_FORMAT,
    RETAINED_STATE_VERSION,
    deserializeRetainedReplayState,
    makeEmptyRetainedReplayState,
    serializeRetainedReplayState,
};
