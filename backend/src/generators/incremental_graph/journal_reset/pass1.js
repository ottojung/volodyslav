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

const { isValueEvent } = require("../journal");
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
 * One member of `selectedPresent(H0) union present(PS)`, decided as it is reached.
 *
 * The properties that this class carries are:
 * - `nodeKeyString` is a member of the reset domain in ascending canonical order;
 * - `selection` is the raw union's `selectedHeads` entry for that node, or
 *   `undefined` when the node is present only in the target; and
 * - `target` is the source's committed occurrence for that node, or `undefined`
 *   when the node is target-absent.
 *
 * The proof of those properties is guaranteed by:
 * - `iterateResetDomain(plan)`: it merges the two ascending key sequences it is
 *   given and yields one entry per distinct key, so a node in both sources is
 *   yielded once with both members, and every yielded key is a member of the
 *   union the specification defines.
 *
 * @param {string} nodeKeyString
 * @param {HeadSelection | undefined} selection
 * @param {ProjectedOccurrence | undefined} target
 */
class ResetDomainEntryClass {
    /**
     * @param {string} nodeKeyString
     * @param {HeadSelection | undefined} selection
     * @param {ProjectedOccurrence | undefined} target
     */
    constructor(nodeKeyString, selection, target) {
        this.nodeKeyString = nodeKeyString;
        this.selection = selection;
        this.target = target;
    }
}

/** @typedef {ResetDomainEntryClass} ResetDomainEntry */

/**
 * @param {unknown} value
 * @returns {value is ResetDomainEntry}
 */
function isResetDomainEntry(value) {
    return value instanceof ResetDomainEntryClass;
}

/**
 * The reset domain as an ordered view rather than as one collection.
 *
 * `incremental-graph-journal-reset.md` §Streamability forbids reset from
 * requiring the complete reset domain to be materialized in RAM as one
 * collection, and permits the passes to be implemented as ordered iteration with
 * bounded iterator buffers. Both members of the domain already arrive in ascending
 * canonical order - `selectedHeads` keys are sorted and the source's committed
 * projection lists its occurrences in ascending order - so the domain is the merge
 * of two ascending sequences, and the merge holds one member of each.
 *
 * The view is re-iterable: Pass 1 walks it once for the target occurrences and
 * once for the target absences, and neither walk needs the other one's results.
 *
 * @param {object} plan
 * @param {Map<string, HeadSelection>} plan.selections - The raw `selectedHeads(J0)` view.
 * @param {Projection} plan.target - The source's committed projection `PS`.
 * @returns {() => Generator<ResetDomainEntry>}
 */
function iterateResetDomain(plan) {
    const { selections, target } = plan;
    const selectedKeys = [...selections.keys()].sort();
    return function* entries() {
        let selectedIndex = 0;
        let targetIndex = 0;
        for (;;) {
            const selectedKey = selectedKeys[selectedIndex];
            const occurrence = target.occurrences[targetIndex];
            if (selectedKey === undefined && occurrence === undefined) {
                return;
            }
            if (occurrence === undefined || (selectedKey !== undefined && selectedKey < occurrence.nodeKeyString)) {
                const selection = selections.get(selectedKey ?? "");
                selectedIndex += 1;
                yield new ResetDomainEntryClass(selectedKey ?? "", selection, undefined);
                continue;
            }
            if (selectedKey === undefined || occurrence.nodeKeyString < selectedKey) {
                targetIndex += 1;
                yield new ResetDomainEntryClass(occurrence.nodeKeyString, undefined, occurrence);
                continue;
            }
            selectedIndex += 1;
            targetIndex += 1;
            yield new ResetDomainEntryClass(selectedKey, selections.get(selectedKey), occurrence);
        }
    };
}

/**
 * The `ValueEvent` reset must author for one domain member, if any.
 *
 * @param {ResetDomainEntry} entry
 * @returns {ResetValueRequest | undefined}
 */
function valueRequestOf(entry) {
    const target = entry.target;
    if (target === undefined) {
        return undefined;
    }
    const selection = entry.selection;
    const winner = selection === undefined ? undefined : selection.winner;
    if (winner !== undefined && isValueEvent(winner) && hasTargetOccurrenceState(winner, target)) {
        return undefined;
    }
    const node = selection === undefined ? target.nodeKey : selection.nodeKey;
    return {
        kind: "value",
        node,
        nodeIdentifier: target.nodeIdentifier,
        payload: target.payload,
        createdAt: target.createdAt,
        modifiedAt: target.modifiedAt,
    };
}

/**
 * The `DeleteEvent` reset must author for one domain member, if any.
 *
 * A target-absent member whose selected head is a `ValueEvent` is deleted, and a
 * member which is already selected-absent contributes nothing, which is what makes
 * a repeated reset to the same absent target accumulate no redundant deletes.
 *
 * @param {ResetDomainEntry} entry
 * @returns {ResetDeleteRequest | undefined}
 */
function deleteRequestOf(entry) {
    if (entry.target !== undefined) {
        return undefined;
    }
    const selection = entry.selection;
    const winner = selection === undefined ? undefined : selection.winner;
    if (winner === undefined || !isValueEvent(winner) || selection === undefined) {
        return undefined;
    }
    return { kind: "delete", node: selection.nodeKey };
}

module.exports = {
    ResetDomainEntryClass,
    deleteRequestOf,
    hasTargetOccurrenceState,
    isResetDomainEntry,
    iterateResetDomain,
    payloadEquals,
    valueRequestOf,
};