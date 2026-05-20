const {
    makeIdentifierLookup,
    nodeIdentifierFromString,
} = require("../src/generators/incremental_graph/database");
const { reconcileHostLookupWithTargetLookup } = require("../src/generators/incremental_graph/database/reconcile_identifier_lookup");

describe("reconcile identifier lookup", () => {
    test("reconciles conflicting identifier assignments for one semantic key", () => {
        const semanticNodeKey = nodeIdentifierFromString("keyaaaaaa");
        const hostIdentifier = nodeIdentifierFromString("hostidaaa");
        const targetIdentifier = nodeIdentifierFromString("targetaaa");

        const hostLookup = makeIdentifierLookup([[hostIdentifier, semanticNodeKey]]);
        const targetLookup = makeIdentifierLookup([[targetIdentifier, semanticNodeKey]]);

        const reconciled = reconcileHostLookupWithTargetLookup(targetLookup, hostLookup);

        expect(reconciled.keyToId.get(String(semanticNodeKey))).toEqual(targetIdentifier);
        expect(reconciled.idToKey.get(String(hostIdentifier))).toBeUndefined();
        expect(reconciled.idToKey.get(String(targetIdentifier))).toEqual(semanticNodeKey);
    });

    test("keeps identical assignments unchanged", () => {
        const semanticNodeKey = nodeIdentifierFromString("keybbbbbb");
        const identifier = nodeIdentifierFromString("sameidaaa");

        const hostLookup = makeIdentifierLookup([[identifier, semanticNodeKey]]);
        const targetLookup = makeIdentifierLookup([[identifier, semanticNodeKey]]);

        const reconciled = reconcileHostLookupWithTargetLookup(targetLookup, hostLookup);

        expect(reconciled.keyToId.get(String(semanticNodeKey))).toEqual(identifier);
        expect(reconciled.idToKey.get(String(identifier))).toEqual(semanticNodeKey);
    });
});
