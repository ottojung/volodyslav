/**
 * Freshness-only propagation helper for invalidation and changed-value handling.
 *
 * The only responsibility is to mark a downstream validity frontier
 * potentially-outdated without mutating any validity edges.
 */

const { nodeIdentifierToString, ReplicaStateInvariantError } = require("./database");

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').GraphStorage} GraphStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * Mark a downstream validity frontier potentially-outdated.
 *
 * Uses an iterative worklist. Every popped node is itself marked stale,
 * then its outgoing validity frontier is read and transitively enqueued.
 * Never adds, removes, or clears validity.
 *
 * @param {GraphStorage} storage
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier[]} initialDependents
 * @returns {Promise<void>}
 */
async function propagatePotentiallyOutdated(storage, batch, initialDependents) {
    /** @type {Set<string>} */
    const expanded = new Set();
    /** @type {NodeIdentifier[]} */
    const worklist = [...initialDependents];

    while (worklist.length > 0) {
        const current = worklist.pop();
        if (current === undefined) continue;
        const currentString = nodeIdentifierToString(current);
        if (expanded.has(currentString)) continue;
        expanded.add(currentString);

        const freshness = await batch.freshness.get(current);
        if (freshness === undefined) {
            throw new ReplicaStateInvariantError(
                "propagation",
                "valid edge references unmaterialized dependent",
                currentString
            );
        }
        if (freshness !== "up-to-date" && freshness !== "potentially-outdated") {
            throw new ReplicaStateInvariantError(
                "propagation",
                `has unexpected freshness ${freshness}`,
                currentString
            );
        }
        if (freshness === "up-to-date") {
            batch.freshness.put(current, "potentially-outdated");
        }

        const dependents = await storage.getValid(current, batch);
        for (const dependent of dependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (!expanded.has(dependentString)) {
                worklist.push(dependent);
            }
        }
    }
}

module.exports = {
    propagatePotentiallyOutdated,
};
