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
    isTableCreationError,
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
                expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                    expect.objectContaining({ databasePath: expect.any(String) }),
                    'DatabaseOpened'
                );
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('creates database file in the data directory', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                const expectedPath = path.join(capabilities.tmpDir, 'generators.db');
                
                expect(fs.existsSync(expectedPath)).toBe(true);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('creates events table with correct schema', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Query the schema of events table
                const tableInfo = await db.all('PRAGMA table_info(events)');
                const columnNames = tableInfo.map(col => col.name);
                
                expect(columnNames).toContain('id');
                expect(columnNames).toContain('type');
                expect(columnNames).toContain('input');
                expect(columnNames).toContain('original');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('creates modifiers table with correct schema', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Query the schema of modifiers table
                const tableInfo = await db.all('PRAGMA table_info(modifiers)');
                const columnNames = tableInfo.map(col => col.name);
                
                expect(columnNames).toContain('event_id');
                expect(columnNames).toContain('key');
                expect(columnNames).toContain('value');
                
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
        test('run() executes INSERT queries', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['test-id', 'test-type', '{}', '{}', 'test description', '2024-01-01', '{}', 'test']
                );
                
                const result = await db.get('SELECT * FROM events WHERE id = ?', ['test-id']);
                expect(result).toBeDefined();
                expect(result.id).toBe('test-id');
                expect(result.type).toBe('test-type');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('all() returns multiple rows', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Insert multiple events
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['id1', 'type1', '{}', '{}', 'desc1', '2024-01-01', '{}', 'test']
                );
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['id2', 'type2', '{}', '{}', 'desc2', '2024-01-02', '{}', 'test']
                );
                
                const results = await db.all('SELECT * FROM events ORDER BY id');
                expect(results).toHaveLength(2);
                expect(results[0].id).toBe('id1');
                expect(results[1].id).toBe('id2');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('get() returns single row or undefined', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Test undefined for non-existent row
                const nonExistent = await db.get('SELECT * FROM events WHERE id = ?', ['non-existent']);
                expect(nonExistent).toBeUndefined();
                
                // Insert and retrieve
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['test-id', 'test-type', '{}', '{}', 'desc', '2024-01-01', '{}', 'test']
                );
                
                const result = await db.get('SELECT * FROM events WHERE id = ?', ['test-id']);
                expect(result).toBeDefined();
                expect(result.id).toBe('test-id');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('run() executes UPDATE queries', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Insert
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['test-id', 'type1', '{}', '{}', 'desc1', '2024-01-01', '{}', 'test']
                );
                
                // Update
                await db.run(
                    'UPDATE events SET type = ? WHERE id = ?',
                    ['type2', 'test-id']
                );
                
                const result = await db.get('SELECT * FROM events WHERE id = ?', ['test-id']);
                expect(result.type).toBe('type2');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('run() executes DELETE queries', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Insert
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['test-id', 'test-type', '{}', '{}', 'desc', '2024-01-01', '{}', 'test']
                );
                
                // Verify it exists
                let result = await db.get('SELECT * FROM events WHERE id = ?', ['test-id']);
                expect(result).toBeDefined();
                
                // Delete
                await db.run('DELETE FROM events WHERE id = ?', ['test-id']);
                
                // Verify it's gone
                result = await db.get('SELECT * FROM events WHERE id = ?', ['test-id']);
                expect(result).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('foreign key constraint is enforced', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Try to insert modifier without corresponding event
                await expect(
                    db.run(
                        'INSERT INTO modifiers (event_id, key, value) VALUES (?, ?, ?)',
                        ['non-existent-id', 'key1', 'value1']
                    )
                ).rejects.toThrow();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('cascade delete removes related modifiers', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Insert event
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['event-id', 'test-type', '{}', '{}', 'desc', '2024-01-01', '{}', 'test']
                );
                
                // Insert modifier
                await db.run(
                    'INSERT INTO modifiers (event_id, key, value) VALUES (?, ?, ?)',
                    ['event-id', 'key1', 'value1']
                );
                
                // Verify modifier exists
                let modifier = await db.get('SELECT * FROM modifiers WHERE event_id = ?', ['event-id']);
                expect(modifier).toBeDefined();
                
                // Delete event
                await db.run('DELETE FROM events WHERE id = ?', ['event-id']);
                
                // Verify modifier is also deleted
                modifier = await db.get('SELECT * FROM modifiers WHERE event_id = ?', ['event-id']);
                expect(modifier).toBeUndefined();
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Transactions', () => {
        test('transaction() commits successful operations', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                const result = await db.transaction(async () => {
                    await db.run(
                        'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        ['id1', 'type1', '{}', '{}', 'desc1', '2024-01-01', '{}', 'test']
                    );
                    await db.run(
                        'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        ['id2', 'type2', '{}', '{}', 'desc2', '2024-01-02', '{}', 'test']
                    );
                    return 'success';
                });
                
                expect(result).toBe('success');
                
                const events = await db.all('SELECT * FROM events');
                expect(events).toHaveLength(2);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('transaction() rolls back on error', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                await expect(
                    db.transaction(async () => {
                        await db.run(
                            'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                            ['id1', 'type1', '{}', '{}', 'desc1', '2024-01-01', '{}', 'test']
                        );
                        // This will fail due to duplicate primary key
                        await db.run(
                            'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                            ['id1', 'type2', '{}', '{}', 'desc2', '2024-01-02', '{}', 'test']
                        );
                    })
                ).rejects.toThrow();
                
                // Verify no events were inserted
                const events = await db.all('SELECT * FROM events');
                expect(events).toHaveLength(0);
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });
    });

    describe('Error handling', () => {
        test('throws DatabaseQueryError on invalid SQL', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                await expect(
                    db.run('INVALID SQL STATEMENT')
                ).rejects.toThrow();
                
                const error = await db.run('INVALID SQL STATEMENT').catch(e => e);
                expect(isDatabaseQueryError(error)).toBe(true);
                expect(error.query).toBe('INVALID SQL STATEMENT');
                
                await db.close();
            } finally {
                cleanup(capabilities.tmpDir);
            }
        });

        test('throws DatabaseQueryError on constraint violation', async () => {
            const capabilities = getTestCapabilities();
            try {
                const db = await get(capabilities);
                
                // Insert first event
                await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['duplicate-id', 'type1', '{}', '{}', 'desc1', '2024-01-01', '{}', 'test']
                );
                
                // Try to insert with same ID
                await expect(
                    db.run(
                        'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                        ['duplicate-id', 'type2', '{}', '{}', 'desc2', '2024-01-02', '{}', 'test']
                    )
                ).rejects.toThrow();
                
                const error = await db.run(
                    'INSERT INTO events (id, type, input, original, description, date, modifiers, creator) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
                    ['duplicate-id', 'type2', '{}', '{}', 'desc2', '2024-01-02', '{}', 'test']
                ).catch(e => e);
                expect(isDatabaseQueryError(error)).toBe(true);
                
                await db.close();
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
            const { DatabaseError, DatabaseInitializationError, TableCreationError, DatabaseQueryError } = require('../src/generators/database/errors');
            
            const dbError = new DatabaseError('test', '/path/db');
            const initError = new DatabaseInitializationError('test', '/path/db');
            const tableError = new TableCreationError('test', '/path/db', 'events');
            const queryError = new DatabaseQueryError('test', '/path/db', 'SELECT *');
            
            expect(isDatabaseError(dbError)).toBe(true);
            expect(isDatabaseInitializationError(initError)).toBe(true);
            expect(isTableCreationError(tableError)).toBe(true);
            expect(isDatabaseQueryError(queryError)).toBe(true);
            
            expect(isDatabaseError({})).toBe(false);
            expect(isDatabaseInitializationError(dbError)).toBe(false);
        });
    });
});
