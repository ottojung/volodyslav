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
    makeIdentifierLookup,
    makeEmptyIdentifierLookup,
    makeTransactionIdentifierLookup,
    txAllocateNodeIdentifier,
    serializeTransactionLookup,
    commitTransactionLookup,
    nodeIdentifierFromString,
    stringToNodeKeyString,

} = require('../src/generators/incremental_graph/database');

/**
 * Default tryReserve callback for isolated tests — always accepts the candidate.
 * @param {string} _candidateString
 * @returns {boolean}
 */
function acceptReservation(_candidateString) {
    return true;
}

/**
 * Build a simple deterministic makeIdentifier factory.
 * @param {string[]} candidates - Sequence of identifier strings to yield in order.
 * @returns {(attempt: number) => import('../src/generators/incremental_graph/database').NodeIdentifier}
 */
function makeIdFactory(candidates) {
    return (attempt) => nodeIdentifierFromString(candidates[attempt]);
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
        const idA = nodeIdentifierFromString('aaaaaaaaa');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        expect(result).toEqual([['aaaaaaaaa', 'keyA']]);
    });

    test('empty base + overlay allocation → overlay entry only', () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);

        const keyB = stringToNodeKeyString('keyB');
        txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['bbbbbbbbb']), acceptReservation);

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        expect(result).toEqual([['bbbbbbbbb', 'keyB']]);
    });

    test('populated base + overlay allocation → BOTH base and overlay entries present', () => {
        // This is the critical invariant: every disk write captures the complete
        // state, so no prior allocation is ever silently lost.
        const idA = nodeIdentifierFromString('aaaaaaaaa');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        const keyB = stringToNodeKeyString('keyB');
        txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['bbbbbbbbb']), acceptReservation);

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        // Sorted ascending by identifier string.
        expect(result).toEqual([
            ['aaaaaaaaa', 'keyA'],
            ['bbbbbbbbb', 'keyB'],
        ]);
    });

    test('output is sorted ascending by identifier string regardless of insertion order', () => {
        const idZ = nodeIdentifierFromString('zzzzzzzzz');
        const keyZ = stringToNodeKeyString('keyZ');
        const base = makeIdentifierLookup([[idZ, keyZ]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        // Allocate 'aaaaaaaaa' in the overlay — lexicographically before base entry.
        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(txLookup, keyA, makeIdFactory(['aaaaaaaaa']), acceptReservation);

        const result = toStringPairs(serializeTransactionLookup(txLookup));
        expect(result[0][0]).toBe('aaaaaaaaa');
        expect(result[1][0]).toBe('zzzzzzzzz');
    });
});

// ---------------------------------------------------------------------------
// 2. Sequential commit + new transaction sees accumulated state
// ---------------------------------------------------------------------------

describe('sequential commits accumulate all entries without loss', () => {
    test('T1 commits, T2 sees T1 allocations and adds its own', () => {
        const base = makeEmptyIdentifierLookup();

        // Transaction T1: allocate keyA → 'aaaaaaaaa'
        const tx1 = makeTransactionIdentifierLookup(base);
        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(tx1, keyA, makeIdFactory(['aaaaaaaaa']), acceptReservation);

        // Simulate disk flush: serialize (verifies full state captured).
        const t1Serialized = toStringPairs(serializeTransactionLookup(tx1));
        expect(t1Serialized).toEqual([['aaaaaaaaa', 'keyA']]);

        // Commit T1 into base (equivalent to commitTransactionLookup).
        commitTransactionLookup(tx1);

        // Transaction T2: base now has keyA; allocate keyB → 'bbbbbbbbb'
        const tx2 = makeTransactionIdentifierLookup(base);
        const keyB = stringToNodeKeyString('keyB');
        txAllocateNodeIdentifier(tx2, keyB, makeIdFactory(['bbbbbbbbb']), acceptReservation);

        // Serialize T2: must contain BOTH keyA (from base) AND keyB (new).
        const t2Serialized = toStringPairs(serializeTransactionLookup(tx2));
        expect(t2Serialized).toEqual([
            ['aaaaaaaaa', 'keyA'],
            ['bbbbbbbbb', 'keyB'],
        ]);

        // Commit T2 into base.
        commitTransactionLookup(tx2);

        // Transaction T3: allocate keyC → 'ccccccccc'
        const tx3 = makeTransactionIdentifierLookup(base);
        const keyC = stringToNodeKeyString('keyC');
        txAllocateNodeIdentifier(tx3, keyC, makeIdFactory(['ccccccccc']), acceptReservation);

        const t3Serialized = toStringPairs(serializeTransactionLookup(tx3));
        expect(t3Serialized).toEqual([
            ['aaaaaaaaa', 'keyA'],
            ['bbbbbbbbb', 'keyB'],
            ['ccccccccc', 'keyC'],
        ]);
    });

    test('re-allocating the same key in a new transaction returns the committed identifier', () => {
        const base = makeEmptyIdentifierLookup();
        const tx1 = makeTransactionIdentifierLookup(base);
        const keyA = stringToNodeKeyString('keyA');
        const id1 = txAllocateNodeIdentifier(tx1, keyA, makeIdFactory(['aaaaaaaaa']), acceptReservation);
        commitTransactionLookup(tx1);

        // Second transaction: re-request the same key — must get the same identifier.
        const tx2 = makeTransactionIdentifierLookup(base);
        const id2 = txAllocateNodeIdentifier(tx2, keyA, makeIdFactory(['zzzzzzzzz']), acceptReservation);
        expect(String(id2)).toBe(String(id1));
    });
});

// ---------------------------------------------------------------------------
// 3. Collision detection spans both base and overlay
// ---------------------------------------------------------------------------

describe('collision detection covers base and overlay simultaneously', () => {
    test('a candidate identifier already in the base triggers a retry', () => {
        const idA = nodeIdentifierFromString('aaaaaaaaa');
        const keyA = stringToNodeKeyString('keyA');
        const base = makeIdentifierLookup([[idA, keyA]]);
        const txLookup = makeTransactionIdentifierLookup(base);

        // First candidate 'aaaaaaaaa' collides with base; second 'bbbbbbbbb' is free.
        const keyB = stringToNodeKeyString('keyB');
        const idB = txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['aaaaaaaaa', 'bbbbbbbbb']), acceptReservation);
        expect(String(idB)).toBe('bbbbbbbbb');
    });

    test('a candidate identifier already in the overlay triggers a retry', () => {
        const base = makeEmptyIdentifierLookup();
        const txLookup = makeTransactionIdentifierLookup(base);

        // Allocate 'aaaaaaaaa' to keyA in the overlay.
        const keyA = stringToNodeKeyString('keyA');
        txAllocateNodeIdentifier(txLookup, keyA, makeIdFactory(['aaaaaaaaa']), acceptReservation);

        // Now allocate keyB: first candidate 'aaaaaaaaa' collides with overlay.
        const keyB = stringToNodeKeyString('keyB');
        const idB = txAllocateNodeIdentifier(txLookup, keyB, makeIdFactory(['aaaaaaaaa', 'bbbbbbbbb']), acceptReservation);
        expect(String(idB)).toBe('bbbbbbbbb');
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
        txAllocateNodeIdentifier(txLookup, keyA, makeIdFactory(['aaaaaaaaa']), acceptReservation);

        expect(base.keyToId.size).toBe(0); // base unchanged before commit

        commitTransactionLookup(txLookup);

        expect(base.keyToId.size).toBe(1); // base now has the allocation
        expect(String(base.keyToId.get('keyA'))).toBe('aaaaaaaaa');
        expect(String(base.idToKey.get('aaaaaaaaa'))).toBe('keyA');
    });

    test('no-op transaction (no allocations) leaves base unchanged', () => {
        const idA = nodeIdentifierFromString('aaaaaaaaa');
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
// 5. Error conditions
// ---------------------------------------------------------------------------

describe('error conditions', () => {
    test('stringToNodeIdentifier accepts a valid 9-character lowercase string', () => {
        const { stringToNodeIdentifier } = require('../src/generators/incremental_graph/database');
        expect(() => stringToNodeIdentifier('aaaaaaaaa')).not.toThrow();
    });
});
