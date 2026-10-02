/**
 * Synchronization normalization: what a raw retained union still owes the graph.
 *
 * `incremental-graph-journal-sync.md` §Normalization versus raw union is explicit
 * that a raw union may select a graph state that neither input separately
 * materialized, and that the receiver is responsible for appending the
 * normalization records which make that state materializable. This module is the
 * executable form of the two phases which do that.
 *
 * **Phase 1 — dependency-closure removal.** `sync.md` §Phase 1 removes every
 * selected-present node whose required direct input is absent under the raw
 * selected-head view, and then every selected-present dependent of such a node,
 * ordered cause before dependent. Removing a node removes the inputs its
 * dependents have, so the closure is a forward reachability problem over the
 * selected-present subgraph of the current schema.
 *
 * **Phase 2 — stale propagation.** `sync.md` §Phase 2 persists staleness caused
 * only by stale direct inputs. A node which is self-proof-ready and yet not fresh
 * can be stale for exactly one reason, because freshness is the conjunction of
 * self-proof-readiness and its inputs' freshness: one of its direct inputs is
 * stale. Those, and only those, are the occurrences needing a marker. The replay
 * projection already names them, in `unmarkedPropagatedStaleness`, so this module
 * reads that set rather than deriving a second, subtly different one.
 *
 * Both phases are graph-sized. Neither reads a retained record to decide.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').JournalRecord} JournalRecord */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/heads').HeadSelection} HeadSelection */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./authoring').SyncDeleteRequest} SyncDeleteRequest */
/** @typedef {import('./authoring').SyncInvalidateRequest} SyncInvalidateRequest */

const { isPresent } = require("../journal");

/**
 * The current schema's direct inputs of one node.
 * @callback CurrentInputKeysOfNode
 * @param {string} nodeKeyString
 * @returns {ReadonlyArray<string>}
 */

/**
 * The properties that this class carries are:
 * - `nodes` is the forward closure of structurally non-materializable selected
 *   occurrences, and `requests` names them in an order in which every node's
 *   removed direct inputs precede it.
 *
 * The proof of those properties is guaranteed by:
 * - `planDependencyClosureRemoval(...)`: it seeds the closure with every
 *   selected-present node which has an absent required direct input, follows only
 *   structural edges from selected-present nodes to their selected-present
 *   dependents, and orders the result by a topological walk of those same edges,
 *   which a cycle-free current schema admits.
 *
 * @param {ReadonlyArray<NodeKey>} nodes
 * @param {ReadonlyArray<SyncDeleteRequest>} requests
 */
class ClosureRemovalClass {
    /**
     * @param {ReadonlyArray<NodeKey>} nodes
     * @param {ReadonlyArray<SyncDeleteRequest>} requests
     */
    constructor(nodes, requests) {
        this.nodes = nodes;
        this.requests = requests;
    }
}

/** @typedef {ClosureRemovalClass} ClosureRemoval */

/**
 * @param {unknown} value
 * @returns {value is ClosureRemoval}
 */
function isClosureRemoval(value) {
    return value instanceof ClosureRemovalClass;
}

/**
 * Plan the structural removals the raw selected-head view still owes.
 *
 * @param {object} plan
 * @param {Map<string, HeadSelection>} plan.selections - The raw selected heads.
 * @param {CurrentInputKeysOfNode} plan.currentInputKeysOfNode
 * @returns {ClosureRemoval}
 */
function planDependencyClosureRemoval(plan) {
    const { selections, currentInputKeysOfNode } = plan;
    /** @type {Array<string>} */
    const present = [...selections.keys()].filter(
        (nodeKeyString) => isPresent(selections, nodeKeyString)
    );

    /** @type {Map<string, ReadonlyArray<string>>} */
    const inputsOf = new Map();
    for (const nodeKeyString of present) {
        const selection = selections.get(nodeKeyString);
        if (selection === undefined) {
            continue;
        }
        inputsOf.set(nodeKeyString, currentInputKeysOfNode(nodeKeyString));
    }

    /**
     * The selected-present nodes which depend on `nodeKeyString`, in ascending
     * canonical order. Only present nodes are dependents: an absent node has no
     * materialized occurrence to remove.
     * @param {string} nodeKeyString
     * @returns {ReadonlyArray<string>}
     */
    function dependentsOf(nodeKeyString) {
        /** @type {string[]} */
        const found = [];
        for (const candidate of present) {
            const inputs = inputsOf.get(candidate);
            if (inputs === undefined || !inputs.includes(nodeKeyString)) {
                continue;
            }
            found.push(candidate);
        }
        return found;
    }

    /** @type {string[]} */
    const closure = [];
    /** @type {Set<string>} */
    const seen = new Set();
    /** @type {string[]} */
    const stack = [];
    for (const nodeKeyString of present) {
        const inputs = inputsOf.get(nodeKeyString);
        if (inputs === undefined) {
            continue;
        }
        if (inputs.some((input) => !isPresent(selections, input))) {
            stack.push(nodeKeyString);
        }
    }
    while (stack.length > 0) {
        const nodeKeyString = stack.pop();
        if (nodeKeyString === undefined || seen.has(nodeKeyString)) {
            continue;
        }
        seen.add(nodeKeyString);
        closure.push(nodeKeyString);
        for (const dependent of dependentsOf(nodeKeyString)) {
            if (seen.has(dependent)) {
                continue;
            }
            stack.push(dependent);
        }
    }

    // Cause before dependent: a node's removed inputs precede it. The current
    // schema is acyclic, so the closure's induced subgraph is too and the walk
    // below emits every node. Ascending canonical order breaks ties so the
    // publication is a function of the retained journal, not of traversal order.
    const inClosure = new Set(closure);
    /** @type {Map<string, number>} */
    const unsatisfied = new Map();
    for (const nodeKeyString of closure) {
        const inputs = inputsOf.get(nodeKeyString) ?? [];
        unsatisfied.set(
            nodeKeyString,
            inputs.filter((input) => inClosure.has(input)).length
        );
    }
    /** @type {string[]} */
    const ordered = [];
    /** @type {string[]} */
    const remaining = closure.slice();
    while (remaining.length > 0) {
        /** @type {string[]} */
        const ready = [];
        for (const nodeKeyString of remaining) {
            if (unsatisfied.get(nodeKeyString) === 0) {
                ready.push(nodeKeyString);
            }
        }
        if (ready.length === 0) {
            break;
        }
        ready.sort();
        for (const nodeKeyString of ready) {
            remaining.splice(remaining.indexOf(nodeKeyString), 1);
            ordered.push(nodeKeyString);
        }
        for (const nodeKeyString of ready) {
            for (const dependent of dependentsOf(nodeKeyString)) {
                if (!inClosure.has(dependent) || ordered.includes(dependent)) {
                    continue;
                }
                const count = unsatisfied.get(dependent);
                unsatisfied.set(dependent, (count === undefined ? 0 : count) - 1);
            }
        }
    }
    for (const nodeKeyString of remaining) {
        ordered.push(nodeKeyString);
    }

    /** @type {Array<NodeKey>} */
    const nodes = [];
    /** @type {Array<SyncDeleteRequest>} */
    const requests = [];
    for (const nodeKeyString of ordered) {
        const selection = selections.get(nodeKeyString);
        if (selection === undefined) {
            continue;
        }
        nodes.push(selection.nodeKey);
        requests.push({ node: selection.nodeKey });
    }
    return new ClosureRemovalClass(nodes, requests);
}

/**
 * The properties that this class carries are:
 * - `requests` names exactly the occurrences which are self-proof-ready yet not
 *   fresh at `projection`, and each names the value occurrence the projection
 *   selected for its node.
 *
 * The proof of those properties is guaranteed by:
 * - `planStalePropagation(...)`: it reads `projection.unmarkedPropagatedStaleness`,
 *   which `projectRetainedJournal` computes as the self-proof-ready nodes whose
 *   derived freshness is false, and it names `projection`'s own selected
 *   occurrence of each.
 *
 * @param {ReadonlyArray<SyncInvalidateRequest>} requests
 */
class StalePropagationClass {
    /**
     * @param {ReadonlyArray<SyncInvalidateRequest>} requests
     */
    constructor(requests) {
        this.requests = requests;
    }
}

/** @typedef {StalePropagationClass} StalePropagation */

/**
 * @param {unknown} value
 * @returns {value is StalePropagation}
 */
function isStalePropagation(value) {
    return value instanceof StalePropagationClass;
}

/**
 * Plan the stale markers the projection of the normalized journal still owes.
 *
 * @param {Projection} projection - The projection of the Phase 1 journal.
 * @returns {StalePropagation}
 */
function planStalePropagation(projection) {
    const byKey = new Map(
        projection.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence])
    );
    /** @type {SyncInvalidateRequest[]} */
    const requests = [];
    for (const nodeKeyString of [...projection.unmarkedPropagatedStaleness].sort()) {
        const occurrence = byKey.get(nodeKeyString);
        if (occurrence === undefined) {
            continue;
        }
        requests.push({ node: occurrence.nodeKey, value: occurrence.valueId });
    }
    return new StalePropagationClass(requests);
}

module.exports = {
    ClosureRemovalClass,
    StalePropagationClass,
    isClosureRemoval,
    isStalePropagation,
    planDependencyClosureRemoval,
    planStalePropagation,
};