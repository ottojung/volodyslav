const {
    makeIdentifierLookup,
    mergeIdentifierLookups,
    nodeIdentifierFromString,
    serializeIdentifierLookup,
} = require("../src/generators/incremental_graph/database");
const { makeIdentifierResolver } = require("../src/generators/incremental_graph/identifier_resolver");

function makeRootDatabase(initialLookupEntries) {
    let activeLookup = makeIdentifierLookup(initialLookupEntries);
    const generated = ["allocaaaa", "allocaaab", "allocaaac", "allocaaad"];
    let counter = 0;
    return {
        cloneActiveIdentifierLookup() {
            return makeIdentifierLookup(serializeIdentifierLookup(activeLookup));
        },
        replaceActiveIdentifierLookup(lookup) {
            activeLookup = lookup;
        },
        generateNodeIdentifier() {
            const value = generated[counter] ?? "allocaaaz";
            counter += 1;
            return nodeIdentifierFromString(value);
        },
        readActiveLookup() {
            return activeLookup;
        },
    };
}

function makeBatch() {
    return {
        operations: [],
        appendOperation(operation) {
            this.operations.push(operation);
        },
    };
}

function makeGlobalDatabase() {
    return {
        rawPutOp(key, value) {
            return { type: "put", table: "global", key, value };
        },
    };
}

describe("identifier resolver persistence", () => {
    test("merges with latest committed lookup when persisting", () => {
        const rootDatabase = makeRootDatabase([
            [nodeIdentifierFromString("baseidaaa"), nodeIdentifierFromString("basekeyaa")],
        ]);

        const resolverA = makeIdentifierResolver(rootDatabase);
        const resolverB = makeIdentifierResolver(rootDatabase);

        resolverA.getOrAllocateNodeIdentifier(nodeIdentifierFromString("keyaaaaaa"));
        resolverB.getOrAllocateNodeIdentifier(nodeIdentifierFromString("keybbbbbb"));

        const globalDatabase = makeGlobalDatabase();

        const batchA = makeBatch();
        resolverA.queueLookupPersistence(batchA, rootDatabase, globalDatabase);
        resolverA.commitPersistedLookup(rootDatabase);

        const batchB = makeBatch();
        resolverB.queueLookupPersistence(batchB, rootDatabase, globalDatabase);

        const persistedEntries = batchB.operations[0].value;
        const persistedLookup = makeIdentifierLookup(persistedEntries);

        const merged = mergeIdentifierLookups(
            rootDatabase.cloneActiveIdentifierLookup(),
            resolverB.lookup
        );

        expect(serializeIdentifierLookup(persistedLookup)).toEqual(
            serializeIdentifierLookup(merged)
        );
    });

    test("commits defensive clones into root database", () => {
        const rootDatabase = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(rootDatabase);

        const nodeKey = nodeIdentifierFromString("keyclonea");
        const allocated = resolver.getOrAllocateNodeIdentifier(nodeKey);

        const batch = makeBatch();
        resolver.queueLookupPersistence(batch, rootDatabase, makeGlobalDatabase());
        resolver.commitPersistedLookup(rootDatabase);

        resolver.lookup.idToKey.set("mutatedxx", nodeIdentifierFromString("mutkeyaaa"));

        const persisted = rootDatabase.readActiveLookup().idToKey.get("mutatedxx");
        expect(persisted).toBeUndefined();
        expect(rootDatabase.readActiveLookup().keyToId.get(String(nodeKey))).toEqual(allocated);
    });
});
