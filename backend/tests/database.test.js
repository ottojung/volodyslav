/**
 * Tests for generators/database module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { getRootDatabase, isRootDatabase } = require('../src/generators/incremental_graph/database');
const { 
    isDatabaseError,
    isDatabaseInitializationError,
    isDatabaseQueryError 
} = require('../src/generators/incremental_graph/database/errors');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');
const { DatabaseError, DatabaseInitializationError, DatabaseQueryError } = require('../src/generators/incremental_graph/database/errors');

/**
 * @typedef {import('../src/generators/incremental_graph/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-test-'));
    
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { ...capabilities, tmpDir };
}

/**
 * Cleanup function to remove temporary directories.
 * @param {string} tmpDir
 */
function cleanup(tmpDir) {
    if (fs.existsSync(tmpDir)) {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
}


describe('generators/database', () => {
    describe('getRootDatabase()', () => {
        test('creates and returns a root database instance', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                expect(isRootDatabase(db)).toBe(true);
                expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                    expect.objectContaining({ databasePath: expect.any(String) }),
                    'Root database opened'
                );
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('creates database directory in the data directory', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const dataDir = capabilities.environment.workingDirectory();
                const expectedPath = path.join(dataDir, 'generators-leveldb');
                
                expect(fs.existsSync(expectedPath)).toBe(true);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('can be called multiple times without errors', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db1 = await getRootDatabase(capabilities);
                await db1.close();
                
                const db2 = await getRootDatabase(capabilities);
                expect(isRootDatabase(db2)).toBe(true);
                
                await db2.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('throws DatabaseInitializationError when directory cannot be created', async () => {
            const capabilities = getTestCapabilities();
            
            // Mock creator to fail
            capabilities.creator.createDirectory = jest.fn().mockRejectedValue(
                new Error('Permission denied')
            );
            
            try {
                await expect(getRootDatabase(capabilities)).rejects.toThrow('Failed to create data directory');
                await expect(getRootDatabase(capabilities)).rejects.toThrow(expect.any(Error));
                
                const error = await getRootDatabase(capabilities).catch(e => e);
                expect(isDatabaseInitializationError(error)).toBe(true);
                expect(error.cause.message).toBe('Permission denied');
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Schema storage operations', () => {
        test('put() and get() work through schema storage', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                await storage.values.put('test-key', { 
                    value: {
                        id: 'test-id', 
                        type: 'test-type',
                        description: 'test description'
                    },
                    isDirty: false
                });
                
                const result = await storage.values.get('test-key');
                expect(result).toBeDefined();
                expect(result.value.id).toBe('test-id');
                expect(result.value.type).toBe('test-type');
                expect(result.isDirty).toBe(false);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('get() returns undefined for non-existent key', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                const result = await storage.values.get('non-existent');
                expect(result).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('del() removes a value', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                // Put a value
                await storage.values.put('test-key', { value: { id: 'test-id', data: 'test' }, isDirty: false });
                
                // Verify it exists
                let result = await storage.values.get('test-key');
                expect(result).toBeDefined();
                
                // Delete it
                await storage.values.del('test-key');
                
                // Verify it's gone
                result = await storage.values.get('test-key');
                expect(result).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('keys() returns all keys', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                // Put multiple values
                await storage.values.put('id1', { value: { id: 'id1' }, isDirty: false });
                await storage.values.put('id2', { value: { id: 'id2' }, isDirty: false });
                
                const keys = [];
                for await (const key of storage.values.keys()) {
                    keys.push(key);
                }
                
                expect(keys).toHaveLength(2);
                expect(keys).toContain('id1');
                expect(keys).toContain('id2');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('batch() executes multiple operations atomically', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                // Execute batch operations
                await storage.batch([
                    storage.values.putOp('id1', { value: { id: 'id1' }, isDirty: false }),
                    storage.values.putOp('id2', { value: { id: 'id2' }, isDirty: false }),
                    storage.values.putOp('id3', { value: { id: 'id3' }, isDirty: false }),
                ]);
                
                const keys = [];
                for await (const key of storage.values.keys()) {
                    keys.push(key);
                }
                expect(keys).toHaveLength(3);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('batch() can mix put and del operations', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                // Put initial values
                await storage.values.put('id1', { value: { id: 'id1' }, isDirty: false });
                await storage.values.put('id2', { value: { id: 'id2' }, isDirty: false });
                
                // Batch: add one, delete one
                await storage.batch([
                    storage.values.putOp('id3', { value: { id: 'id3' }, isDirty: true }),
                    storage.values.delOp('id1'),
                ]);
                
                const val1 = await storage.values.get('id1');
                const val2 = await storage.values.get('id2');
                const val3 = await storage.values.get('id3');
                
                expect(val1).toBeUndefined();
                expect(val2).toBeDefined();
                expect(val2.value.id).toBe('id2');
                expect(val3).toBeDefined();
                expect(val3.value.id).toBe('id3');
                expect(val3.isDirty).toBe(true);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('stores and retrieves complex objects', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                const complexObj = {
                    id: 'test-id',
                    type: 'event',
                    nested: {
                        array: [1, 2, 3],
                        object: { key: 'value' }
                    },
                    date: '2024-01-01'
                };
                
                const entry = { value: complexObj, isDirty: false };
                await storage.values.put('complex', entry);
                const result = await storage.values.get('complex');
                
                expect(result).toEqual(entry);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('freshness storage works independently', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                await storage.freshness.put('node1', 'up-to-date');
                await storage.freshness.put('node2', 'potentially-outdated');
                
                const f1 = await storage.freshness.get('node1');
                const f2 = await storage.freshness.get('node2');
                
                expect(f1).toBe('up-to-date');
                expect(f2).toBe('potentially-outdated');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('inputs storage works independently', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                await storage.inputs.put('node1', { inputs: ['dep1', 'dep2'] });
                
                const inputs = await storage.inputs.get('node1');
                
                expect(inputs).toEqual({ inputs: ['dep1', 'dep2'] });
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('revdeps storage works independently', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const storage = db.getSchemaStorage('test-schema');
                
                // Store dependents as arrays
                await storage.revdeps.put('dep1', ['node1', 'node2']);
                
                // Retrieve dependents array
                const dependents = await storage.revdeps.get('dep1');
                
                expect(dependents).toEqual(['node1', 'node2']);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Slot-based storage', () => {
        test('getSchemaStorage returns storage', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                const storage = db.getSchemaStorage();
                
                await storage.values.put('key', { value: { data: 'test' }, isDirty: false });
                
                const val = await storage.values.get('key');
                
                expect(val.value.data).toBe('test');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('getStoredVersion returns undefined for a new database', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                const storedVersion = await db.getStoredVersion();
                expect(storedVersion).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('swapSlots changes activeSlot and records version in meta', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                const slotBefore = db.activeSlot;
                await db.swapSlots();
                const slotAfter = db.activeSlot;
                
                // Active slot should have changed.
                expect(slotAfter).not.toBe(slotBefore);
                
                // The new active slot should have the current version stored.
                const storedVersion = await db.getStoredVersion();
                expect(storedVersion).toBe(db.version);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('swapSlots twice returns to the original slot', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                const slotBefore = db.activeSlot;
                await db.swapSlots();
                await db.swapSlots();
                const slotAfter = db.activeSlot;
                
                expect(slotAfter).toBe(slotBefore);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('clearInactiveSlot empties the inactive slot', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                // Write data to the inactive slot.
                const inactive = db.getInactiveSlotStorage();
                await inactive.values.put('testkey', { type: 'all_events', events: [] });
                
                // Verify data exists.
                const before = await inactive.values.get('testkey');
                expect(before).toBeDefined();
                
                // Clear the inactive slot.
                await db.clearInactiveSlot();
                
                // Verify data is gone.
                const after = await inactive.values.get('testkey');
                expect(after).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('activeSlot and stored version survive a database close and reopen', async () => {
            const capabilities = getTestCapabilities();
            try {
                // Open DB, swap slots (which writes version + activeSlot).
                const db1 = await getRootDatabase(capabilities);
                await db1.swapSlots();
                const slot1 = db1.activeSlot;
                await db1.close();
                
                // Reopen; the stored state should be preserved.
                const db2 = await getRootDatabase(capabilities);
                expect(db2.activeSlot).toBe(slot1);
                const storedVersion = await db2.getStoredVersion();
                expect(storedVersion).toBe(db2.version);
                
                await db2.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Legacy import', () => {
        test('imports last legacy schema into slot x on first open', async () => {
            const { Level } = require('level');
            const capabilities = getTestCapabilities();
            try {
                const dataDir = capabilities.environment.workingDirectory();
                const dbPath = path.join(dataDir, 'generators-leveldb');
                fs.mkdirSync(dataDir, { recursive: true });

                // Create legacy layout: schemas sublevel + versioned data namespace.
                const legacyVersion = 'legacy-1.0';
                const rawDb = new Level(dbPath, { valueEncoding: 'json' });
                await rawDb.open();

                // Write to the legacy "schemas" registry.
                const schemasLevel = rawDb.sublevel('schemas', { valueEncoding: 'json' });
                await schemasLevel.put(legacyVersion, 0);

                // Write some data into the legacy version namespace.
                const versionLevel = rawDb.sublevel(legacyVersion, { valueEncoding: 'json' });
                const valuesLevel = versionLevel.sublevel('values', { valueEncoding: 'json' });
                await valuesLevel.put('migrated-key', { type: 'all_events', events: [] });
                const inputsLevel = versionLevel.sublevel('inputs', { valueEncoding: 'json' });
                await inputsLevel.put('migrated-key', { inputs: [], inputCounters: [] });

                await rawDb.close();

                // Now open via getRootDatabase — the legacy import should run.
                const db = await getRootDatabase(capabilities);

                // The active slot should be "x" (legacy import target).
                expect(db.activeSlot).toBe('x');

                // The legacy data should be in slot x's values.
                const activeStorage = db.getActiveSlotStorage();
                const importedValue = await activeStorage.values.get('migrated-key');
                expect(importedValue).toEqual({ type: 'all_events', events: [] });

                // The stored version in slot x's meta should be the legacy version.
                const storedVersion = await db.getStoredVersion();
                expect(storedVersion).toBe(legacyVersion);

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('skips legacy import if top-level meta already has activeSlot', async () => {
            const capabilities = getTestCapabilities();
            try {
                // Open the database once (which will write activeSlot to meta on swapSlots).
                const db1 = await getRootDatabase(capabilities);
                await db1.swapSlots(); // writes activeSlot + version to meta
                const slot1 = db1.activeSlot;
                await db1.close();

                // Now create a fake "legacy" schemas sublevel (should be ignored on reopen).
                const { Level } = require('level');
                const dataDir = capabilities.environment.workingDirectory();
                const dbPath = path.join(dataDir, 'generators-leveldb');
                const rawDb = new Level(dbPath, { valueEncoding: 'json' });
                await rawDb.open();
                const schemasLevel = rawDb.sublevel('schemas', { valueEncoding: 'json' });
                await schemasLevel.put('should-be-ignored', 0);
                await rawDb.close();

                // Reopen: the activeSlot from meta should take precedence.
                const db2 = await getRootDatabase(capabilities);
                expect(db2.activeSlot).toBe(slot1);

                await db2.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Type guards', () => {
        test('isRootDatabase correctly identifies database instances', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                expect(isRootDatabase(db)).toBe(true);
                expect(isRootDatabase({})).toBe(false);
                expect(isRootDatabase(null)).toBe(false);
                expect(isRootDatabase(undefined)).toBe(false);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('error type guards work correctly', () => {
            
            const dbError = new DatabaseError('test', '/path/db');
            const initError = new DatabaseInitializationError('test', '/path/db');
            const queryError = new DatabaseQueryError('test', '/path/db', 'PUT key');
            
            expect(isDatabaseError(dbError)).toBe(true);
            expect(isDatabaseInitializationError(initError)).toBe(true);
            expect(isDatabaseQueryError(queryError)).toBe(true);
            
            expect(isDatabaseError({})).toBe(false);
            expect(isDatabaseInitializationError(dbError)).toBe(false);
        });
    });
});
