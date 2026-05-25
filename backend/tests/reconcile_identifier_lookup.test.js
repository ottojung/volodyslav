const {
    makeIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    stringToNodeKeyString,
} = require("../src/generators/incremental_graph/database");
const { reconcileHostLookupWithTargetLookup } = require("../src/generators/incremental_graph/database/reconcile_identifier_lookup");

describe("reconcile identifier lookup", () => {
    test("reconciles conflicting identifier assignments for one semantic key", () => {
        const semanticNodeKey = stringToNodeKeyString('{"head":"key","args":[]}');
        const hostIdentifier = nodeIdentifierFromString("hostidaaa");
        const targetIdentifier = nodeIdentifierFromString("targetaaa");

        const hostLookup = makeIdentifierLookup([[hostIdentifier, semanticNodeKey]]);
        const targetLookup = makeIdentifierLookup([[targetIdentifier, semanticNodeKey]]);

        const reconciled = reconcileHostLookupWithTargetLookup(targetLookup, hostLookup);

        expect(nodeKeyToIdFromLookup(reconciled, semanticNodeKey)).toEqual(targetIdentifier);
        expect(nodeIdToKeyFromLookup(reconciled, hostIdentifier)).toBeUndefined();
        expect(nodeIdToKeyFromLookup(reconciled, targetIdentifier)).toEqual(semanticNodeKey);
    });

    test("keeps identical assignments unchanged", () => {
        const semanticNodeKey = stringToNodeKeyString('{"head":"key","args":["b"]}');
        const identifier = nodeIdentifierFromString("sameidaaa");

        const hostLookup = makeIdentifierLookup([[identifier, semanticNodeKey]]);
        const targetLookup = makeIdentifierLookup([[identifier, semanticNodeKey]]);

        const reconciled = reconcileHostLookupWithTargetLookup(targetLookup, hostLookup);

        expect(nodeKeyToIdFromLookup(reconciled, semanticNodeKey)).toEqual(identifier);
        expect(nodeIdToKeyFromLookup(reconciled, identifier)).toEqual(semanticNodeKey);
    });

    test("does not evict unrelated keys when target identifier already matches", () => {
        const semanticNodeKey = stringToNodeKeyString('{"head":"key","args":[]}');
        const otherNodeKey = stringToNodeKeyString('{"head":"other","args":[]}');
        const targetIdentifier = nodeIdentifierFromString("targetaaa");
        const otherIdentifier = nodeIdentifierFromString("otheriaaa");

        const hostLookup = makeIdentifierLookup([
            [targetIdentifier, semanticNodeKey],
            [otherIdentifier, otherNodeKey],
        ]);
        const targetLookup = makeIdentifierLookup([[targetIdentifier, semanticNodeKey]]);

        const reconciled = reconcileHostLookupWithTargetLookup(targetLookup, hostLookup);

        expect(nodeIdToKeyFromLookup(reconciled, targetIdentifier)).toEqual(semanticNodeKey);
        expect(nodeKeyToIdFromLookup(reconciled, otherNodeKey)).toEqual(otherIdentifier);
    });

    test("evicts host mapping that conflicts with target identifier during reconcile", () => {
        const semanticNodeKey = stringToNodeKeyString('{"head":"key","args":[]}');
        const conflictingNodeKey = stringToNodeKeyString('{"head":"other","args":[]}');
        const hostIdentifier = nodeIdentifierFromString("hostidaaa");
        const targetIdentifier = nodeIdentifierFromString("targetaaa");

        const hostLookup = makeIdentifierLookup([
            [hostIdentifier, semanticNodeKey],
            [targetIdentifier, conflictingNodeKey],
        ]);
        const targetLookup = makeIdentifierLookup([[targetIdentifier, semanticNodeKey]]);

        const reconciled = reconcileHostLookupWithTargetLookup(targetLookup, hostLookup);

        expect(nodeKeyToIdFromLookup(reconciled, semanticNodeKey)).toEqual(targetIdentifier);
        expect(nodeIdToKeyFromLookup(reconciled, targetIdentifier)).toEqual(semanticNodeKey);
        expect(nodeKeyToIdFromLookup(reconciled, conflictingNodeKey)).toBeUndefined();
    });
});
