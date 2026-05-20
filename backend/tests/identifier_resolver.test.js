const {
    makeIdentifierLookup,
    nodeIdentifierFromString,
    serializeIdentifierLookup,
    stringToNodeKeyString,
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
    test("persists current resolver lookup snapshot", () => {
        const rootDatabase = makeRootDatabase([
            [nodeIdentifierFromString("baseidaaa"), stringToNodeKeyString('{"head":"base","args":[]}')],
        ]);

        const resolverA = makeIdentifierResolver(rootDatabase);
        resolverA.getOrAllocateNodeIdentifier(stringToNodeKeyString('{"head":"key","args":["a"]}'));

        const globalDatabase = makeGlobalDatabase();

        const batchA = makeBatch();
        resolverA.queueLookupPersistence(batchA, rootDatabase, globalDatabase);
        resolverA.commitPersistedLookup(rootDatabase);

        const resolverB = makeIdentifierResolver(rootDatabase);
        resolverB.getOrAllocateNodeIdentifier(stringToNodeKeyString('{"head":"key","args":["b"]}'));
        const batchB = makeBatch();
        resolverB.queueLookupPersistence(batchB, rootDatabase, globalDatabase);

        const persistedEntries = batchB.operations[0].value;
        const persistedLookup = makeIdentifierLookup(persistedEntries);

        expect(serializeIdentifierLookup(persistedLookup)).toEqual(
            serializeIdentifierLookup(resolverB.lookup)
        );
    });

    test("commits defensive clones into root database", () => {
        const rootDatabase = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(rootDatabase);

        const nodeKey = stringToNodeKeyString('{"head":"key","args":["clone"]}');
        const allocated = resolver.getOrAllocateNodeIdentifier(nodeKey);

        const batch = makeBatch();
        resolver.queueLookupPersistence(batch, rootDatabase, makeGlobalDatabase());
        resolver.commitPersistedLookup(rootDatabase);

        resolver.lookup.idToKey.set("mutatedxx", stringToNodeKeyString('{"head":"mut","args":["key"]}'));

        const persisted = rootDatabase.readActiveLookup().idToKey.get("mutatedxx");
        expect(persisted).toBeUndefined();
        expect(rootDatabase.readActiveLookup().keyToId.get(String(nodeKey))).toEqual(allocated);
    });
});
