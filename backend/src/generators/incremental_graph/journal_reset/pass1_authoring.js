/**
 * Bounded Pass 1 request authoring for reset.
 */

/** @typedef {import('../journal/errors').AnyJournalError} JournalError */
/** @typedef {import('./pass1').ResetValueId} ResetValueId */

const { isValueEvent, nodeKeyToCanonicalString } = require("../journal");
const { deleteRequestOf, valueRequestOf } = require("./pass1");

const PASS_ONE_CHUNK_SIZE = 64;

/**
 * Allocate Pass 1's presence then absence requests in bounded chunks.
 *
 * @param {object} request
 * @param {() => Generator<import('./pass1').ResetDomainEntry>} request.domain
 * @param {Map<string, ResetValueId>} request.valueIds
 * @param {(requests: ReadonlyArray<import('./authoring').ResetRequest>) => {publication: import('./authoring').ResetPublication} | {error: JournalError}} request.allocateInto
 * @returns {{done: true} | {error: JournalError}}
 */
function authorPassOne({ domain, valueIds, allocateInto }) {
    /** @type {import('./authoring').ResetRequest[]} */
    let requests = [];
    const flush = () => {
        if (requests.length === 0) {
            return undefined;
        }
        const allocated = allocateInto(requests);
        if ("error" in allocated) {
            return allocated.error;
        }
        for (const record of allocated.publication.records) {
            if (isValueEvent(record)) {
                valueIds.set(nodeKeyToCanonicalString(record.node), record.id);
            }
        }
        requests = [];
        return undefined;
    };

    for (const entry of domain()) {
        const valueRequest = valueRequestOf(entry);
        if (valueRequest !== undefined) {
            requests.push(valueRequest);
            if (requests.length === PASS_ONE_CHUNK_SIZE) {
                const failure = flush();
                if (failure !== undefined) {
                    return { error: failure };
                }
            }
            continue;
        }
        const winner = entry.selection === undefined ? undefined : entry.selection.winner;
        if (winner !== undefined && isValueEvent(winner)) {
            valueIds.set(entry.nodeKeyString, winner.id);
        }
    }
    const presenceFailure = flush();
    if (presenceFailure !== undefined) {
        return { error: presenceFailure };
    }

    for (const entry of domain()) {
        const request = deleteRequestOf(entry);
        if (request === undefined) {
            continue;
        }
        requests.push(request);
        if (requests.length === PASS_ONE_CHUNK_SIZE) {
            const failure = flush();
            if (failure !== undefined) {
                return { error: failure };
            }
        }
    }
    const absenceFailure = flush();
    return absenceFailure === undefined ? { done: true } : { error: absenceFailure };
}

module.exports = { authorPassOne };
