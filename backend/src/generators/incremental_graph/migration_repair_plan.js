/**
 * The Pass M2/M3 planning of a Journal-aware migration.
 *
 * `incremental-graph-journal-migrations.md` §16 and §17 fix the records M2 and M3
 * author, and this module plans them against the cut each pass reads:
 *
 * - M2 reads `eligibleEffectiveProofUnion_P1(K)` at the fixed post-M1 cut, plans one
 *   occurrence-scoped barrier per edge `TargetValid(K)` does not want, and only then
 *   plans the target certificates replay does not already supply. A barrier is needed
 *   for every unwanted edge any eligible retained certificate could expose, not
 *   merely the selected certificate's edges, because replay prefers a certificate by
 *   effective basis match and a losing certificate could otherwise re-expose an edge;
 * - M3 plans the target-persistent-stale markers for the target-stale nodes whose own
 *   proof is ready, because recursive staleness through a stale input is not a
 *   persistent marker and a later upstream `Unchanged` would erase it.
 *
 * The planning is pure: it reads the cuts it is given and returns the requests the
 * caller authors, so the pass order and the allocation stay in the caller.
 */

/** @typedef {import('./journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./journal/basis').ValidationBasis} ValidationBasis */
/** @typedef {import('./journal/types').JournalAuthor} JournalAuthor */
/** @typedef {import('./journal/types').NodeKey} NodeKey */
/** @typedef {import('./journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('./journal/oracle/projection').Projection} Projection */
/** @typedef {import('./database/graph_scheme').GraphScheme} GraphScheme */
/** @typedef {import('./database/identifier_lookup').IdentifierLookup} IdentifierLookup */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./journal/migration_emission').MigrationRepairIntent} MigrationRepairIntent */

const {
    compareJournalSequence,
    journalSequenceAtFrontier,
    makeJournalProjectionError,
    makeValidationBasisEntry,
    sortValidationBasis,
} = require("./journal");
const {
    deriveInputPositions,
    nodeIdentifierToString,
    nodeKeyStringToString,
    stringToNodeIdentifier,
    stringToNodeKeyString,
} = require("./database");

/**
 * The current schema's direct input keys of one semantic node.
 *
 * A node the current schema does not contain has no current direct inputs, which is
 * what a historical node family absent from the target schema projects as.
 *
 * @param {GraphScheme} graphScheme
 * @returns {(nodeKeyString: string) => ReadonlyArray<string>}
 */
function makeCurrentInputKeysOfNode(graphScheme) {
    return (nodeKeyString) => {
        let key;
        try {
            key = stringToNodeKeyString(nodeKeyString);
        } catch {
            return [];
        }
        try {
            return deriveInputPositions(graphScheme, key).map(nodeKeyStringToString);
        } catch {
            return [];
        }
    };
}

/**
 * One target-present node as M2/M3 plan it: the occurrence Pass M1 settled on and
 * the validity edges and freshness the target graph persists for it.
 *
 * @typedef {object} TargetOccurrence
 * @property {string} nodeKeyString
 * @property {NodeKey} nodeKey
 * @property {JournalRecordId} valueId
 * @property {Set<string>} validInputs
 * @property {boolean} fresh
 */

/**
 * The target-present occurrences, read from the target journal's selected heads and
 * the target graph's persisted validity/freshness.
 *
 * @param {Projection} projection - The projection at the current cut.
 * @param {IdentifierLookup} targetLookup - The target replica's identifier lookup.
 * @param {Map<NodeIdentifier, NodeIdentifier[]>} desiredValid
 * @param {Map<NodeIdentifier, import('./database/types').Freshness>} targetFreshness
 * @returns {TargetOccurrence[]}
 */
function targetOccurrencesOf(projection, targetLookup, desiredValid, targetFreshness) {
    /**
     * @param {NodeIdentifier} identifier
     * @returns {string | undefined}
     */
    const keyStringOf = (identifier) => {
        const key = targetLookup.idToKey.get(nodeIdentifierToString(identifier));
        return key === undefined ? undefined : nodeKeyStringToString(key);
    };
    /** @type {Map<string, Set<string>>} */
    const validByDependent = new Map();
    for (const [input, dependents] of desiredValid) {
        const inputKey = keyStringOf(input);
        if (inputKey === undefined) {
            continue;
        }
        for (const dependent of dependents) {
            const dependentKey = keyStringOf(dependent);
            if (dependentKey === undefined) {
                continue;
            }
            const set = validByDependent.get(dependentKey) ?? new Set();
            set.add(inputKey);
            validByDependent.set(dependentKey, set);
        }
    }
    /** @type {TargetOccurrence[]} */
    const occurrences = [];
    for (const occurrence of projection.occurrences) {
        const key = occurrence.nodeKeyString;
        const identifier = stringToNodeIdentifier(nodeIdentifierToString(occurrence.nodeIdentifier));
        const freshness = targetFreshness.get(identifier);
        occurrences.push({
            nodeKeyString: key,
            nodeKey: occurrence.nodeKey,
            valueId: occurrence.valueId,
            validInputs: validByDependent.get(key) ?? new Set(),
            fresh: freshness === "up-to-date",
        });
    }
    return occurrences;
}

/**
 * Do two validity edge sets name exactly the same incoming edges?
 * @param {ReadonlySet<string>} left
 * @param {ReadonlySet<string>} right
 * @returns {boolean}
 */
function sameEdgeSet(left, right) {
    if (left.size !== right.size) {
        return false;
    }
    for (const edge of left) {
        if (!right.has(edge)) {
            return false;
        }
    }
    return true;
}

/**
 * @param {string} nodeKeyString
 * @param {string} inputKeyString
 * @returns {JournalError}
 */
function makeUnknownInputError(nodeKeyString, inputKeyString) {
    return makeJournalProjectionError(
        "the migration target validity edge " + inputKeyString + " -> " + nodeKeyString +
            " names an input occurrence the target does not settle",
        nodeKeyString
    );
}

/**
 * Plan the Pass M2 proof-edge barriers: every edge an eligible retained certificate
 * could expose which the target does not want.
 *
 * @param {object} plan
 * @param {Iterable<TargetOccurrence>} plan.targetOccurrences
 * @param {Map<string, Set<string>>} plan.unions
 * @param {(nodeKeyString: string) => NodeKey | undefined} plan.nodeKeyOf
 * @returns {MigrationRepairIntent[] | {error: JournalError}}
 */
function planProofBarriers(plan) {
    const { targetOccurrences, unions, nodeKeyOf } = plan;
    /** @type {MigrationRepairIntent[]} */
    const barriers = [];
    for (const occurrence of targetOccurrences) {
        const union = unions.get(occurrence.nodeKeyString);
        if (union === undefined) {
            continue;
        }
        for (const inputKeyString of [...union].sort()) {
            if (occurrence.validInputs.has(inputKeyString)) {
                continue;
            }
            const inputNodeKey = nodeKeyOf(inputKeyString);
            if (inputNodeKey === undefined) {
                return { error: makeUnknownInputError(occurrence.nodeKeyString, inputKeyString) };
            }
            barriers.push({
                kind: "migrate-proof-barrier",
                node: occurrence.nodeKey,
                value: occurrence.valueId,
                input: inputNodeKey,
            });
        }
    }
    return barriers;
}

/**
 * Plan the Pass M2 target certificates replay does not already supply.
 *
 * @param {object} plan
 * @param {Projection} plan.postBarrier
 * @param {Iterable<TargetOccurrence>} plan.targetOccurrences
 * @param {(nodeKeyString: string) => JournalRecordId | undefined} plan.valueIdOf
 * @param {(nodeKeyString: string) => NodeKey | undefined} plan.nodeKeyOf
 * @param {(nodeKeyString: string) => ReadonlyArray<string>} plan.currentInputKeysOfNode
 * @returns {MigrationRepairIntent[] | {error: JournalError}}
 */
function planTargetValidations(plan) {
    const { postBarrier, targetOccurrences, valueIdOf, nodeKeyOf, currentInputKeysOfNode } = plan;
    /** @type {MigrationRepairIntent[]} */
    const requests = [];
    for (const occurrence of targetOccurrences) {
        const freshness = postBarrier.freshness.get(occurrence.nodeKeyString);
        const yieldsTargetEdges =
            freshness !== undefined &&
            sameEdgeSet(freshness.validInputs, occurrence.validInputs);
        const coversTargetFreshness =
            !occurrence.fresh ||
            (freshness !== undefined &&
                freshness.certificate !== undefined &&
                freshness.certificate.coversValueInvalidations);
        if (yieldsTargetEdges && coversTargetFreshness) {
            continue;
        }
        /** @type {ValidationBasis} */
        const basis = [];
        for (const inputKeyString of currentInputKeysOfNode(occurrence.nodeKeyString)) {
            const inputNodeKey = nodeKeyOf(inputKeyString);
            if (inputNodeKey === undefined) {
                return { error: makeUnknownInputError(occurrence.nodeKeyString, inputKeyString) };
            }
            if (!occurrence.validInputs.has(inputKeyString)) {
                basis.push(makeValidationBasisEntry(inputNodeKey, "unknown"));
                continue;
            }
            const inputValueId = valueIdOf(inputKeyString);
            if (inputValueId === undefined) {
                return { error: makeUnknownInputError(occurrence.nodeKeyString, inputKeyString) };
            }
            basis.push(makeValidationBasisEntry(inputNodeKey, inputValueId));
        }
        requests.push({
            kind: "migrate-validate",
            node: occurrence.nodeKey,
            value: occurrence.valueId,
            basis: sortValidationBasis(basis),
        });
    }
    return requests;
}

/**
 * Does the retained history already hold a value-scoped invalidation of this
 * occurrence which the selected certificate does not observe?
 *
 * @param {import('./journal/oracle/invalidations').InvalidationSummary} summary
 * @param {import('./journal/oracle/certificates').SelectedCertificate | undefined} certificate
 * @param {(name: string) => JournalAuthor | undefined} authorOf
 * @returns {boolean}
 */
function hasUncoveredValueInvalidationOf(summary, certificate, authorOf) {
    if (summary.valueScoped.size === 0) {
        return false;
    }
    if (certificate === undefined) {
        return true;
    }
    const context = certificate.certificate.context;
    for (const entry of summary.valueScoped) {
        const author = authorOf(entry[0]);
        if (author === undefined) {
            throw new Error("an invalidation summary names a writer the target does not retain");
        }
        if (compareJournalSequence(journalSequenceAtFrontier(context, author), entry[1]) < 0) {
            return true;
        }
    }
    return false;
}

/**
 * Plan the Pass M3 persistent stale markers.
 *
 * @param {object} plan
 * @param {Projection} plan.postValidation
 * @param {Iterable<TargetOccurrence>} plan.targetOccurrences
 * @param {(nodeKeyString: string, valueId: JournalRecordId) => boolean} plan.hasUncoveredValueInvalidation
 * @returns {MigrationRepairIntent[]}
 */
function planFreshnessMarkers(plan) {
    const { postValidation, targetOccurrences, hasUncoveredValueInvalidation } = plan;
    /** @type {MigrationRepairIntent[]} */
    const requests = [];
    for (const occurrence of targetOccurrences) {
        if (occurrence.fresh) {
            continue;
        }
        if (!postValidation.selfProofReadyNodes.has(occurrence.nodeKeyString)) {
            continue;
        }
        if (hasUncoveredValueInvalidation(occurrence.nodeKeyString, occurrence.valueId)) {
            continue;
        }
        requests.push({
            kind: "migrate-stale-marker",
            node: occurrence.nodeKey,
            value: occurrence.valueId,
        });
    }
    return requests;
}

module.exports = {
    hasUncoveredValueInvalidationOf,
    makeCurrentInputKeysOfNode,
    planFreshnessMarkers,
    planProofBarriers,
    planTargetValidations,
    targetOccurrencesOf,
};
