const { nodeIdentifierFromString, nodeIdentifierToString } = require('./node_identifier');
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
            const nodeKey = reconciledHostLookup.idToKey.get(nodeIdentifierToString(hostIdentifier));
            if (nodeKey !== undefined) deleteIdentifierMappingForNodeKey(reconciledHostLookup, nodeKey);
            setIdentifierMapping(reconciledHostLookup, targetIdentifier, nodeIdentifierFromString(nodeKeyString));
        }
    }
    return reconciledHostLookup;
}

module.exports = { reconcileHostLookupWithTargetLookup };
