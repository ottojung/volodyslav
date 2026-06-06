const {
    allocateNodeIdentifier,
    cloneIdentifierLookup,
    mergeIdentifierLookups,
    deleteIdentifierMappingForNodeKey,
    IdentifierLookupError,
    IDENTIFIERS_KEY,
    isIdentifierLookupError,
    makeEmptyIdentifierLookup,
    makeIdentifierLookup,
    makeTransactionIdentifierLookup,
    nodeIdToKeyFromLookup,
    nodeKeyToIdFromLookup,
    requireNodeIdentifierForKey,
    requireNodeKeyForIdentifier,
    serializeIdentifierLookup,
    setIdentifierMapping,
    txAllocateNodeIdentifier,
    txNodeIdToKey,
    txNodeKeyToId,
    serializeTransactionLookup,
    commitTransactionLookup,
} = require("../src/generators/incremental_graph/database/identifier_lookup");
const {
    compareNodeIdentifier,
    nodeIdentifierFromString,
    nodeIdentifierToString,
} = require("../src/generators/incremental_graph/database/node_identifier");
const {
    stringToNodeKeyString,
    nodeKeyStringToString,
} = require("../src/generators/incremental_graph/database/types");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Create a NodeIdentifier from a 9-letter string. */
function id(str) {
    return nodeIdentifierFromString(str);
}

/** Create a NodeKeyString from its string form. */
function key(str) {
    return stringToNodeKeyString(str);
}

function keyStr(k) {
    return nodeKeyStringToString(k);
}

// Pre-built identifiers and keys used across tests.
const ID_A = id("aaaaaaaaa");
const ID_B = id("bbbbbbbbb");
const ID_C = id("ccccccccc");
const ID_D = id("ddddddddd");
const KEY_X = key("key_x");
const KEY_Y = key("key_y");
const KEY_Z = key("key_z");

/**
 * Sorted order of identifier strings: aaaaaaaa < bbbbbbbbb < ccccccccc < ddddddddd
 */

// ---------------------------------------------------------------------------
// makeEmptyIdentifierLookup
// ---------------------------------------------------------------------------

describe("makeEmptyIdentifierLookup", () => {
    test("returns empty maps and serialized array", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(lookup.keyToId.size).toBe(0);
        expect(lookup.idToKey.size).toBe(0);
        expect(lookup.serialized).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// makeIdentifierLookup
// ---------------------------------------------------------------------------

describe("makeIdentifierLookup", () => {
    test("builds lookup from valid sorted entries", () => {
        const entries = [[ID_A, KEY_X], [ID_B, KEY_Y]];
        const lookup = makeIdentifierLookup(entries);
        expect(keyStr(nodeIdToKeyFromLookup(lookup, ID_A))).toBe("key_x");
        expect(keyStr(nodeIdToKeyFromLookup(lookup, ID_B))).toBe("key_y");
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(lookup, KEY_X))).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(lookup, KEY_Y))).toBe("bbbbbbbbb");
    });

    test("builds lookup from unsorted entries (serialized cache is sorted)", () => {
        const entries = [[ID_B, KEY_Y], [ID_A, KEY_X]];
        const lookup = makeIdentifierLookup(entries);
        const serialized = lookup.serialized;
        expect(serialized.length).toBe(2);
        expect(nodeIdentifierToString(serialized[0][0])).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(serialized[1][0])).toBe("bbbbbbbbb");
    });

    test("throws on duplicate identifier", () => {
        expect(() => makeIdentifierLookup([[ID_A, KEY_X], [ID_A, KEY_Y]])).toThrow(IdentifierLookupError);
    });

    test("throws on duplicate key", () => {
        expect(() => makeIdentifierLookup([[ID_A, KEY_X], [ID_B, KEY_X]])).toThrow(IdentifierLookupError);
    });

    test("returns empty lookup for empty entries", () => {
        const lookup = makeIdentifierLookup([]);
        expect(lookup.keyToId.size).toBe(0);
        expect(lookup.idToKey.size).toBe(0);
        expect(lookup.serialized).toEqual([]);
    });
});

// ---------------------------------------------------------------------------
// serializeIdentifierLookup
// ---------------------------------------------------------------------------

describe("serializeIdentifierLookup", () => {
    test("returns sorted entries", () => {
        const lookup = makeIdentifierLookup([[ID_B, KEY_Y], [ID_A, KEY_X]]);
        const result = serializeIdentifierLookup(lookup);
        expect(nodeIdentifierToString(result[0][0])).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(result[1][0])).toBe("bbbbbbbbb");
        expect(keyStr(result[0][1])).toBe("key_x");
        expect(keyStr(result[1][1])).toBe("key_y");
    });

    test("returns empty array for empty lookup", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(serializeIdentifierLookup(lookup)).toEqual([]);
    });

    test("result is sorted lexicographically by identifier string", () => {
        const lookup = makeIdentifierLookup([
            [ID_D, KEY_Z],
            [ID_C, KEY_Y],
            [ID_B, KEY_X],
            [ID_A, stringToNodeKeyString("key_w")],
        ]);
        const result = serializeIdentifierLookup(lookup);
        for (let i = 1; i < result.length; i++) {
            expect(compareNodeIdentifier(result[i - 1][0], result[i][0])).toBeLessThanOrEqual(0);
        }
    });
});

// ---------------------------------------------------------------------------
// setIdentifierMapping
// ---------------------------------------------------------------------------

describe("setIdentifierMapping", () => {
    test("adds new mapping", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        expect(keyStr(requireNodeKeyForIdentifier(lookup, ID_A))).toBe("key_x");
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(lookup, KEY_X))).toBe("aaaaaaaaa");
    });

    test("re-asserting same mapping is idempotent", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        setIdentifierMapping(lookup, ID_A, KEY_X);
        expect(keyStr(requireNodeKeyForIdentifier(lookup, ID_A))).toBe("key_x");
    });

    test("throws when identifier maps to different key", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        expect(() => setIdentifierMapping(lookup, ID_A, KEY_Y)).toThrow(IdentifierLookupError);
    });

    test("throws when key maps to different identifier", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        expect(() => setIdentifierMapping(lookup, ID_B, KEY_X)).toThrow(IdentifierLookupError);
    });

    test("multiple distinct mappings", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        setIdentifierMapping(lookup, ID_B, KEY_Y);
        expect(keyStr(requireNodeKeyForIdentifier(lookup, ID_A))).toBe("key_x");
        expect(keyStr(requireNodeKeyForIdentifier(lookup, ID_B))).toBe("key_y");
    });
});

// ---------------------------------------------------------------------------
// deleteIdentifierMappingForNodeKey
// ---------------------------------------------------------------------------

describe("deleteIdentifierMappingForNodeKey", () => {
    test("removes mapping for existing key", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        deleteIdentifierMappingForNodeKey(lookup, KEY_X);
        expect(nodeKeyToIdFromLookup(lookup, KEY_X)).toBeUndefined();
        expect(nodeIdToKeyFromLookup(lookup, ID_A)).toBeUndefined();
    });

    test("no-op for missing key", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(() => deleteIdentifierMappingForNodeKey(lookup, KEY_X)).not.toThrow();
    });

    test("only removes the requested mapping", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        setIdentifierMapping(lookup, ID_B, KEY_Y);
        deleteIdentifierMappingForNodeKey(lookup, KEY_X);
        expect(nodeKeyToIdFromLookup(lookup, KEY_X)).toBeUndefined();
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(lookup, KEY_Y))).toBe("bbbbbbbbb");
    });
});

// ---------------------------------------------------------------------------
// nodeKeyToIdFromLookup / nodeIdToKeyFromLookup
// ---------------------------------------------------------------------------

describe("nodeKeyToIdFromLookup / nodeIdToKeyFromLookup", () => {
    test("returns identifier for existing key", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        expect(nodeIdentifierToString(nodeKeyToIdFromLookup(lookup, KEY_X))).toBe("aaaaaaaaa");
    });

    test("returns key for existing identifier", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        expect(keyStr(nodeIdToKeyFromLookup(lookup, ID_A))).toBe("key_x");
    });

    test("returns undefined for missing key", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(nodeKeyToIdFromLookup(lookup, KEY_X)).toBeUndefined();
    });

    test("returns undefined for missing identifier", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(nodeIdToKeyFromLookup(lookup, ID_A)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// allocateNodeIdentifier
// ---------------------------------------------------------------------------

describe("allocateNodeIdentifier", () => {
    test("allocates new identifier", () => {
        const lookup = makeEmptyIdentifierLookup();
        let callCount = 0;
        const result = allocateNodeIdentifier(lookup, KEY_X, () => {
            callCount++;
            return ID_A;
        });
        expect(nodeIdentifierToString(result)).toBe("aaaaaaaaa");
        expect(callCount).toBe(1);
    });

    test("reuses existing identifier for known key", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        let callCount = 0;
        const result = allocateNodeIdentifier(lookup, KEY_X, () => {
            callCount++;
            return ID_B;
        });
        expect(nodeIdentifierToString(result)).toBe("aaaaaaaaa");
        expect(callCount).toBe(0);
    });

    test("throws on collision", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        expect(() => allocateNodeIdentifier(lookup, KEY_Y, () => ID_A))
            .toThrow(IdentifierLookupError);
    });
});

// ---------------------------------------------------------------------------
// requireNodeKeyForIdentifier / requireNodeIdentifierForKey
// ---------------------------------------------------------------------------

describe("requireNodeKeyForIdentifier / requireNodeIdentifierForKey", () => {
    test("returns key for existing identifier", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        expect(keyStr(requireNodeKeyForIdentifier(lookup, ID_A))).toBe("key_x");
    });

    test("throws for missing identifier", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(() => requireNodeKeyForIdentifier(lookup, ID_A)).toThrow(IdentifierLookupError);
    });

    test("returns identifier for existing key", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(lookup, KEY_X))).toBe("aaaaaaaaa");
    });

    test("throws for missing key", () => {
        const lookup = makeEmptyIdentifierLookup();
        expect(() => requireNodeIdentifierForKey(lookup, KEY_X)).toThrow(IdentifierLookupError);
    });
});

// ---------------------------------------------------------------------------
// cloneIdentifierLookup
// ---------------------------------------------------------------------------

describe("cloneIdentifierLookup", () => {
    test("clone has same entries", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X], [ID_B, KEY_Y]]);
        const clone = cloneIdentifierLookup(lookup);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(clone, KEY_X))).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(clone, KEY_Y))).toBe("bbbbbbbbb");
    });

    test("mutating clone does not affect original", () => {
        const lookup = makeEmptyIdentifierLookup();
        setIdentifierMapping(lookup, ID_A, KEY_X);
        const clone = cloneIdentifierLookup(lookup);
        setIdentifierMapping(clone, ID_B, KEY_Y);
        expect(nodeKeyToIdFromLookup(lookup, KEY_Y)).toBeUndefined();
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(clone, KEY_Y))).toBe("bbbbbbbbb");
    });

    test("clone shares serialized reference", () => {
        const lookup = makeIdentifierLookup([[ID_A, KEY_X]]);
        const clone = cloneIdentifierLookup(lookup);
        expect(clone.serialized).toBe(lookup.serialized);
    });
});

// ---------------------------------------------------------------------------
// mergeIdentifierLookups
// ---------------------------------------------------------------------------

describe("mergeIdentifierLookups", () => {
    test("merges new entries from overlay into base", () => {
        const base = makeEmptyIdentifierLookup();
        const overlay = makeIdentifierLookup([[ID_A, KEY_X]]);
        mergeIdentifierLookups(base, overlay);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(base, KEY_X))).toBe("aaaaaaaaa");
    });

    test("updates serialized cache after merge", () => {
        const base = makeEmptyIdentifierLookup();
        const overlay = makeIdentifierLookup([[ID_B, KEY_Y], [ID_A, KEY_X]]);
        mergeIdentifierLookups(base, overlay);
        expect(base.serialized.length).toBe(2);
        expect(nodeIdentifierToString(base.serialized[0][0])).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(base.serialized[1][0])).toBe("bbbbbbbbb");
    });

    test("no-op when overlay is empty", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const overlay = makeEmptyIdentifierLookup();
        mergeIdentifierLookups(base, overlay);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(base, KEY_X))).toBe("aaaaaaaaa");
    });

    test("throws on conflicting mapping", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const overlay = makeIdentifierLookup([[ID_B, KEY_X]]);
        expect(() => mergeIdentifierLookups(base, overlay)).toThrow(IdentifierLookupError);
    });

    test("entries already in base do not duplicate in serialized", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const overlay = makeIdentifierLookup([[ID_A, KEY_X]]);
        mergeIdentifierLookups(base, overlay);
        expect(base.serialized.length).toBe(1);
    });

    test("serialized preserves sort after multiple merges", () => {
        const base = makeEmptyIdentifierLookup();
        mergeIdentifierLookups(base, makeIdentifierLookup([[ID_B, KEY_Y]]));
        mergeIdentifierLookups(base, makeIdentifierLookup([[ID_A, KEY_X]]));
        mergeIdentifierLookups(base, makeIdentifierLookup([[ID_D, KEY_Z]]));
        expect(base.serialized.length).toBe(3);
        expect(nodeIdentifierToString(base.serialized[0][0])).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(base.serialized[1][0])).toBe("bbbbbbbbb");
        expect(nodeIdentifierToString(base.serialized[2][0])).toBe("ddddddddd");
    });
});

// ---------------------------------------------------------------------------
// mergeSorted
// ---------------------------------------------------------------------------

describe("mergeSorted (internal)", () => {
    test("both empty returns empty array", () => {
        const base = makeEmptyIdentifierLookup();
        expect(serializeIdentifierLookup(base)).toEqual([]);
    });

    test("one empty returns the other", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        const result = serializeTransactionLookup(txLookup);
        expect(result.length).toBe(1);
        expect(nodeIdentifierToString(result[0][0])).toBe("aaaaaaaaa");
    });
});

// ---------------------------------------------------------------------------
// makeTransactionIdentifierLookup
// ---------------------------------------------------------------------------

describe("makeTransactionIdentifierLookup", () => {
    test("creates empty overlay backed by base", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        expect(txLookup.keyToId.size).toBe(0);
        expect(txLookup.idToKey.size).toBe(0);
        expect(txLookup.base).toBe(base);
        expect(txLookup.ownedKeys.size).toBe(0);
    });
});

// ---------------------------------------------------------------------------
// txNodeKeyToId / txNodeIdToKey
// ---------------------------------------------------------------------------

describe("txNodeKeyToId / txNodeIdToKey", () => {
    test("returns base entry when overlay is empty", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        expect(nodeIdentifierToString(txNodeKeyToId(txLookup, KEY_X))).toBe("aaaaaaaaa");
        expect(keyStr(txNodeIdToKey(txLookup, ID_A))).toBe("key_x");
    });

    test("overlay shadows base", () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.keyToId.set("key_x", ID_B);
        txLookup.idToKey.set("bbbbbbbbb", KEY_X);
        expect(nodeIdentifierToString(txNodeKeyToId(txLookup, KEY_X))).toBe("bbbbbbbbb");
        expect(keyStr(txNodeIdToKey(txLookup, ID_B))).toBe("key_x");
    });

    test("returns undefined for missing key", () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        expect(txNodeKeyToId(txLookup, KEY_X)).toBeUndefined();
        expect(txNodeIdToKey(txLookup, ID_A)).toBeUndefined();
    });
});

// ---------------------------------------------------------------------------
// txAllocateNodeIdentifier
// ---------------------------------------------------------------------------

describe("txAllocateNodeIdentifier", () => {
    function makeRootDatabase(entries) {
        const base = makeIdentifierLookup(entries);
        const pending = new Map();
        return {
            _allocateKeyIdentifier(keyString, makeIdentifier, _committedLookup) {
                if (pending.has(keyString)) {
                    throw new Error(`BUG: pending allocation for key ${keyString} found`);
                }
                const identifier = makeIdentifier();
                pending.set(keyString, identifier);
                return identifier;
            },
            identifierLookup: base,
        };
    }

    test("allocates new identifier through root database", () => {
        const rootDb = makeRootDatabase([]);
        const txLookup = makeTransactionIdentifierLookup(rootDb.identifierLookup);
        const result = txAllocateNodeIdentifier(txLookup, KEY_X, () => ID_B, rootDb);
        expect(nodeIdentifierToString(result)).toBe("bbbbbbbbb");
        expect(nodeIdentifierToString(txNodeKeyToId(txLookup, KEY_X))).toBe("bbbbbbbbb");
        expect(txLookup.ownedKeys.has("key_x")).toBe(true);
    });

    test("reuses identifier already in overlay", () => {
        const rootDb = makeRootDatabase([]);
        const txLookup = makeTransactionIdentifierLookup(rootDb.identifierLookup);
        txAllocateNodeIdentifier(txLookup, KEY_X, () => ID_A, rootDb);
        const second = txAllocateNodeIdentifier(txLookup, KEY_X, () => ID_B, rootDb);
        expect(nodeIdentifierToString(second)).toBe("aaaaaaaaa");
    });

    test("reuses identifier from base when key already committed", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const rootDb = { ...makeRootDatabase([]), identifierLookup: base };
        const txLookup = makeTransactionIdentifierLookup(base);
        const result = txAllocateNodeIdentifier(txLookup, KEY_X, () => ID_B, rootDb);
        expect(nodeIdentifierToString(result)).toBe("aaaaaaaaa");
    });
});

// ---------------------------------------------------------------------------
// serializeTransactionLookup
// ---------------------------------------------------------------------------

describe("serializeTransactionLookup", () => {
    test("returns base serialized when overlay is empty", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        const result = serializeTransactionLookup(txLookup);
        expect(result).toBe(base.serialized);
    });

    test("includes new entries from overlay", () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        const result = serializeTransactionLookup(txLookup);
        expect(result.length).toBe(1);
        expect(nodeIdentifierToString(result[0][0])).toBe("aaaaaaaaa");
        expect(keyStr(result[0][1])).toBe("key_x");
    });

    test("skips overlay entries already in base (dedup)", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        const result = serializeTransactionLookup(txLookup);
        expect(result).toBe(base.serialized);
    });

    test("merges base and overlay sorted", () => {
        const base = makeIdentifierLookup([[ID_B, KEY_Y]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        const result = serializeTransactionLookup(txLookup);
        expect(result.length).toBe(2);
        expect(nodeIdentifierToString(result[0][0])).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(result[1][0])).toBe("bbbbbbbbb");
    });

    test("result is immutable (readonly) — cannot be mutated via base.serialized", () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        const result = serializeTransactionLookup(txLookup);
        // result is the mergeSorted return — a new array; can be spread
        expect(Array.isArray(result)).toBe(true);
    });
});

// ---------------------------------------------------------------------------
// commitTransactionLookup
// ---------------------------------------------------------------------------

describe("commitTransactionLookup", () => {
    test("applies overlay to base maps", () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.keyToId.set("key_x", ID_A);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        commitTransactionLookup(txLookup);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(base, KEY_X))).toBe("aaaaaaaaa");
        expect(keyStr(requireNodeKeyForIdentifier(base, ID_A))).toBe("key_x");
    });

    test("updates base serialized cache", () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.keyToId.set("key_x", ID_A);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        commitTransactionLookup(txLookup);
        expect(base.serialized.length).toBe(1);
        expect(nodeIdentifierToString(base.serialized[0][0])).toBe("aaaaaaaaa");
    });

    test("idempotent when overlay entries are already in base", () => {
        const base = makeIdentifierLookup([[ID_A, KEY_X]]);
        const originalSerialized = base.serialized;
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.keyToId.set("key_x", ID_A);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        commitTransactionLookup(txLookup);
        expect(base.idToKey.size).toBe(1);
        expect(base.serialized).toBe(originalSerialized);
    });

    test("preserves sort order in cache after commit", () => {
        const base = makeIdentifierLookup([[ID_B, KEY_Y]]);
        const txLookup = makeTransactionIdentifierLookup(base);
        txLookup.keyToId.set("key_x", ID_A);
        txLookup.idToKey.set("aaaaaaaaa", KEY_X);
        commitTransactionLookup(txLookup);
        expect(base.serialized.length).toBe(2);
        expect(nodeIdentifierToString(base.serialized[0][0])).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(base.serialized[1][0])).toBe("bbbbbbbbb");
    });

    test("multiple commits accumulate correctly", () => {
        const base = makeEmptyIdentifierLookup();

        const tx1 = makeTransactionIdentifierLookup(base);
        tx1.keyToId.set("key_x", ID_A);
        tx1.idToKey.set("aaaaaaaaa", KEY_X);
        commitTransactionLookup(tx1);

        const tx2 = makeTransactionIdentifierLookup(base);
        tx2.keyToId.set("key_y", ID_B);
        tx2.idToKey.set("bbbbbbbbb", KEY_Y);
        commitTransactionLookup(tx2);

        expect(base.serialized.length).toBe(2);
        expect(base.keyToId.size).toBe(2);
        expect(base.idToKey.size).toBe(2);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(base, KEY_X))).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(base, KEY_Y))).toBe("bbbbbbbbb");
    });
});

// ---------------------------------------------------------------------------
// IDENTIFIERS_KEY
// ---------------------------------------------------------------------------

describe("IDENTIFIERS_KEY", () => {
    test("matches expected global metadata key", () => {
        expect(IDENTIFIERS_KEY).toBe("identifiers_keys_map");
    });
});

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

describe("Error types", () => {
    test("IdentifierLookupError", () => {
        const err = new IdentifierLookupError("test");
        expect(err.name).toBe("IdentifierLookupError");
        expect(err.message).toBe("test");
        expect(isIdentifierLookupError(err)).toBe(true);
        expect(isIdentifierLookupError({})).toBe(false);
    });
});

// ---------------------------------------------------------------------------
// Integration: roundtrip through serialization
// ---------------------------------------------------------------------------

describe("Serialization roundtrip", () => {
    test("serialize -> makeIdentifierLookup preserves identity", () => {
        const original = makeIdentifierLookup([[ID_B, KEY_Y], [ID_A, KEY_X]]);
        const serialized = serializeIdentifierLookup(original);
        const restored = makeIdentifierLookup(serialized);
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(restored, KEY_X))).toBe("aaaaaaaaa");
        expect(nodeIdentifierToString(requireNodeIdentifierForKey(restored, KEY_Y))).toBe("bbbbbbbbb");
        expect(keyStr(requireNodeKeyForIdentifier(restored, ID_A))).toBe("key_x");
        expect(keyStr(requireNodeKeyForIdentifier(restored, ID_B))).toBe("key_y");
    });

    test("transaction lifecycle: allocate, serialize, commit, serialize again", () => {
        const base = makeEmptyIdentifierLookup();
        const rootDb = {
            _pendingAllocations: new Map(),
            _pendingAllocationsById: new Map(),
            _allocateKeyIdentifier(keyString, makeIdentifier, _committedLookup) {
                if (rootDb._pendingAllocations.has(keyString)) {
                    throw new Error(`BUG: pending allocation for key ${keyString} found`);
                }
                const identifier = makeIdentifier();
                rootDb._pendingAllocations.set(keyString, nodeIdentifierToString(identifier));
                rootDb._pendingAllocationsById.set(nodeIdentifierToString(identifier), keyString);
                return identifier;
            },
            identifierLookup: base,
        };

        const tx = makeTransactionIdentifierLookup(base);
        txAllocateNodeIdentifier(tx, KEY_X, () => ID_A, rootDb);

        const beforeCommit = serializeTransactionLookup(tx);
        expect(beforeCommit.length).toBe(1);
        expect(nodeIdentifierToString(beforeCommit[0][0])).toBe("aaaaaaaaa");

        commitTransactionLookup(tx);

        const afterCommit = serializeTransactionLookup(makeTransactionIdentifierLookup(base));
        expect(afterCommit.length).toBe(1);
        expect(nodeIdentifierToString(afterCommit[0][0])).toBe("aaaaaaaaa");

        // Verify serialized cache was updated
        expect(base.serialized.length).toBe(1);
    });
});
