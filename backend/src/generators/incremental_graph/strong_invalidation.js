/**
 * Strong invalidation helpers for validity-proof revocation.
 */

const { nodeIdentifierToString, ReplicaStateInvariantError } = require("./database");

/** @typedef {import('./graph_state').BatchBuilder} BatchBuilder */
/** @typedef {import('./types').NodeIdentifier} NodeIdentifier */

/**
 * Remove N from every dependency validity set.
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} nodeIdentifier
 * @param {NodeIdentifier[]} inputEdges
 * @returns {void}
 */
function revokeIncomingValidity(batch, nodeIdentifier, inputEdges) {
    for (const input of inputEdges) {
        batch.valid.remove(input, nodeIdentifier);
    }
}

/**
 * Consume the outgoing validity frontier starting at `startIdentifier`.
 *
 * Every traversed validity edge is removed. Each reached dependent is marked
 * potentially-outdated and its own outgoing frontier is expanded at most once.
 * Edge processing is deliberately independent from node expansion so fan-in and
 * diamond graphs revoke every causal proof.
 *
 * @param {import('./graph_state').GraphStorage} storage
 * @param {BatchBuilder} batch
 * @param {NodeIdentifier} startIdentifier
 * @returns {Promise<void>}
 */
async function invalidateDependentsFrom(storage, batch, startIdentifier) {
    /** @type {Set<string>} */
    const expanded = new Set();
    /** @type {NodeIdentifier[]} */
    const worklist = [startIdentifier];

    while (worklist.length > 0) {
        const current = worklist.pop();
        if (current === undefined) continue;
        const currentString = nodeIdentifierToString(current);
        if (expanded.has(currentString)) continue;
        expanded.add(currentString);

        const dependents = await storage.getValid(current, batch);
        for (const dependent of dependents) {
            batch.valid.remove(current, dependent);
            const dependentString = nodeIdentifierToString(dependent);
            const freshness = await batch.freshness.get(dependent);
            if (freshness === undefined) {
                throw new ReplicaStateInvariantError(
                    "invalidation",
                    "valid edge references unmaterialized dependent",
                    dependentString
                );
            }
            if (freshness !== "up-to-date" && freshness !== "potentially-outdated") {
                throw new ReplicaStateInvariantError(
                    "invalidation",
                    `has unexpected freshness ${freshness}`,
                    dependentString
                );
            }
            batch.freshness.put(dependent, "potentially-outdated");
            if (!expanded.has(dependentString)) {
                worklist.push(dependent);
            }
        }
    }
}

module.exports = {
    invalidateDependentsFrom,
    revokeIncomingValidity,
};
