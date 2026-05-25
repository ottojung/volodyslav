/**
 * Tests for Transaction-based identifier operations in graph_state.js.
 *
 * These tests verify that getOrAllocateNodeIdentifier, lookupNodeIdentifier,
 * and requireNodeKey work correctly on Transaction objects.
 */

const {
    makeIdentifierLookup,
    nodeIdentifierFromString,
    stringToNodeKeyString,
} = require("../src/generators/incremental_graph/database");
const {
    getOrAllocateNodeIdentifier,
    lookupNodeIdentifier,
    requireNodeKey,
} = require("../src/generators/incremental_graph/graph_state");

/**
 * Create a minimal rootDatabase mock for testing.
 */
function makeRootDatabase() {
    const generated = ["allocaaaa", "allocaaab", "allocaaac", "allocaaad"];
    let counter = 0;
    return {
        generateNodeIdentifier() {
            const value = generated[counter] ?? "allocaaaz";
            counter += 1;
            return nodeIdentifierFromString(value);
        },
    };
}

/**
 * Create a minimal Transaction mock for testing.
 * @param {Array<[import('../src/generators/incremental_graph/database').NodeIdentifier, import('../src/generators/incremental_graph/database').NodeKeyString]>} initialLookupEntries
 */
function makeTransaction(initialLookupEntries) {
    const lookup = makeIdentifierLookup(initialLookupEntries);
    return {
        batch: {},
        identifierLookup: lookup,
    };
}

describe("Transaction-based identifier operations", () => {
    test("lookupNodeIdentifier returns undefined for unknown key", () => {
        const tx = makeTransaction([]);
        const key = stringToNodeKeyString('{"head":"unknown","args":[]}');
        expect(lookupNodeIdentifier(tx, key)).toBeUndefined();
    });

    test("lookupNodeIdentifier finds existing mapping", () => {
        const existingIdentifier = nodeIdentifierFromString("existinga");
        const existingKey = stringToNodeKeyString('{"head":"existing","args":[]}');
        const tx = makeTransaction([[existingIdentifier, existingKey]]);
        const found = lookupNodeIdentifier(tx, existingKey);
        expect(found).toEqual(existingIdentifier);
    });

    test("getOrAllocateNodeIdentifier returns existing identifier without allocating", () => {
        const existingIdentifier = nodeIdentifierFromString("existinga");
        const existingKey = stringToNodeKeyString('{"head":"existing","args":[]}');
        const tx = makeTransaction([[existingIdentifier, existingKey]]);
        const db = makeRootDatabase();
        
        const result = getOrAllocateNodeIdentifier(tx, db, existingKey);
        expect(result).toEqual(existingIdentifier);
        // Lookup size should not change
        expect(tx.identifierLookup.keyToId.size).toBe(1);
    });

    test("getOrAllocateNodeIdentifier allocates new identifier for unknown key", () => {
        const tx = makeTransaction([]);
        const db = makeRootDatabase();
        const key = stringToNodeKeyString('{"head":"node","args":[]}');
        
        const allocated = getOrAllocateNodeIdentifier(tx, db, key);
        expect(allocated).toBeDefined();
        // Lookup should now have the new entry
        expect(tx.identifierLookup.keyToId.size).toBe(1);
    });

    test("getOrAllocateNodeIdentifier returns same identifier on repeated calls", () => {
        const tx = makeTransaction([]);
        const db = makeRootDatabase();
        const key = stringToNodeKeyString('{"head":"node","args":[]}');
        
        const first = getOrAllocateNodeIdentifier(tx, db, key);
        const second = getOrAllocateNodeIdentifier(tx, db, key);
        expect(first).toBe(second);
    });

    test("requireNodeKey retrieves the key for an existing identifier", () => {
        const id = nodeIdentifierFromString("existinga");
        const key = stringToNodeKeyString('{"head":"existing","args":[]}');
        const tx = makeTransaction([[id, key]]);
        
        expect(requireNodeKey(tx, id)).toEqual(key);
    });

    test("requireNodeKey throws for an unknown identifier", () => {
        const tx = makeTransaction([]);
        const id = nodeIdentifierFromString("unknownxx");
        expect(() => requireNodeKey(tx, id)).toThrow();
    });

    test("allocated identifiers are available via lookupNodeIdentifier", () => {
        const tx = makeTransaction([]);
        const db = makeRootDatabase();
        const key = stringToNodeKeyString('{"head":"node","args":[]}');
        
        const allocated = getOrAllocateNodeIdentifier(tx, db, key);
        const found = lookupNodeIdentifier(tx, key);
        expect(found).toEqual(allocated);
    });

    test("allocated identifiers are available via requireNodeKey", () => {
        const tx = makeTransaction([]);
        const db = makeRootDatabase();
        const key = stringToNodeKeyString('{"head":"node","args":[]}');
        
        const allocated = getOrAllocateNodeIdentifier(tx, db, key);
        const found = requireNodeKey(tx, allocated);
        expect(found).toEqual(key);
    });

    test("multiple allocations all appear in lookup", () => {
        const tx = makeTransaction([]);
        const db = makeRootDatabase();
        const keyA = stringToNodeKeyString('{"head":"a","args":[]}');
        const keyB = stringToNodeKeyString('{"head":"b","args":[]}');
        
        const idA = getOrAllocateNodeIdentifier(tx, db, keyA);
        const idB = getOrAllocateNodeIdentifier(tx, db, keyB);
        
        expect(lookupNodeIdentifier(tx, keyA)).toEqual(idA);
        expect(lookupNodeIdentifier(tx, keyB)).toEqual(idB);
        expect(tx.identifierLookup.keyToId.size).toBe(2);
    });

    test("allocations include pre-existing base lookup mappings", () => {
        const baseId = nodeIdentifierFromString("baseidaaa");
        const baseKey = stringToNodeKeyString('{"head":"base","args":[]}');
        const tx = makeTransaction([[baseId, baseKey]]);
        const db = makeRootDatabase();
        
        const newKey = stringToNodeKeyString('{"head":"new","args":[]}');
        const newId = getOrAllocateNodeIdentifier(tx, db, newKey);
        
        // Both the pre-existing entry and the new allocation are in the lookup.
        expect(lookupNodeIdentifier(tx, baseKey)).toEqual(baseId);
        expect(lookupNodeIdentifier(tx, newKey)).toEqual(newId);
    });
});
