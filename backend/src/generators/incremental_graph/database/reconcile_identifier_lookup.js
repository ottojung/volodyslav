const {
    makeIdentifierLookup,
    serializeIdentifierLookup,
    deleteIdentifierMappingForNodeKey,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
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
    for (const [targetIdentifier, targetNodeKey] of serializeIdentifierLookup(targetLookup)) {
        const hostIdentifier = nodeKeyToIdFromLookup(reconciledHostLookup, targetNodeKey);
        if (hostIdentifier !== undefined && hostIdentifier !== targetIdentifier) {
            const hostNodeKey = nodeIdToKeyFromLookup(reconciledHostLookup, hostIdentifier);
            if (hostNodeKey !== undefined) {
                deleteIdentifierMappingForNodeKey(reconciledHostLookup, hostNodeKey);
            }

            // targetNodeKey is the key mapped to targetIdentifier in the target lookup.
            const conflictingHostNodeKey = nodeIdToKeyFromLookup(
                reconciledHostLookup,
                targetIdentifier
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
    return reconciledHostLookup;
}

module.exports = { reconcileHostLookupWithTargetLookup };
