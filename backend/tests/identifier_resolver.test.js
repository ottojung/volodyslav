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

describe("IdentifierResolver allocation", () => {
    test("hasPendingAllocations is false before any allocation", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        expect(resolver.hasPendingAllocations).toBe(false);
    });

    test("hasPendingAllocations is true after a new allocation", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        resolver.getOrAllocateNodeIdentifier(stringToNodeKeyString('{"head":"node","args":[]}'));
        expect(resolver.hasPendingAllocations).toBe(true);
    });

    test("hasPendingAllocations stays false when key already exists in active lookup", () => {
        const existingIdentifier = nodeIdentifierFromString("existinga");
        const existingKey = stringToNodeKeyString('{"head":"existing","args":[]}');
        const db = makeRootDatabase([[existingIdentifier, existingKey]]);
        const resolver = makeIdentifierResolver(db);
        resolver.getOrAllocateNodeIdentifier(existingKey);
        expect(resolver.hasPendingAllocations).toBe(false);
    });

    test("getOrAllocateNodeIdentifier returns the same identifier on repeated calls", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        const key = stringToNodeKeyString('{"head":"node","args":[]}');
        const first = resolver.getOrAllocateNodeIdentifier(key);
        const second = resolver.getOrAllocateNodeIdentifier(key);
        expect(first).toBe(second);
    });

    test("lookupNodeIdentifier returns undefined for unknown key", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        const key = stringToNodeKeyString('{"head":"unknown","args":[]}');
        expect(resolver.lookupNodeIdentifier(key)).toBeUndefined();
    });

    test("lookupNodeIdentifier finds existing mapping without allocating", () => {
        const existingIdentifier = nodeIdentifierFromString("existinga");
        const existingKey = stringToNodeKeyString('{"head":"existing","args":[]}');
        const db = makeRootDatabase([[existingIdentifier, existingKey]]);
        const resolver = makeIdentifierResolver(db);
        const found = resolver.lookupNodeIdentifier(existingKey);
        expect(found).toEqual(existingIdentifier);
        expect(resolver.hasPendingAllocations).toBe(false);
    });

    test("requireNodeKey retrieves the key for an existing identifier", () => {
        const id = nodeIdentifierFromString("existinga");
        const key = stringToNodeKeyString('{"head":"existing","args":[]}');
        const db = makeRootDatabase([[id, key]]);
        const resolver = makeIdentifierResolver(db);
        expect(resolver.requireNodeKey(id)).toEqual(key);
    });

    test("requireNodeKey throws for an unknown identifier", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        const id = nodeIdentifierFromString("unknownxx");
        expect(() => resolver.requireNodeKey(id)).toThrow();
    });
});

describe("IdentifierResolver lookup reflects all allocations", () => {
    test("resolver.lookup contains the newly allocated identifier", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        const key = stringToNodeKeyString('{"head":"node","args":[]}');
        const allocated = resolver.getOrAllocateNodeIdentifier(key);

        expect(resolver.lookup.keyToId.get(String(key))).toEqual(allocated);
    });

    test("resolver.lookup contains all allocations when multiple keys are allocated", () => {
        const db = makeRootDatabase([]);
        const resolver = makeIdentifierResolver(db);
        const keyA = stringToNodeKeyString('{"head":"a","args":[]}');
        const keyB = stringToNodeKeyString('{"head":"b","args":[]}');
        const idA = resolver.getOrAllocateNodeIdentifier(keyA);
        const idB = resolver.getOrAllocateNodeIdentifier(keyB);

        expect(resolver.lookup.keyToId.get(String(keyA))).toEqual(idA);
        expect(resolver.lookup.keyToId.get(String(keyB))).toEqual(idB);
    });

    test("resolver.lookup includes pre-existing base lookup mappings", () => {
        const baseId = nodeIdentifierFromString("baseidaaa");
        const baseKey = stringToNodeKeyString('{"head":"base","args":[]}');
        const db = makeRootDatabase([[baseId, baseKey]]);
        const resolver = makeIdentifierResolver(db);

        const newKey = stringToNodeKeyString('{"head":"new","args":[]}');
        const newId = resolver.getOrAllocateNodeIdentifier(newKey);

        // Both the pre-existing entry and the new allocation are in the lookup.
        expect(resolver.lookup.keyToId.get(String(baseKey))).toEqual(baseId);
        expect(resolver.lookup.keyToId.get(String(newKey))).toEqual(newId);
    });
});

