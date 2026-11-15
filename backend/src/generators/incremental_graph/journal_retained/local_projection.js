/**
 * Resolve one local publication over its affected dependency closure only.
 * The previous cut was fully validated. Exact current head/identity indices
 * make the new publication's graph checks change-bounded as well.
 */
const { isValueEvent, makeJournalProjectionError } = require("../journal");
const { nodeIdentifierToString } = require("../database");
const { resolveCertificate, selectedValueIdOf } = require("./retained");

/** @typedef {import('./retained').RetainedReplayState} RetainedReplayState */

/**
 * The input graph is fixed by the prepared graph scheme captured when
 * IncrementalGraph constructs its GraphStorage. An ordinary Journal record
 * cannot change that schema; migration builds a new graph instance and fully
 * rebuilds the retained projection. Therefore the indexed dependency edges
 * need not be refreshed for a node merely because its value changes.
 *
 * @param {RetainedReplayState} state
 * @param {string} node
 * @param {Set<string>} indexed
 * @param {Map<string, Set<string>>} dependents
 */
function indexNode(state, node, indexed, dependents) {
    if (indexed.has(node)) return;
    indexed.add(node);
    for (const input of state.currentInputKeysOfNode(node)) {
        const neighbors = dependents.get(input) ?? new Set();
        neighbors.add(node);
        dependents.set(input, neighbors);
    }
}

/** @param {RetainedReplayState} state */
function ensureIndex(state) {
    if (state.localIndex !== undefined) return state.localIndex;
    const indexed = new Set();
    /** @type {Map<string, Set<string>>} */
    const dependents = new Map();
    /** @type {Map<string, string>} */
    const owners = new Map();
    /** @type {Map<string, string>} */
    const byNode = new Map();
    for (const [node, selection] of state.heads) {
        indexNode(state, node, indexed, dependents);
        const winner = selection.winner;
        if (winner !== undefined && isValueEvent(winner)) {
            const id = nodeIdentifierToString(winner.nodeIdentifier);
            owners.set(id, node);
            byNode.set(node, id);
        }
    }
    state.localIndex = { indexed, dependents, owners, byNode };
    return state.localIndex;
}

/** @param {RetainedReplayState} state @returns {Error | undefined} */
function projectLocalRetainedReplay(state) {
    const { indexed, dependents, owners, byNode } = ensureIndex(state);
    for (const node of state.touched) {
        indexNode(state, node, indexed, dependents);
        const prior = byNode.get(node);
        if (prior !== undefined && owners.get(prior) === node) owners.delete(prior);
        byNode.delete(node);
    }
    for (const node of state.touched) {
        const id = selectedValueIdOf(state.heads, node);
        if (id === undefined) {
            state.selected.delete(node);
            state.proofs.selected.delete(node);
            state.proofs.certificates.delete(node);
        } else {
            state.selected.set(node, id);
            state.proofs.selected.set(node, id);
        }
        const winner = state.heads.get(node)?.winner;
        if (winner !== undefined && isValueEvent(winner)) {
            const identifier = nodeIdentifierToString(winner.nodeIdentifier);
            const incumbent = owners.get(identifier);
            if (incumbent !== undefined && incumbent !== node) {
                return makeJournalProjectionError(
                    "present nodes " + incumbent + " and " + node +
                        " select the same physical node identifier " + identifier, node
                );
            }
            owners.set(identifier, node);
            byNode.set(node, identifier);
        }
    }
    const affected = new Set(state.touched);
    const pending = [...affected];
    while (pending.length > 0) {
        const current = pending.pop();
        if (current === undefined) continue;
        for (const neighbor of dependents.get(current) ?? []) {
            if (!affected.has(neighbor)) {
                affected.add(neighbor);
                pending.push(neighbor);
            }
        }
    }
    for (const node of affected) {
        const winner = state.heads.get(node)?.winner;
        if (winner !== undefined && isValueEvent(winner)) {
            for (const input of state.currentInputKeysOfNode(node)) {
                const dependency = state.heads.get(input)?.winner;
                if (dependency === undefined || !isValueEvent(dependency)) {
                    return makeJournalProjectionError(
                        "the selected head is present but its direct input is absent, so " +
                            "the selected head set is not dependency-closed", node
                    );
                }
            }
        }
        const certificate = resolveCertificate(state, node, state.selected);
        if (certificate === undefined) state.certificates.delete(node);
        else state.certificates.set(node, certificate);
    }
    state.lastAffected = affected;
    state.touched.clear();
    return undefined;
}

module.exports = { ensureIndex, projectLocalRetainedReplay };
