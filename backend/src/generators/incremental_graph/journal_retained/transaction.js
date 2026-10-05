/**
 * Staging a delta into the retained replay state as a transaction.
 *
 * `incremental-graph-journal-sync.md` §Atomic publication states that failure before
 * cutover leaves the previous active supported state selected. The retained replay
 * state is the receiver's active in-memory derived state, and the fold
 * (`stageRetainedRecords`) and the delta projection (`projectRetainedReplay`) both
 * extend the object they are given in place. Staging directly into the caller's state
 * would therefore leave that state describing records the receiver never committed
 * when a later step of the same operation fails, which contradicts the clause above:
 * the selected state would not be the previous one.
 *
 * So the work happens on a fork. `forkRetainedReplayState` copies every container the
 * fold and the projection write into, which is what makes the fork independent of the
 * state it was taken from, and `commitRetainedReplayState` publishes the fork's
 * contents into the caller's own object. The identity of the caller's state is
 * therefore preserved across a successful operation — a caller which staged and then
 * handed the same object to the cutover keeps holding the object it staged — while a
 * failed operation leaves every field of it exactly as it was found.
 *
 * The copy is proportional to the graph: the head candidates, the counted summary's
 * scopes and the previous cut's resolution, none of which is a retained record.
 */

/** @typedef {import('./proof_summary').CurrentInputKeysOfNode} CurrentInputKeysOfNode */
/** @typedef {import('./proof_summary').ProofSummary} ProofSummary */
/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

const { ProofSummaryClass } = require("./proof_summary");
const { RetainedReplayStateClass } = require("./retained");

/**
 * @template V
 * @param {ReadonlyMap<string, V>} original
 * @returns {Map<string, V>}
 */
function copyScopes(original) {
    return new Map(original);
}

/**
 * @template V
 * @param {ReadonlyMap<string, ReadonlyMap<string, V>>} original
 * @returns {Map<string, Map<string, V>>}
 */
function copyOneLevelDown(original) {
    /** @type {Map<string, Map<string, V>>} */
    const copied = new Map();
    for (const [outer, inner] of original) {
        copied.set(outer, new Map(inner));
    }
    return copied;
}

/**
 * @template V
 * @param {ReadonlyMap<string, ReadonlyMap<string, ReadonlyMap<string, V>>>} original
 * @returns {Map<string, Map<string, Map<string, V>>>}
 */
function copyTwoLevelsDown(original) {
    /** @type {Map<string, Map<string, Map<string, V>>>} */
    const copied = new Map();
    for (const [outer, middle] of original) {
        /** @type {Map<string, Map<string, V>>} */
        const copiedMiddle = new Map();
        for (const [inner, deepest] of middle) {
            copiedMiddle.set(inner, new Map(deepest));
        }
        copied.set(outer, copiedMiddle);
    }
    return copied;
}

/**
 * The counted summary of a fork, with every container it writes into copied.
 *
 * @param {ProofSummary} summary
 * @returns {ProofSummary}
 */
function forkProofSummary(summary) {
    return new ProofSummaryClass(
        new Map(summary.selected),
        summary.currentInputKeysOfNode,
        copyOneLevelDown(summary.certificates),
        copyOneLevelDown(summary.nodeScoped),
        copyOneLevelDown(summary.valueScoped),
        copyTwoLevelsDown(summary.proofScoped)
    );
}

/**
 * A fork of the retained replay state, independent of the state it was taken from.
 *
 * The properties this fork carries are the ones the state class documents, and the
 * proof is that each container the fold and the projection write into is a fresh copy
 * here, while every value they hold is immutable once constructed: a head candidate,
 * a stored validation, a coordinate and a resolved certificate are all replaced
 * rather than modified, so sharing them cannot carry a change back to the state the
 * fork was taken from.
 *
 * @param {RetainedReplayState} state
 * @returns {RetainedReplayState}
 */
function forkRetainedReplayState(state) {
    return new RetainedReplayStateClass(
        copyScopes(state.heads),
        forkProofSummary(state.proofs),
        copyScopes(state.certificates),
        copyScopes(state.selected),
        new Set(state.touched),
        copyScopes(state.writers),
        copyScopes(state.admittedLengths),
        state.lastNodeIndex,
        state.localWriter,
        state.currentInputKeysOfNode
    );
}

/**
 * Publish a fork's contents into the state it was taken from.
 *
 * The target keeps its identity and gains every field of the fork, so a caller which
 * staged a state and then synchronized against it still holds the object the
 * synchronization extended once the synchronization has succeeded.
 *
 * @param {RetainedReplayState} target
 * @param {RetainedReplayState} fork
 * @returns {RetainedReplayState}
 */
function commitRetainedReplayState(target, fork) {
    target.heads = fork.heads;
    target.proofs = fork.proofs;
    target.certificates = fork.certificates;
    target.selected = fork.selected;
    target.touched = fork.touched;
    target.writers = fork.writers;
    target.admittedLengths = fork.admittedLengths;
    target.lastNodeIndex = fork.lastNodeIndex;
    return target;
}

module.exports = {
    commitRetainedReplayState,
    forkRetainedReplayState,
};

