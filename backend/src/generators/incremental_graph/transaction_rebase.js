const { nodeIdentifierToString, stringToNodeIdentifier } = require('./database');

/** @typedef {import('./database/root_database').SchemaStorage} SchemaStorage */
/** @typedef {import('./database/types').NodeIdentifier} NodeIdentifier */
/** @typedef {import('./graph_state').Transaction} Transaction */

/**
 * @param {NodeIdentifier[]} sortedArray
 * @param {NodeIdentifier} nodeIdentifier
 * @returns {{ index: number, found: boolean }}
 */
function findInsertionIndex(sortedArray, nodeIdentifier) {
    const needle = nodeIdentifierToString(nodeIdentifier);
    let lo = 0;
    let hi = sortedArray.length;
    while (lo < hi) {
        const mid = (lo + hi) >>> 1;
        const current = sortedArray[mid];
        if (current === undefined) {
            throw new Error(`findInsertionIndex: missing identifier at index ${String(mid)}`);
        }
        const currentString = nodeIdentifierToString(current);
        if (currentString === needle) {
            return { index: mid, found: true };
        }
        if (currentString < needle) {
            lo = mid + 1;
        } else {
            hi = mid;
        }
    }
    return { index: lo, found: false };
}

/**
 * @param {Transaction} tx
 * @param {Array<*>} operations
 * @returns {void}
 */
function rebaseDuplicateIdentifierAllocations(tx, operations) {
    /** @type {Map<string, NodeIdentifier>} */
    const rewrittenIdentifiers = new Map();
    for (const [keyString, reservedIdentifier] of tx.identifierLookup.keyToId) {
        const canonicalIdentifier = tx.identifierLookup.base.keyToId.get(keyString);
        if (canonicalIdentifier === undefined || canonicalIdentifier === reservedIdentifier) {
            continue;
        }
        const reservedString = nodeIdentifierToString(reservedIdentifier);
        rewrittenIdentifiers.set(reservedString, canonicalIdentifier);
        tx.identifierLookup.keyToId.delete(keyString);
        tx.identifierLookup.idToKey.delete(reservedString);
    }

    if (rewrittenIdentifiers.size === 0) {
        return;
    }

    for (const operation of operations) {
        const key = operation.key;
        if (typeof key === "string") {
            const canonical = rewrittenIdentifiers.get(key);
            if (canonical !== undefined) {
                operation.key = canonical;
            }
        }
        if (operation.type !== "put") {
            continue;
        }
        const value = operation.value;
        if (value !== undefined && Array.isArray(value.inputs)) {
            value.inputs = value.inputs.map(
                /**
                 * @param {string} inputString
                 * @returns {string}
                 */
                (inputString) => {
                    const canonical = rewrittenIdentifiers.get(inputString);
                    return canonical !== undefined ? nodeIdentifierToString(canonical) : inputString;
                }
            );
        }
    }

    for (const [reservedString, canonicalIdentifier] of rewrittenIdentifiers) {
        const dependentStrings = tx.revdepsAdds.get(reservedString);
        if (dependentStrings !== undefined) {
            tx.revdepsAdds.delete(reservedString);
            const canonicalString = nodeIdentifierToString(canonicalIdentifier);
            let canonicalDependents = tx.revdepsAdds.get(canonicalString);
            if (canonicalDependents === undefined) {
                canonicalDependents = new Set();
                tx.revdepsAdds.set(canonicalString, canonicalDependents);
            }
            for (const dependentString of dependentStrings) {
                canonicalDependents.add(dependentString);
            }
        }
        for (const dependentStrings of tx.revdepsAdds.values()) {
            if (dependentStrings.delete(reservedString)) {
                dependentStrings.add(nodeIdentifierToString(canonicalIdentifier));
            }
        }
    }
}

/**
 * @param {SchemaStorage} schemaStorage
 * @param {Map<string, Set<string>>} revdepsAdds
 * @param {Array<*>} operations
 * @returns {Promise<void>}
 */
async function renderRevdepsAdds(schemaStorage, revdepsAdds, operations) {
    for (const [inputIdentifierString, dependentStrings] of revdepsAdds) {
        const inputIdentifier = stringToNodeIdentifier(inputIdentifierString);
        const existingDependents = await schemaStorage.revdeps.get(inputIdentifier);
        const merged = existingDependents !== undefined ? existingDependents.slice() : [];
        for (const dependentString of dependentStrings) {
            const dependent = stringToNodeIdentifier(dependentString);
            const { index, found } = findInsertionIndex(merged, dependent);
            if (!found) {
                merged.splice(index, 0, dependent);
            }
        }
        operations.push(schemaStorage.revdeps.putOp(inputIdentifier, merged));
    }
}

module.exports = {
    rebaseDuplicateIdentifierAllocations,
    renderRevdepsAdds,
};
