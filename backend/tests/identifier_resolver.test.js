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
        writes: [],
        rawPutOp(key, value) {
            return { type: "put", table: "global", key, value };
        },
        async put(key, value) {
            this.writes.push({ type: "put", table: "global", key, value });
        },
    };
}

describe("identifier resolver persistence", () => {
    test("persists current resolver lookup snapshot", async () => {
        const rootDatabase = makeRootDatabase([
            [nodeIdentifierFromString("baseidaaa"), stringToNodeKeyString('{"head":"base","args":[]}')],
        ]);

        const resolverA = makeIdentifierResolver(rootDatabase);
        resolverA.getOrAllocateNodeIdentifier(stringToNodeKeyString('{"head":"key","args":["a"]}'));

        const globalDatabase = makeGlobalDatabase();

        const batchA = makeBatch();
        resolverA.queueLookupPersistence(batchA, rootDatabase, globalDatabase);
        await resolverA.commitPersistedLookup(rootDatabase, globalDatabase);

        const resolverB = makeIdentifierResolver(rootDatabase);
        resolverB.getOrAllocateNodeIdentifier(stringToNodeKeyString('{"head":"key","args":["b"]}'));
        const batchB = makeBatch();
        resolverB.queueLookupPersistence(batchB, rootDatabase, globalDatabase);
        await resolverB.commitPersistedLookup(rootDatabase, globalDatabase);

        const persistedEntries = globalDatabase.writes[1].value;
        const persistedLookup = makeIdentifierLookup(persistedEntries);

        expect(serializeIdentifierLookup(persistedLookup)).toEqual(
            serializeIdentifierLookup(resolverB.lookup)
        );
    });

    test("resolvers created before another commit still persist the latest lookup snapshot", async () => {
        const rootDatabase = makeRootDatabase([
            [nodeIdentifierFromString("baseidaaa"), stringToNodeKeyString('{"head":"base","args":[]}')],
        ]);
        const resolverA = makeIdentifierResolver(rootDatabase);
        const resolverB = makeIdentifierResolver(rootDatabase);
        const globalDatabase = makeGlobalDatabase();

        const nodeKeyA = stringToNodeKeyString('{"head":"key","args":["a"]}');
        const nodeKeyB = stringToNodeKeyString('{"head":"key","args":["b"]}');

        resolverA.getOrAllocateNodeIdentifier(nodeKeyA);
        const batchA = makeBatch();
        resolverA.queueLookupPersistence(batchA, rootDatabase, globalDatabase);
        await resolverA.commitPersistedLookup(rootDatabase, globalDatabase);

        resolverB.getOrAllocateNodeIdentifier(nodeKeyB);
        const batchB = makeBatch();
        resolverB.queueLookupPersistence(batchB, rootDatabase, globalDatabase);
        await resolverB.commitPersistedLookup(rootDatabase, globalDatabase);

        const finalLookup = rootDatabase.readActiveLookup();
        const persistedLookup = makeIdentifierLookup(globalDatabase.writes[1].value);

        expect(finalLookup.keyToId.get(String(nodeKeyA))).toBeDefined();
        expect(finalLookup.keyToId.get(String(nodeKeyB))).toBeDefined();
        expect(serializeIdentifierLookup(persistedLookup)).toEqual(
            serializeIdentifierLookup(finalLookup)
        );
    });

    test("commits defensive clones into root database", async () => {
        const rootDatabase = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(rootDatabase);

        const nodeKey = stringToNodeKeyString('{"head":"key","args":["clone"]}');
        const allocated = resolver.getOrAllocateNodeIdentifier(nodeKey);

        const batch = makeBatch();
        resolver.queueLookupPersistence(batch, rootDatabase, makeGlobalDatabase());
        await resolver.commitPersistedLookup(rootDatabase);

        resolver.lookup.idToKey.set("mutatedxx", stringToNodeKeyString('{"head":"mut","args":["key"]}'));

        const persisted = rootDatabase.readActiveLookup().idToKey.get("mutatedxx");
        expect(persisted).toBeUndefined();
        expect(rootDatabase.readActiveLookup().keyToId.get(String(nodeKey))).toEqual(allocated);
    });
});
