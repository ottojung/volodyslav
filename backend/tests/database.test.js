/**
 * Tests for generators/database module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    getRootDatabase,
    isRootDatabase,
    LIVE_DATABASE_WORKING_PATH,
    isDatabaseInitializationError,
    isInvalidReplicaPointerError,
    isSchemaBatchVersionError,
    versionToString,
} = require('../src/generators/incremental_graph/database');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

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

const Y_GLOBAL_VERSION_RAW_KEY = '!y!!global!version';


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
                const expectedPath = path.join(dataDir, LIVE_DATABASE_WORKING_PATH);
                
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



        test('has no stored version in a fresh database', async () => {
            const capabilities = getTestCapabilities();
            try {
                // Open a fresh database and verify that no meta version has been stored yet.
                const db = await getRootDatabase(capabilities);
                try {
                    // A fresh database has no stored version.
                    const version = await db.getGlobalVersion();
                    expect(version).toBeUndefined();
                } finally {
                    await db.close();
                }
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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
                const storage = db.getSchemaStorage();
                
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

    describe('Schema isolation', () => {
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

        test('getGlobalVersion returns undefined on a fresh database', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                
                const version = await db.getGlobalVersion();
                expect(version).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('schemaStorageForReplica returns independent storages for x and y', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const xStorage = db.schemaStorageForReplica('x');
                const yStorage = db.schemaStorageForReplica('y');

                await xStorage.values.put('key', { type: 'all_events', events: [] });
                const fromX = await xStorage.values.get('key');
                const fromY = await yStorage.values.get('key');

                expect(fromX).toBeDefined();
                expect(fromY).toBeUndefined();

                await db.close();
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

        test('error type guards work correctly', async () => {
            const capabilities = getTestCapabilities();

            // Generate a DatabaseInitializationError by mocking creator to fail.
            capabilities.creator.createDirectory = jest.fn().mockRejectedValue(
                new Error('Permission denied')
            );

            const error = await getRootDatabase(capabilities).catch(e => e);
            expect(isDatabaseInitializationError(error)).toBe(true);

            expect(isDatabaseInitializationError({})).toBe(false);
            expect(isDatabaseInitializationError(null)).toBe(false);

            cleanup(capabilities.tmpDir);
        });
    });

    describe('Replica pointer (`_meta/current_replica`)', () => {
        test('fresh database initializes current_replica to "x"', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                expect(db.currentReplicaName()).toBe('x');
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('database missing current_replica defaults to x on open', async () => {
            const capabilities = getTestCapabilities();
            try {
                // Deliberately omit current_replica.
                const rawDb = capabilities.levelDatabase.initialize(
                    path.join(capabilities.environment.workingDirectory(), LIVE_DATABASE_WORKING_PATH)
                );
                await rawDb.open();
                // Deliberately omit `current_replica`.
                await rawDb.close();

                const db = await getRootDatabase(capabilities);
                expect(db.currentReplicaName()).toBe('x');
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('invalid current_replica value throws when opening database', async () => {
            const capabilities = getTestCapabilities();
            try {
                // Write a bad current_replica value.
                const rawDb = capabilities.levelDatabase.initialize(
                    path.join(capabilities.environment.workingDirectory(), LIVE_DATABASE_WORKING_PATH)
                );
                await rawDb.open();
                const meta = rawDb.sublevel('_meta', { valueEncoding: 'json' });
                                await meta.put('current_replica', 'z');
                await rawDb.close();

                // getRootDatabase wraps errors in DatabaseInitializationError.
                const error = await getRootDatabase(capabilities).catch(e => e);
                expect(isDatabaseInitializationError(error)).toBe(true);
                expect(isInvalidReplicaPointerError(error.cause)).toBe(true);
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('switchToReplica changes the active replica and persists across reopen', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                expect(db.currentReplicaName()).toBe('x');
                await db.switchToReplica('y');
                expect(db.currentReplicaName()).toBe('y');
                await db.close();

                // Reopen — pointer should be 'y'.
                const db2 = await getRootDatabase(capabilities);
                expect(db2.currentReplicaName()).toBe('y');
                await db2.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('schemaStorageForReplica throws InvalidReplicaPointerError for invalid name', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                let err;
                // @ts-expect-error — intentionally passing an invalid value to test runtime guard
                try { db.schemaStorageForReplica('z'); } catch (e) { err = e; }
                expect(isInvalidReplicaPointerError(err)).toBe(true);
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('clearReplicaStorage resets global/version init', () => {
        test('batch() re-initialises global/version in target replica after clearReplicaStorage', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);

                // Write a value into the y replica (sets global/version on first batch).
                let yStorage = db.schemaStorageForReplica('y');
                await yStorage.batch([
                    yStorage.freshness.putOp('nodeA', 'up-to-date'),
                ]);

                // Verify global/version was initialised in y.
                const xMetaVersion = await db.getGlobalVersion();
                expect(xMetaVersion).toBeUndefined(); // x has no version yet

                // Now clear y — the schema storage for y is rebuilt with a fresh closure.
                await db.clearReplicaStorage('y');

                // Re-fetch the storage reference after the clear (the old reference is stale).
                yStorage = db.schemaStorageForReplica('y');

                // A fresh batch to y must succeed (re-initialises global/version).
                await yStorage.batch([
                    yStorage.freshness.putOp('nodeB', 'potentially-outdated'),
                ]);

                // Verify nodeA is gone (clear was effective) but nodeB is present.
                const nodeA = await yStorage.freshness.get('nodeA');
                const nodeB = await yStorage.freshness.get('nodeB');
                expect(nodeA).toBeUndefined();
                expect(nodeB).toBe('potentially-outdated');

                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('isSchemaBatchVersionError identifies version-mismatch errors', async () => {
            expect(isSchemaBatchVersionError({})).toBe(false);
            expect(isSchemaBatchVersionError(null)).toBe(false);
            expect(isSchemaBatchVersionError(new Error('other'))).toBe(false);

            const capabilities = getTestCapabilities();
            try {
                const db = await getRootDatabase(capabilities);
                const yStorage = db.schemaStorageForReplica('y');
                await db._rawPut(Y_GLOBAL_VERSION_RAW_KEY, `${versionToString(db.version)}-mismatch`);

                /** @type {unknown} */
                let thrownError;
                try {
                    await yStorage.batch([
                        yStorage.freshness.putOp('nodeA', 'up-to-date'),
                    ]);
                } catch (error) {
                    thrownError = error;
                }

                expect(isSchemaBatchVersionError(thrownError)).toBe(true);
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });
});
