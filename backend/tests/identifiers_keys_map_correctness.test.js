/**
 * Correctness tests for `identifiers_keys_map` serialization (Objective 1).
 *
 * These tests prove that:
 *  1. `serializeTransactionLookup` always captures the FULL state (base + overlay),
 *     never just the delta — ensuring no prior allocations are lost on commit.
 *  2. Sequential commit+serialize cycles accumulate all entries without loss.
 *  3. Collision detection works across base and overlay simultaneously.
 *  4. `commitTransactionLookup` correctly merges overlay into base, and a
 *     subsequent transaction built on the updated base sees all prior entries.
 *
 * The mutex serialization guarantee (all writes happen inside
 * `withComputedStateMutex`) is documented in graph_state.js and is
 * structurally enforced — it is not re-tested here because it requires
 * an integration harness.  The unit tests below verify the algebraic
 * properties that make the serialization correct regardless of scheduling.
 */

const {
    IdentifierLookupError,
    isIdentifierLookupError,
    isMalformedIdentifierLookupError,
    isMissingIdentifierLookupError,
    makeIdentifierLookup,
    makeEmptyIdentifierLookup,
    makeTransactionIdentifierLookup,
    MissingIdentifierLookupError,
    txAllocateNodeIdentifier,
    serializeTransactionLookup,
    commitTransactionLookup,
    nodeIdentifierFromString,
    stringToNodeKeyString,
} = require('../src/generators/incremental_graph/database');
const {
    parseIdentifierLookup,
} = require('../src/generators/incremental_graph/database/sync_merge_identifier_lookup');
const {
    MalformedIdentifierLookupError,
} = require('../src/generators/incremental_graph/database/replica_errors');

/**
 * Create a minimal rootDatabase mock for txAllocateNodeIdentifier.
 * Uses a simple deterministic identifier factory that yields fixed strings.
 * @returns {import('../src/generators/incremental_graph/database').RootDatabase}
 */
function makeMockRootDatabase() {
    /** @type {Map<string, string>} */
    const pendingAllocations = new Map();
    /** @type {Set<string>} */
    const pendingAllocationIdentifiers = new Set();
    return {
        _allocateKeyIdentifier(keyString, makeIdentifier, committedLookup) {
            if (pendingAllocations.has(keyString)) {
                throw new Error(`BUG: pending allocation for key ${keyString} found during allocation under telescope lock`);
            }
            const candidate = makeIdentifier();
            const candidateStr = String(candidate);
            if (committedLookup.idToKey.get(candidateStr) !== undefined) {
                throw new Error(`BUG: identifier collision with committed lookup: ${candidateStr}`);
            }
            if (pendingAllocationIdentifiers.has(candidateStr)) {
                throw new Error(`BUG: identifier collision with pending allocation: ${candidateStr}`);
            }
            pendingAllocations.set(keyString, candidateStr);
            pendingAllocationIdentifiers.add(candidateStr);
            return candidate;
        },
        releaseIdentifierReservations(_ownedKeys) {},
    };
}

/**
 * Build a simple deterministic makeIdentifier factory.
 * @param {string[]} candidates - Sequence of identifier strings to yield in order.
 * @returns {() => import('../src/generators/incremental_graph/database').NodeIdentifier}
 */
function makeIdFactory(candidates) {
    let index = 0;
    return () => nodeIdentifierFromString(candidates[index++]);
}

/**
 * Extract the sorted string pairs from a serialized lookup for easy assertion.
 * @param {Array<[import('../src/generators/incremental_graph/database').NodeIdentifier,
 *                import('../src/generators/incremental_graph/database').NodeKeyString]>} serialized
 * @returns {Array<[string, string]>}
 */
function toStringPairs(serialized) {
    return serialized.map(([id, key]) => [String(id), String(key)]);
}

// ---------------------------------------------------------------------------
// 1. serializeTransactionLookup includes base entries
// ---------------------------------------------------------------------------

describe('serializeTransactionLookup includes both base and overlay entries', () => {
    test('empty base + empty overlay → empty serialization', () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        expect(serializeTransactionLookup(txLookup)).toEqual([]);
    });

    test('populated base + empty overlay → base entries only', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        expect(result).toEqual([['1-abcdefghi', 'keyA']]);
    });

    test('empty base + overlay allocation → overlay entry only', () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);

        const keyB = stringToNodeKeyString('keyB');
        txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['2-abcdefghi']), makeMockRootDatabase());

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        expect(result).toEqual([['2-abcdefghi', 'keyB']]);
    });

    test('populated base + overlay allocation → BOTH base and overlay entries present', () => {
        // This is the critical invariant: every disk write captures the complete
        // state, so no prior allocation is ever silently lost.
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        const keyB = stringToNodeKeyString('keyB');
        txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['2-abcdefghi']), makeMockRootDatabase());

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        // Sorted ascending by identifier string.
        expect(result).toEqual([
            ['1-abcdefghi', 'keyA'],
            ['2-abcdefghi', 'keyB'],
        ]);
    });

    test('output is sorted ascending by identifier string regardless of insertion order', () => {
        const idZ = nodeIdentifierFromString('z-abcdefghi');
        const keyZ = stringToNodeKeyString('keyZ');
        const base = makeIdentifierLookup([[idZ, keyZ]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        // Allocate '1-abcdefghi' in the overlay — lexicographically before base entry.
        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(txLookup, keyA, makeIdFactory(['1-abcdefghi']), makeMockRootDatabase());

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        expect(result[0][0]).toBe('1-abcdefghi');
        expect(result[1][0]).toBe('z-abcdefghi');
    });
});

// ---------------------------------------------------------------------------
// 2. Sequential commit + new transaction sees accumulated state
// ---------------------------------------------------------------------------

describe('sequential commits accumulate all entries without loss', () => {
    test('T1 commits, T2 sees T1 allocations and adds its own', () => {
        const base = makeEmptyIdentifierLookup();

        // Transaction T1: allocate keyA → '1-abcdefghi'
        const tx1 = makeTransactionIdentifierLookup(base);
        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(tx1, keyA, makeIdFactory(['1-abcdefghi']), makeMockRootDatabase());

        // Simulate disk flush: serialize (verifies full state captured).
        const t1Serialized = toStringPairs(serializeTransactionLookup(tx1));
        expect(t1Serialized).toEqual([['1-abcdefghi', 'keyA']]);

        // Commit T1 into base (equivalent to commitTransactionLookup).
        commitTransactionLookup(tx1);

        // Transaction T2: base now has keyA; allocate keyB → '2-abcdefghi'
        const tx2 = makeTransactionIdentifierLookup(base);
        const keyB = stringToNodeKeyString('keyB');
        txAllocateNodeIdentifier(tx2, keyB, makeIdFactory(['2-abcdefghi']), makeMockRootDatabase());

        // Serialize T2: must contain BOTH keyA (from base) AND keyB (new).
        const t2Serialized = toStringPairs(serializeTransactionLookup(tx2));
        expect(t2Serialized).toEqual([
            ['1-abcdefghi', 'keyA'],
            ['2-abcdefghi', 'keyB'],
        ]);

        // Commit T2 into base.
        commitTransactionLookup(tx2);

        // Transaction T3: allocate keyC → '3-abcdefghi'
        const tx3 = makeTransactionIdentifierLookup(base);
        const keyC = stringToNodeKeyString('keyC');
        txAllocateNodeIdentifier(tx3, keyC, makeIdFactory(['3-abcdefghi']), makeMockRootDatabase());

        const t3Serialized = toStringPairs(serializeTransactionLookup(tx3));
        expect(t3Serialized).toEqual([
            ['1-abcdefghi', 'keyA'],
            ['2-abcdefghi', 'keyB'],
            ['3-abcdefghi', 'keyC'],
        ]);
    });

    test('re-allocating the same key in a new transaction returns the committed identifier', () => {
        const base = makeEmptyIdentifierLookup();
        const tx1 = makeTransactionIdentifierLookup(base);
        const keyA = stringToNodeKeyString('keyA');
        const id1 = txAllocateNodeIdentifier(tx1, keyA, makeIdFactory(['1-abcdefghi']), makeMockRootDatabase());
        commitTransactionLookup(tx1);

        // Second transaction: re-request the same key — must get the same identifier.
        const tx2 = makeTransactionIdentifierLookup(base);
        const id2 = txAllocateNodeIdentifier(tx2, keyA, makeIdFactory(['z-abcdefghi']), makeMockRootDatabase());
        expect(String(id2)).toBe(String(id1));
    });
});

// ---------------------------------------------------------------------------
// 3. Collision detection spans both base and overlay
// ---------------------------------------------------------------------------

describe('collision detection covers base and overlay simultaneously', () => {
    test('a candidate identifier already in the base throws a BUG error', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        // With fingerprint-prefixed identifiers collisions are impossible;
        // if one occurs it is a correctness bug.
        const keyB = stringToNodeKeyString('keyB');
        expect(() => txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['1-abcdefghi']), makeMockRootDatabase()))
            .toThrow(/BUG.*collision.*committed/);
    });

    test('a candidate identifier already in the overlay throws a BUG error', () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);
        const overlayMock = makeMockRootDatabase();

        // Allocate '1-abcdefghi' to keyA in the overlay.
        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(txLookup, keyA, makeIdFactory(['1-abcdefghi']), overlayMock);

        // With fingerprint-prefixed identifiers collisions are impossible;
        // if one occurs it is a correctness bug.
        const keyB = stringToNodeKeyString('keyB');
        expect(() => txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['1-abcdefghi']), overlayMock))
            .toThrow(/BUG.*collision.*pending/);
    });
});

// ---------------------------------------------------------------------------
// 4. commitTransactionLookup correctly merges overlay into base
// ---------------------------------------------------------------------------

describe('commitTransactionLookup merges overlay into base', () => {
    test('base is mutated in-place with all overlay entries after commit', () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);

        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(txLookup, keyA, makeIdFactory(['1-abcdefghi']), makeMockRootDatabase());

        expect(base.keyToId.size).toBe(0); // base unchanged before commit

        commitTransactionLookup(txLookup);

        expect(base.keyToId.size).toBe(1); // base now has the allocation
        expect(String(base.keyToId.get('keyA'))).toBe('1-abcdefghi');
        expect(String(base.idToKey.get('1-abcdefghi'))).toBe('keyA');
    });

    test('no-op transaction (no allocations) leaves base unchanged', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        // No allocations in this transaction.
        commitTransactionLookup(txLookup);

        expect(base.keyToId.size).toBe(1);
        expect(base.idToKey.size).toBe(1);
    });
});

// ---------------------------------------------------------------------------
// 5. Error conditions — parseIdentifierLookup negative tests
// ---------------------------------------------------------------------------

describe('parseIdentifierLookup negative tests', () => {
    test('undefined rawEntries throws MissingIdentifierLookupError', () => {
        expect(() => parseIdentifierLookup(undefined, 'test context'))
            .toThrow(MissingIdentifierLookupError);
    });

    test('undefined rawEntries message includes context', () => {
        let error;
        try { parseIdentifierLookup(undefined, 'test context'); } catch (e) { error = e; }
        expect(isMissingIdentifierLookupError(error)).toBe(true);
        expect(String(error.message)).toContain('test context');
    });

    test('non-array rawEntries throws MalformedIdentifierLookupError', () => {
        expect(() => parseIdentifierLookup(12345, 'test'))
            .toThrow(MalformedIdentifierLookupError);
    });

    test('non-array rawEntries is caught by isMalformedIdentifierLookupError guard', () => {
        let error;
        try { parseIdentifierLookup('not-an-array', 'test'); } catch (e) { error = e; }
        expect(isMalformedIdentifierLookupError(error)).toBe(true);
    });

    test('string rawEntries throws MalformedIdentifierLookupError', () => {
        expect(() => parseIdentifierLookup('some-string', 'test'))
            .toThrow(MalformedIdentifierLookupError);
    });

    test('null rawEntries throws MalformedIdentifierLookupError', () => {
        expect(() => parseIdentifierLookup(null, 'test'))
            .toThrow(MalformedIdentifierLookupError);
    });

    test('duplicate identifiers in entries throws IdentifierLookupError', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const keyB = stringToNodeKeyString('keyB');
        const entries = [[idA, keyA], [idA, keyB]];
        expect(() => makeIdentifierLookup(entries)).toThrow(IdentifierLookupError);
    });

    test('duplicate identifiers error message mentions the identifier', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const keyB = stringToNodeKeyString('keyB');
        const entries = [[idA, keyA], [idA, keyB]];
        let error;
        try { makeIdentifierLookup(entries); } catch (e) { error = e; }
        expect(isIdentifierLookupError(error)).toBe(true);
        expect(String(error.message)).toContain('1-abcdefghi');
    });

    test('duplicate keys in entries throws IdentifierLookupError', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const idB = nodeIdentifierFromString('2-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const entries = [[idA, keyA], [idB, keyA]];
        expect(() => makeIdentifierLookup(entries)).toThrow(IdentifierLookupError);
    });

    test('duplicate keys error message mentions the key', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const idB = nodeIdentifierFromString('2-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const entries = [[idA, keyA], [idB, keyA]];
        let error;
        try { makeIdentifierLookup(entries); } catch (e) { error = e; }
        expect(isIdentifierLookupError(error)).toBe(true);
        expect(String(error.message)).toContain('keyA');
    });

    test('parseIdentifierLookup forwards duplicate-identifier error from makeIdentifierLookup', () => {
        const idA = nodeIdentifierFromString('1-abcdefghi');
        const keyA = stringToNodeKeyString('keyA');
        const keyB = stringToNodeKeyString('keyB');
        expect(() => parseIdentifierLookup([[idA, keyA], [idA, keyB]], 'test'))
            .toThrow(IdentifierLookupError);
    });
});
