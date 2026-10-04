/**
 * Pass 1: target presence and value occurrences.
 *
 * `incremental-graph-journal-reset.md` §Reset semantic domain fixes the domain as
 * `selectedPresent(H0) union present(PS)`, §Pass 1 fixes what each member needs,
 * and §Core identity rule fixes what must *not* be authored. Three consequences
 * shape this module:
 *
 * - the domain is derived from the receiver's already-selected heads and from the
 *   source's committed projection. No historical Value/Delete record is scanned
 *   to rediscover a currently absent key, which is why the input is a head view and
 *   not a journal;
 * - a node whose selected occurrence already has the target's immutable occurrence
 *   state keeps that occurrence and its `ValueId`. `ValueId` equality with the
 *   source is not a reset postcondition;
 * - the domain is processed in ascending canonical order, so the authored range is
 *   a function of the two projections rather than of traversal order.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('../journal/records').ValueEvent} ValueEvent */
/** @typedef {import('../journal/types').JournalRecordId} JournalRecordId */
/** @typedef {import('../journal/types').NodeKey} NodeKey */
/** @typedef {import('../journal/oracle/heads').HeadSelection} HeadSelection */
/** @typedef {import('../journal/oracle/projection').ProjectedOccurrence} ProjectedOccurrence */
/** @typedef {import('../journal/oracle/projection').Projection} Projection */
/** @typedef {import('./authoring').ResetDeleteRequest} ResetDeleteRequest */
/** @typedef {import('./authoring').ResetValueRequest} ResetValueRequest */

const { isPresent, isValueEvent } = require("../journal");
const { nodeIdentifierToString } = require("../database");

/**
 * The `ValueId` of a target-present node after Pass 1.
 *
 * The properties that this type carries are:
 * - the record id is the occurrence reset has selected for its semantic node once
 *   Pass 1 has completed, so it names either an occurrence the raw union already
 *   selected or one reset itself authored, and it is current under every later
 *   pass of this reset;
 * - the record id names a `ValueEvent` for exactly that node, so
 *   `PS.valueId(K) == resetValueId(K)` holds when Pass 1 preserved the union's
 *   occurrence, while `resetValueId(K) != PS.valueId(K)` is permitted.
 *
 * The proof of those properties is guaranteed by:
 * - `planResetDomain(...)`: it returns this type only by reading
 *   `HeadSelection.winner`, which head selection makes the greatest
 *   Value/Delete candidate of that node, and only when that winner is a
 *   `ValueEvent`; and
 * - `finalizeResetRecords(...)`: every `ResetValueRequest` this plan produces is
 *   allocated as a `ValueEvent` for the same `NodeKey`, so the id a request's
 *   record receives names an occurrence of that node;
 * - `resetToSource(...)`: Passes 2 and 3 author no `ValueEvent`, so the selected
 *   occurrence of a target-present node is the one Pass 1 established and every
 *   later record which names it is an invalidation or a validation of it.
 *
 * Plain record ids must not be treated as `ResetValueId` values unless they pass
 * through one of these paths.
 *
 * @typedef {JournalRecordId} ResetValueId
 */

/**
 * Do two payload values describe the same computed value?
 *
 * A payload is a computed value with the shape the journal schema defines, so the
 * comparison is structural over objects, arrays and scalars rather than an
 * identity or a reference comparison. Two occurrences which recompute the same
 * value are the same immutable occurrence state, which is what Pass 1 targets.
 *
 * @param {unknown} left
 * @param {unknown} right
 * @returns {boolean}
 */
function payloadEquals(left, right) {
    if (left === right) {
        return true;
    }
    if (Array.isArray(left) || Array.isArray(right)) {
        if (!Array.isArray(left) || !Array.isArray(right) || left.length !== right.length) {
            return false;
        }
        return left.every((element, index) => payloadEquals(element, right[index]));
    }
    if (typeof left !== "object" || typeof right !== "object" || left === null || right === null) {
        return false;
    }
    const leftEntries = Object.entries(left);
    const rightEntries = Object.entries(right);
    if (leftEntries.length !== rightEntries.length) {
        return false;
    }
    const rightFields = new Map(rightEntries);
    return leftEntries.every((entry) => {
        if (!rightFields.has(entry[0])) {
            return false;
        }
        return payloadEquals(entry[1], rightFields.get(entry[0]));
    });
}

/**
 * Does the selected occurrence already have the target's immutable occurrence
 * state?
 *
 * The four fields are exactly the ones `reset.md` §Pass 1 names, and `valueId` is
 * deliberately absent: a preserved `ValueId` is not required to equal `PS.valueId(K)`.
 *
 * @param {ValueEvent} selected
 * @param {ProjectedOccurrence} target
 * @returns {boolean}
 */
function hasTargetOccurrenceState(selected, target) {
    return (
        nodeIdentifierToString(selected.nodeIdentifier) === nodeIdentifierToString(target.nodeIdentifier) &&
        payloadEquals(selected.payload, target.payload) &&
        selected.createdAt === target.createdAt &&
        selected.modifiedAt === target.modifiedAt
    );
}

/**
 * The properties that this class carries are:
 * - `keys` is exactly `selectedPresent(H0) union present(PS)` in ascending
 *   canonical order, and every member is in one of `values` or `deletes`;
 * - `values` names, for each target-present node of the domain, the `ValueEvent`
 *   reset must author, or `undefined` when the raw union's selected occurrence
 *   already has the target's immutable occurrence state; and
 * - `deletes` names exactly the target-absent nodes whose selected head is a
 *   `ValueEvent`, in ascending canonical order.
 *
 * The proof of those properties is guaranteed by:
 * - `planResetDomain(...)`: it unions the keys `isPresent(selections, key)` holds
 *   with the keys `present(PS)` holds, sorts them, and for each key consults the
 *   target occurrence map first, so a historical key which is selected-absent in
 *   the union and absent from the target is in neither list and contributes no
 *   request; and
 * - `hasTargetOccurrenceState(...)`: it returns true exactly when the selected
 *   `ValueEvent`'s `nodeIdentifier`, `payload`, `createdAt` and `modifiedAt` are
 *   the target's, which is the condition under which the specification preserves
 *   the occurrence and authors no `ValueEvent`.
 *
 * @param {ReadonlyArray<string>} keys
 * @param {Map<string, ResetValueRequest | undefined>} values
 * @param {ReadonlyArray<ResetDeleteRequest>} deletes
 */
class ResetDomainClass {
    /**
     * @param {ReadonlyArray<string>} keys
     * @param {Map<string, ResetValueRequest | undefined>} values
     * @param {ReadonlyArray<ResetDeleteRequest>} deletes
     */
    constructor(keys, values, deletes) {
        this.keys = keys;
        this.values = values;
        this.deletes = deletes;
    }
}

/** @typedef {ResetDomainClass} ResetDomain */

/**
 * @param {unknown} value
 * @returns {value is ResetDomain}
 */
function isResetDomain(value) {
    return value instanceof ResetDomainClass;
}

/**
 * @param {Projection} target
 * @returns {Map<string, ProjectedOccurrence>}
 */
function occurrencesByKey(target) {
    return new Map(target.occurrences.map((occurrence) => [occurrence.nodeKeyString, occurrence]));
}

/**
 * Plan the target presence and value occurrences the raw union still owes.
 *
 * @param {object} plan
 * @param {Map<string, HeadSelection>} plan.selections - The raw `selectedHeads(J0)` view.
 * @param {Projection} plan.target - The source's committed projection `PS`.
 * @returns {ResetDomain}
 */
function planResetDomain(plan) {
    const { selections, target } = plan;
    const present = occurrencesByKey(target);

    /** @type {Set<string>} */
    const domain = new Set();
    for (const nodeKeyString of [...selections.keys()].sort()) {
        if (isPresent(selections, nodeKeyString)) {
            domain.add(nodeKeyString);
        }
    }
    for (const occurrence of target.occurrences) {
        domain.add(occurrence.nodeKeyString);
    }
    const keys = [...domain].sort();

    /** @type {Map<string, ResetValueRequest | undefined>} */
    const values = new Map();
    /** @type {ResetDeleteRequest[]} */
    const deletes = [];
    for (const nodeKeyString of keys) {
        const targetOccurrence = present.get(nodeKeyString);
        if (targetOccurrence !== undefined) {
            const selection = selections.get(nodeKeyString);
            const winner = selection === undefined ? undefined : selection.winner;
            if (
                winner !== undefined &&
                isValueEvent(winner) &&
                hasTargetOccurrenceState(winner, targetOccurrence)
            ) {
                values.set(nodeKeyString, undefined);
                continue;
            }
            const node = selection === undefined ? targetOccurrence.nodeKey : selection.nodeKey;
            values.set(nodeKeyString, {
                kind: "value",
                node,
                nodeIdentifier: targetOccurrence.nodeIdentifier,
                payload: targetOccurrence.payload,
                createdAt: targetOccurrence.createdAt,
                modifiedAt: targetOccurrence.modifiedAt,
            });
            continue;
        }
        const selection = selections.get(nodeKeyString);
        const winner = selection === undefined ? undefined : selection.winner;
        if (winner === undefined || !isValueEvent(winner)) {
            continue;
        }
        if (selection !== undefined) {
            deletes.push({ kind: "delete", node: selection.nodeKey });
        }
    }
    return new ResetDomainClass(keys, values, deletes);
}

/**
 * The Pass 1 request list in the one order reset allocates it: the target
 * occurrences of the domain, then the target absences.
 *
 * @param {ResetDomain} domain
 * @returns {import('./authoring').ResetRequest[]}
 */
function resetRequestsOf(domain) {
    /** @type {import('./authoring').ResetRequest[]} */
    const requests = [];
    for (const nodeKeyString of domain.keys) {
        const request = domain.values.get(nodeKeyString);
        if (request !== undefined) {
            requests.push(request);
        }
    }
    requests.push(...domain.deletes);
    return requests;
}

module.exports = {
    ResetDomainClass,
    hasTargetOccurrenceState,
    isResetDomain,
    payloadEquals,
    planResetDomain,
    resetRequestsOf,
};