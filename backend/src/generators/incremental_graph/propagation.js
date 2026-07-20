/**
 * Freshness-only propagation helper for invalidation and changed-value handling.
 *
 * The only responsibility is to mark a downstream validity frontier
 * potentially-outdated without mutating any validity edges.
 */

const { nodeIdentifierToString } = require("./database");

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./graph_state').GraphStorage} GraphStorage */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * Mark a downstream validity frontier potentially-outdated.
 *
 * Uses an iterative worklist. Reads valid[current] to find dependents,
 * marks them stale if not already, and continues through their own
 * outgoing validity frontiers. Never adds, removes, or clears validity.
 *
 * @param {GraphStorage} storage
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier[]} initialDependents
 * @returns {Promise<void>}
 */
async function propagatePotentiallyOutdated(storage, batch, initialDependents) {
    /** @type {Set<string>} */
    const visited = new Set();
    /** @type {NodeIdentifier[]} */
    const worklist = [...initialDependents];

    while (worklist.length > 0) {
        const current = worklist.pop();
        if (current === undefined) continue;
        const currentString = nodeIdentifierToString(current);
        if (visited.has(currentString)) continue;
        visited.add(currentString);

        const dependents = await storage.getValid(current, batch);
        for (const dependent of dependents) {
            const dependentString = nodeIdentifierToString(dependent);
            if (visited.has(dependentString)) continue;
            const freshness = await batch.freshness.get(dependent);
            if (freshness === "up-to-date") {
                batch.freshness.put(dependent, "potentially-outdated");
            }
            worklist.push(dependent);
        }
    }
}

module.exports = {
    propagatePotentiallyOutdated,
};
