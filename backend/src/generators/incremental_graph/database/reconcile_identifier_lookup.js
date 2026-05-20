const { nodeIdentifierToString } = require('./node_identifier');
const {
    makeIdentifierLookup,
    serializeIdentifierLookup,
    deleteIdentifierMappingForNodeKey,
    setIdentifierMapping,
} = require('./identifier_lookup');

/** @typedef {import('./identifier_lookup').IdentifierLookup} IdentifierLookup */

/**
 * @param {IdentifierLookup} targetLookup
 * @param {IdentifierLookup} hostLookup
 * @returns {IdentifierLookup}
 */
function reconcileHostLookupWithTargetLookup(targetLookup, hostLookup) {
    const reconciledHostLookup = makeIdentifierLookup(serializeIdentifierLookup(hostLookup));
    for (const [nodeKeyString, targetIdentifier] of targetLookup.keyToId.entries()) {
        const hostIdentifier = reconciledHostLookup.keyToId.get(nodeKeyString);
        if (hostIdentifier !== undefined && hostIdentifier !== targetIdentifier) {
            const hostNodeKey = reconciledHostLookup.idToKey.get(nodeIdentifierToString(hostIdentifier));
            if (hostNodeKey !== undefined) {
                deleteIdentifierMappingForNodeKey(reconciledHostLookup, hostNodeKey);
            }

            const targetNodeKey = targetLookup.idToKey.get(nodeIdentifierToString(targetIdentifier));
            if (targetNodeKey !== undefined) {
                const conflictingHostNodeKey = reconciledHostLookup.idToKey.get(
                    nodeIdentifierToString(targetIdentifier)
                );
                if (
                    conflictingHostNodeKey !== undefined
                    && conflictingHostNodeKey !== targetNodeKey
                ) {
                    deleteIdentifierMappingForNodeKey(reconciledHostLookup, conflictingHostNodeKey);
                }
                setIdentifierMapping(reconciledHostLookup, targetIdentifier, targetNodeKey);
            }
        }
    }
    return reconciledHostLookup;
}

module.exports = { reconcileHostLookupWithTargetLookup };
