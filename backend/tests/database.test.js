/**
 * Tests for generators/database module.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { get } = require('../src/generators/database');
const { isDatabase } = require('../src/generators/database/class');
const { 
    isDatabaseError,
    isDatabaseInitializationError,
    isDatabaseQueryError 
} = require('../src/generators/database/errors');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger } = require('./stubs');

/**
 * @typedef {import('../src/generators/database/types').DatabaseCapabilities} DatabaseCapabilities
 */

/**
 * Creates test capabilities with a temporary data directory.
 * @returns {DatabaseCapabilities & { tmpDir: string }}
 */
function getTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'database-test-'));
    
    stubLogger(capabilities);
    
    // Override environment to use temp directory
    capabilities.environment = {
        pathToVolodyslavDataDirectory: jest.fn().mockReturnValue(tmpDir),
    };
    
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
    describe('get()', () => {
        test('creates and returns a database instance', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                expect(isDatabase(db)).toBe(true);
                expect(capabilities.logger.logDebug).toHaveBeenCalledWith(
                    expect.objectContaining({ databasePath: expect.any(String) }),
                    'Database opened'
                );
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('creates database directory in the data directory', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                const expectedPath = path.join(capabilities.tmpDir, 'generators-leveldb');
                
                expect(fs.existsSync(expectedPath)).toBe(true);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('can be called multiple times without errors', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db1 = await get(capabilities);
                await db1.close();
                
                const db2 = await get(capabilities);
                expect(isDatabase(db2)).toBe(true);
                
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
                await expect(get(capabilities)).rejects.toThrow('Failed to create data directory');
                await expect(get(capabilities)).rejects.toThrow(expect.any(Error));
                
                const error = await get(capabilities).catch(e => e);
                expect(isDatabaseInitializationError(error)).toBe(true);
                expect(error.cause.message).toBe('Permission denied');
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Database operations', () => {
        test('put() stores a value', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                await db.put('event:test-id', { 
                    id: 'test-id', 
                    type: 'test-type',
                    description: 'test description'
                });
                
                const result = await db.get('event:test-id');
                expect(result).toBeDefined();
                expect(result.id).toBe('test-id');
                expect(result.type).toBe('test-type');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('get() returns undefined for non-existent key', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                const result = await db.get('event:non-existent');
                expect(result).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('del() removes a value', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Put a value
                await db.put('event:test-id', { id: 'test-id', data: 'test' });
                
                // Verify it exists
                let result = await db.get('event:test-id');
                expect(result).toBeDefined();
                
                // Delete it
                await db.del('event:test-id');
                
                // Verify it's gone
                result = await db.get('event:test-id');
                expect(result).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('keys() returns all keys with prefix', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Put multiple values with event: prefix
                await db.put('event:id1', { id: 'id1' });
                await db.put('event:id2', { id: 'id2' });
                await db.put('modifier:id1:key1', { value: 'val1' });
                
                const keys = await db.keys('event:');
                expect(keys).toHaveLength(2);
                expect(keys).toContain('event:id1');
                expect(keys).toContain('event:id2');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('getAll() returns all values with prefix', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Put multiple values
                await db.put('event:id1', { id: 'id1', type: 'type1' });
                await db.put('event:id2', { id: 'id2', type: 'type2' });
                await db.put('modifier:id1', { key: 'val1' });
                
                const values = await db.getAll('event:');
                expect(values).toHaveLength(2);
                expect(values[0].id).toBe('id1');
                expect(values[1].id).toBe('id2');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('batch() executes multiple operations atomically', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Execute batch operations
                await db.batch([
                    { type: 'put', key: 'event:id1', value: { id: 'id1' } },
                    { type: 'put', key: 'event:id2', value: { id: 'id2' } },
                    { type: 'put', key: 'event:id3', value: { id: 'id3' } },
                ]);
                
                const keys = await db.keys('event:');
                expect(keys).toHaveLength(3);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('batch() can mix put and del operations', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Put initial values
                await db.put('event:id1', { id: 'id1' });
                await db.put('event:id2', { id: 'id2' });
                
                // Batch: add one, delete one
                await db.batch([
                    { type: 'put', key: 'event:id3', value: { id: 'id3' } },
                    { type: 'del', key: 'event:id1' },
                ]);
                
                const val1 = await db.get('event:id1');
                const val2 = await db.get('event:id2');
                const val3 = await db.get('event:id3');
                
                expect(val1).toBeUndefined();
                expect(val2).toBeDefined();
                expect(val3).toBeDefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('stores and retrieves complex objects', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                const complexObj = {
                    id: 'test-id',
                    type: 'event',
                    nested: {
                        array: [1, 2, 3],
                        object: { key: 'value' }
                    },
                    date: '2024-01-01'
                };
                
                await db.put('event:complex', complexObj);
                const result = await db.get('event:complex');
                
                expect(result).toEqual(complexObj);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Error handling', () => {
        test('throws DatabaseQueryError on corrupted JSON', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Directly write invalid JSON using the underlying Level instance
                await db.db.put('bad-key', 'invalid json {');
                
                await expect(
                    db.get('bad-key')
                ).rejects.toThrow();
                
                const error = await db.get('bad-key').catch(e => e);
                expect(isDatabaseQueryError(error)).toBe(true);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('put() throws DatabaseQueryError on failure', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Close the database to cause errors
                await db.close();
                
                await expect(
                    db.put('key', { value: 'data' })
                ).rejects.toThrow();
                
                const error = await db.put('key', { value: 'data' }).catch(e => e);
                expect(isDatabaseQueryError(error)).toBe(true);
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('del() throws DatabaseQueryError on failure', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Close the database to cause errors
                await db.close();
                
                await expect(
                    db.del('key')
                ).rejects.toThrow();
                
                const error = await db.del('key').catch(e => e);
                expect(isDatabaseQueryError(error)).toBe(true);
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Type guards', () => {
        test('isDatabase correctly identifies database instances', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                expect(isDatabase(db)).toBe(true);
                expect(isDatabase({})).toBe(false);
                expect(isDatabase(null)).toBe(false);
                expect(isDatabase(undefined)).toBe(false);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('error type guards work correctly', () => {
            const { DatabaseError, DatabaseInitializationError, DatabaseQueryError } = require('../src/generators/database/errors');
            
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
