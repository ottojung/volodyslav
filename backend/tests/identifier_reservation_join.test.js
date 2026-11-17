/**
 * Tests for the joinable identifier reservation.
 *
 * A reservation for a node key outlives the telescope window of the operation
 * which took it, because an operation holds every reservation it took until it
 * ends. A second live operation which needs the same key while the first is still
 * running therefore joins the first's reservation and shares its identifier
 * instead of minting a second identifier for the same key.
 *
 * These tests exercise the real RootDatabase, so they pin the production
 * reservation lifetime rather than a test double's copy of it.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    commitTransactionLookup,
    getRootDatabase,
    makeTransactionIdentifierLookup,
    nodeIdentifierFromString,
    nodeIdentifierToString,
    txNodeKeyToId,
} = require("../src/generators/incremental_graph/database");
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

/**
 * @returns {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities & {tmpDir: string}}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reservation-join-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

/**
 * @param {string} tmpDir
 */
function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}

const KEY_Z = JSON.stringify({ head: "z", args: [] });

describe('identifier reservation', () => {
    test('a second operation needing a reserved key joins the reservation and shares its identifier', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            const committed = db.getActiveIdentifierLookup();

            const first = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            expect(db._pendingAllocations.size).toBe(1);

            // The first operation's telescope window for the key has closed, but the
            // reservation it took is still held by the still-running operation.
            const joined = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );

            expect(nodeIdentifierToString(joined)).toBe(nodeIdentifierToString(first));
            expect(db._pendingAllocations.size).toBe(1);
            expect(db._pendingAllocations.get(KEY_Z)?.waiters).toBe(2);

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test('a joining operation does not consume a further identifier from the counter', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            const committed = db.getActiveIdentifierLookup();

            const watermarkAfterFirst = db.getCurrentAllocationWatermark();
            const first = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            const watermarkBeforeJoin = db.getCurrentAllocationWatermark();
            const joined = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            const watermarkAfterJoin = db.getCurrentAllocationWatermark();

            expect(watermarkAfterFirst).toBeLessThan(watermarkBeforeJoin);
            expect(watermarkAfterJoin).toBe(watermarkBeforeJoin);
            expect(nodeIdentifierToString(joined)).toBe(nodeIdentifierToString(first));

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test('the reservation survives the operations which took it giving up their holds one at a time', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            const committed = db.getActiveIdentifierLookup();

            const first = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );

            // The operation which allocated the reservation ends first, and rolls
            // back. Its hold is given up, and the reservation survives for the
            // operation which joined it.
            db.releaseIdentifierReservations(new Set([KEY_Z]));
            expect(db._pendingAllocations.get(KEY_Z)?.waiters).toBe(1);
            expect(db._pendingAllocationsById.has(nodeIdentifierToString(first))).toBe(true);

            // The joining operation now needs the key again and finds its own
            // reservation, not a new identifier.
            const rejoined = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            expect(nodeIdentifierToString(rejoined)).toBe(nodeIdentifierToString(first));

            db.releaseIdentifierReservations(new Set([KEY_Z]));
            db.releaseIdentifierReservations(new Set([KEY_Z]));
            expect(db._pendingAllocations.size).toBe(0);
            expect(db._pendingAllocationsById.size).toBe(0);

            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test('a key whose last holder gave up its reservation is allocated a fresh identifier', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            const committed = db.getActiveIdentifierLookup();

            const first = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            db.releaseIdentifierReservations(new Set([KEY_Z]));
            expect(db._pendingAllocations.size).toBe(0);

            // No live operation holds the key any more, and the identifier was never
            // committed, so the next operation allocates its own.
            const second = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );
            expect(nodeIdentifierToString(second)).not.toBe(nodeIdentifierToString(first));
            expect(db._pendingAllocations.get(KEY_Z)?.waiters).toBe(1);

            db.releaseIdentifierReservations(new Set([KEY_Z]));
            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test('a reservation whose identifier is already committed is not re-joined, because the committed lookup answers first', async () => {
        const capabilities = getTestCapabilities();
        try {
            const db = await getRootDatabase(capabilities);
            const committed = db.getActiveIdentifierLookup();

            const identifier = db._allocateKeyIdentifier(
                KEY_Z,
                () => db.generateNodeIdentifier(),
                committed,
            );

            // The operation holding the reservation commits its identifier.
            const txLookup = makeTransactionIdentifierLookup(committed);
            txLookup.keyToId.set(KEY_Z, identifier);
            txLookup.idToKey.set(nodeIdentifierToString(identifier), KEY_Z);
            commitTransactionLookup(txLookup);

            // A later operation is handed the committed identifier by the lookup, and
            // never reaches the reservation.
            const laterLookup = makeTransactionIdentifierLookup(committed);
            expect(nodeIdentifierToString(txNodeKeyToId(laterLookup, KEY_Z)))
                .toBe(nodeIdentifierToString(identifier));

            db.releaseIdentifierReservations(new Set([KEY_Z]));
            await db.close();
        } finally {
            cleanup(capabilities.tmpDir);
        }
    });

    test('nodeIdentifierFromString round-trips the identifier a joiner adopts', () => {
        const identifier = nodeIdentifierFromString('3-testfingerprint');
        expect(nodeIdentifierToString(identifier)).toBe('3-testfingerprint');
    });
});
