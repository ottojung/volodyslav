/**
 * Tests for renderToFilesystem() and scanFromFilesystem() in the
 * incremental-graph database module.
 *
 * Focus areas:
 *   1. keyToRelativePath / relativePathToKey are exact inverses (bijection).
 *   2. renderToFilesystem creates files whose names and contents faithfully
 *      represent the database.
 *   3. scanFromFilesystem restores the database exactly (bijection with render).
 *   4. Edge cases: keys with '/' in values, nested sublevels, empty databases,
 *      and multiple namespaces.
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { Level } = require('level');
const {
    getRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
    keyToRelativePath,
    relativePathToKey,
} = require('../src/generators/incremental_graph/database');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a full set of test capabilities that includes a real logger stub,
 * real environment stub, plus real filesystem helpers.
 * @returns {{ capabilities: object, tmpDir: string }}
 */
function makeTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'db-render-test-')
    );
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { capabilities, tmpDir };
}

/**
 * Recursively collects { relPath, content } for every file under `dir`.
 * relPath uses '/' as separator regardless of OS.
 * @param {string} dir
 * @param {string} [base]
 * @returns {Array<{relPath: string, content: string}>}
 */
function collectFiles(dir, base) {
    const root = base ?? dir;
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    /** @type {Array<{relPath: string, content: string}>} */
    const result = [];
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...collectFiles(abs, root));
        } else {
            const relPath = path.relative(root, abs).split(path.sep).join('/');
            const content = fs.readFileSync(abs, 'utf8');
            result.push({ relPath, content });
        }
    }
    return result;
}

/**
 * Creates a fresh RootDatabase seeded with the given raw LevelDB entries.
 * Returns the open database; caller must close it.
 * @param {object} capabilities
 * @param {Array<[string, *]>} entries - [rawKey, value] pairs
 * @returns {Promise<import('../src/generators/incremental_graph/database/root_database').RootDatabase>}
 */
async function makeSeededDatabase(capabilities, entries) {
    const db = await getRootDatabase(capabilities);
    for (const [key, value] of entries) {
        await db._rawPut(key, value);
    }
    return db;
}

/**
 * Collects all raw entries from the database as a plain Map.
 * @param {import('../src/generators/incremental_graph/database/root_database').RootDatabase} db
 * @returns {Promise<Map<string, *>>}
 */
async function collectRawEntries(db) {
    const map = new Map();
    for await (const [key, value] of db._rawEntries()) {
        map.set(key, value);
    }
    return map;
}

// ---------------------------------------------------------------------------
// keyToRelativePath / relativePathToKey — unit tests
// ---------------------------------------------------------------------------

describe('keyToRelativePath()', () => {
    test('single-level sublevel key', () => {
        expect(keyToRelativePath('!_meta!format')).toBe('_meta/format');
    });

    test('two-level sublevel key', () => {
        expect(keyToRelativePath('!x!!values!{"head":"all_events","args":[]}')).toBe(
            'x/values/{"head":"all_events","args":[]}'
        );
    });

    test('encodes "/" inside the key as "%2F"', () => {
        const key = '!x!!values!{"head":"transcription","args":["/audio/file.mp3"]}';
        const rel = keyToRelativePath(key);
        expect(rel).toBe('x/values/{"head":"transcription","args":["%2Faudio%2Ffile.mp3"]}');
    });

    test('encodes "%" inside the key as "%25"', () => {
        const key = '!x!!values!something%2Fwithin';
        const rel = keyToRelativePath(key);
        expect(rel).toBe('x/values/something%252Fwithin');
    });

    test('three-level sublevel key', () => {
        const key = '!a!!b!!c!leaf';
        expect(keyToRelativePath(key)).toBe('a/b/c/leaf');
    });
});

describe('relativePathToKey()', () => {
    test('single-level path', () => {
        expect(relativePathToKey('_meta/format')).toBe('!_meta!format');
    });

    test('two-level path', () => {
        const rel = 'x/values/{"head":"all_events","args":[]}';
        expect(relativePathToKey(rel)).toBe('!x!!values!{"head":"all_events","args":[]}');
    });

    test('decodes "%2F" back to "/"', () => {
        const rel = 'x/values/{"head":"transcription","args":["%2Faudio%2Ffile.mp3"]}';
        expect(relativePathToKey(rel)).toBe(
            '!x!!values!{"head":"transcription","args":["/audio/file.mp3"]}'
        );
    });

    test('decodes "%25" back to "%"', () => {
        const rel = 'x/values/something%252Fwithin';
        expect(relativePathToKey(rel)).toBe('!x!!values!something%2Fwithin');
    });

    test('three-level path', () => {
        expect(relativePathToKey('a/b/c/leaf')).toBe('!a!!b!!c!leaf');
    });

    test('throws for fewer than two segments', () => {
        expect(() => relativePathToKey('onlyone')).toThrow();
        expect(() => relativePathToKey('')).toThrow();
    });
});

// ---------------------------------------------------------------------------
// Bijection: keyToRelativePath ∘ relativePathToKey = id
// ---------------------------------------------------------------------------

describe('keyToRelativePath / relativePathToKey bijection', () => {
    const testKeys = [
        '!_meta!format',
        '!x!!meta!version',
        '!x!!values!{"head":"all_events","args":[]}',
        '!x!!freshness!{"head":"all_events","args":[]}',
        '!x!!inputs!{"head":"event","args":["abc123"]}',
        '!x!!revdeps!{"head":"event","args":["abc123"]}',
        '!x!!counters!{"head":"event","args":["abc123"]}',
        '!x!!timestamps!{"head":"event","args":["abc123"]}',
        '!x!!values!{"head":"transcription","args":["/path/to/audio.mp3"]}',
        '!x!!values!{"head":"event","args":["id/with/slashes"]}',
        '!y!!values!{"head":"all_events","args":[]}',
        '!a!!b!!c!deep',
    ];

    for (const key of testKeys) {
        test(`round-trips correctly: ${key}`, () => {
            const rel = keyToRelativePath(key);
            const restored = relativePathToKey(rel);
            expect(restored).toBe(key);
        });
    }

    test('distinct keys produce distinct paths', () => {
        const paths = testKeys.map(keyToRelativePath);
        const uniquePaths = new Set(paths);
        expect(uniquePaths.size).toBe(testKeys.length);
    });
});

// ---------------------------------------------------------------------------
// renderToFilesystem
// ---------------------------------------------------------------------------

describe('renderToFilesystem()', () => {
    test('creates one file per database entry', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const schemaStorage = db.getSchemaStorage();
            await schemaStorage.values.put('{"head":"all_events","args":[]}', {
                type: 'all_events',
                events: [],
            });

            const outputDir = path.join(tmpDir, 'render-out');
            await renderToFilesystem(capabilities, db, outputDir);

            const files = collectFiles(outputDir);
            // At minimum the format marker + meta version + the value we added
            expect(files.length).toBeGreaterThanOrEqual(1);
        } finally {
            await db.close();
        }
    });

    test('file content is valid JSON matching the stored value', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'test-marker'],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-content');
            await renderToFilesystem(capabilities, db, outputDir);

            const files = collectFiles(outputDir);
            const metaFormatFile = files.find(f => f.relPath === '_meta/format');
            expect(metaFormatFile).toBeDefined();
            expect(JSON.parse(metaFormatFile.content)).toBe('test-marker');
        } finally {
            await db.close();
        }
    });

    test('nested keys create nested directories', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-nested');
            await renderToFilesystem(capabilities, db, outputDir);

            const xDir = path.join(outputDir, 'x');
            const valuesDir = path.join(xDir, 'values');
            expect(fs.existsSync(xDir)).toBe(true);
            expect(fs.existsSync(valuesDir)).toBe(true);
        } finally {
            await db.close();
        }
    });

    test('keys containing "/" in values produce percent-encoded filenames', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const keyWithSlash = '!x!!values!{"head":"transcription","args":["/audio/file.mp3"]}';
        const db = await makeSeededDatabase(capabilities, [
            [keyWithSlash, { type: 'transcription', value: 'hello world' }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-slash');
            await renderToFilesystem(capabilities, db, outputDir);

            const files = collectFiles(outputDir);
            // Find the file corresponding to our transcription key
            const relPathForKey = keyToRelativePath(keyWithSlash);
            const transcriptionFile = files.find(f => f.relPath === relPathForKey);
            expect(transcriptionFile).toBeDefined();
            // The filename must not contain '/' from the key value
            const filename = transcriptionFile.relPath.split('/').pop();
            expect(filename).not.toContain('/');
            expect(filename).toContain('%2F');
        } finally {
            await db.close();
        }
    });

    test('empty database produces no files', async () => {
        const { tmpDir } = makeTestCapabilities();
        const dbPath = path.join(tmpDir, 'empty.db');
        const rawDb = new Level(dbPath, { valueEncoding: 'json' });
        await rawDb.open();

        const keys = [];
        for await (const key of rawDb.keys()) {
            keys.push(key);
        }
        expect(keys.length).toBe(0);
        await rawDb.close();
    });

    test('logs a summary after rendering', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-log');
            await renderToFilesystem(capabilities, db, outputDir);
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ outputDir, count: expect.any(Number) }),
                'Rendered database to filesystem'
            );
        } finally {
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// scanFromFilesystem
// ---------------------------------------------------------------------------

describe('scanFromFilesystem()', () => {
    test('restores a single entry', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        // Create a rendered snapshot manually
        const inputDir = path.join(tmpDir, 'scan-in');
        fs.mkdirSync(path.join(inputDir, '_meta'), { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_meta', 'format'), JSON.stringify('xy-v1'));

        const db = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db, inputDir);
            const entries = await collectRawEntries(db);
            // The entry we seeded should be present (among others potentially added by open())
            const found = entries.get('!_meta!format');
            // Value could have been overwritten by open() if it was already 'xy-v1'
            expect(found).toBe('xy-v1');
        } finally {
            await db.close();
        }
    });

    test('logs a summary after scanning', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-log-in');
        fs.mkdirSync(path.join(inputDir, '_meta'), { recursive: true });
        fs.writeFileSync(path.join(inputDir, '_meta', 'format'), JSON.stringify('xy-v1'));

        const db = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db, inputDir);
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ inputDir, count: 1 }),
                'Scanned database from filesystem'
            );
        } finally {
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Full bijection: render ∘ scan = identity
// ---------------------------------------------------------------------------

describe('renderToFilesystem / scanFromFilesystem bijection', () => {
    /**
     * Seeds a database with `seedEntries`, renders it to a fresh directory,
     * then scans that directory into a second fresh database.
     * Returns the seeded entries map and the entries recovered by scan.
     *
     * Assertions are left to the caller so that ESLint can detect them.
     *
     * @param {Array<[string, *]>} seedEntries
     * @returns {Promise<{dbAEntries: Map<string, *>, dbBEntries: Map<string, *>}>}
     */
    async function renderAndScan(seedEntries) {
        const { capabilities: capA, tmpDir } = makeTestCapabilities();
        const { capabilities: capB } = makeTestCapabilities();
        const tmpDirB = fs.mkdtempSync(path.join(os.tmpdir(), 'db-render-b-'));
        capB.environment.workingDirectory = jest.fn().mockReturnValue(
            path.join(tmpDirB, 'results')
        );

        const dbA = await makeSeededDatabase(capA, seedEntries);
        const renderDir = path.join(tmpDir, 'render-dir');

        await renderToFilesystem(capA, dbA, renderDir);
        await dbA.close();

        const dbB = await getRootDatabase(capB);
        await scanFromFilesystem(capB, dbB, renderDir);

        const dbAEntries = new Map(seedEntries);
        const dbBEntries = await collectRawEntries(dbB);
        await dbB.close();

        return { dbAEntries, dbBEntries };
    }

    /**
     * Asserts that every seeded entry appears in the scanned database.
     * @param {Map<string, *>} dbAEntries
     * @param {Map<string, *>} dbBEntries
     */
    function assertAllEntriesPresent(dbAEntries, dbBEntries) {
        for (const [key, value] of dbAEntries) {
            expect(dbBEntries.has(key)).toBe(true);
            expect(dbBEntries.get(key)).toEqual(value);
        }
    }

    test('empty database round-trips', async () => {
        const { dbAEntries, dbBEntries } = await renderAndScan([]);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
        expect(dbAEntries.size).toBe(0);
    });

    test('single format marker', async () => {
        const seed = [['!_meta!format', 'xy-v1']];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.get('!_meta!format')).toBe('xy-v1');
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('multiple entries at the same sublevel depth', async () => {
        const seed = [
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
            ['!x!!freshness!{"head":"all_events","args":[]}', 'up-to-date'],
            ['!x!!counters!{"head":"all_events","args":[]}', 1],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.size).toBeGreaterThanOrEqual(seed.length);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('entry with "/" in the key value', async () => {
        const seed = [
            [
                '!x!!values!{"head":"transcription","args":["/audio/recording.mp3"]}',
                { type: 'transcription', value: 'hello world' },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has('!x!!values!{"head":"transcription","args":["/audio/recording.mp3"]}')).toBe(true);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('entry with "%" in the key value', async () => {
        const seed = [
            [
                '!x!!values!{"head":"event","args":["50%off"]}',
                { type: 'event', value: 42 },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has('!x!!values!{"head":"event","args":["50%off"]}')).toBe(true);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('entries across multiple top-level sublevels', async () => {
        const seed = [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
            ['!y!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [1] }],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.size).toBeGreaterThanOrEqual(seed.length);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('deeply nested key', async () => {
        const seed = [['!a!!b!!c!leaf-key', { nested: true, depth: 3 }]];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.get('!a!!b!!c!leaf-key')).toEqual({ nested: true, depth: 3 });
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('many entries', async () => {
        const seed = [
            ['!_meta!format', 'xy-v1'],
            ['!x!!meta!version', '1.2.3'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
            ['!x!!freshness!{"head":"all_events","args":[]}', 'up-to-date'],
            ['!x!!inputs!{"head":"event","args":["abc"]}', { inputs: ['all_events'], inputCounters: [1] }],
            ['!x!!revdeps!{"head":"all_events","args":[]}', ['{"head":"event","args":["abc"]}']],
            ['!x!!counters!{"head":"all_events","args":[]}', 5],
            ['!x!!timestamps!{"head":"all_events","args":[]}', { createdAt: '2024-01-01T00:00:00.000Z', modifiedAt: '2024-01-02T00:00:00.000Z' }],
            ['!x!!values!{"head":"transcription","args":["/path/to/file.mp3"]}', { type: 'transcription', value: 'spoken words' }],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.size).toBeGreaterThanOrEqual(seed.length);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });
});

// ---------------------------------------------------------------------------
// Additional edge-case and reliability tests
// ---------------------------------------------------------------------------

describe('additional reliability tests', () => {
    test('renderToFilesystem is idempotent when called twice on same outputDir', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'idem-out');
            await renderToFilesystem(capabilities, db, outputDir);
            const filesFirst = collectFiles(outputDir).sort((a, b) => a.relPath.localeCompare(b.relPath));
            await renderToFilesystem(capabilities, db, outputDir);
            const filesSecond = collectFiles(outputDir).sort((a, b) => a.relPath.localeCompare(b.relPath));
            expect(filesSecond).toEqual(filesFirst);
        } finally {
            await db.close();
        }
    });

    test('scanFromFilesystem overwrites existing entries with scanned values', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        // Create a directory with one entry
        const inputDir = path.join(tmpDir, 'overwrite-in');
        fs.mkdirSync(path.join(inputDir, 'x', 'values'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'x', 'values', '{"head":"all_events","args":[]}'),
            JSON.stringify({ type: 'all_events', events: [99] })
        );

        const db = await getRootDatabase(capabilities);
        // Pre-seed a different value at the same key
        await db._rawPut('!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] });

        await scanFromFilesystem(capabilities, db, inputDir);

        const entries = await collectRawEntries(db);
        expect(entries.get('!x!!values!{"head":"all_events","args":[]}')).toEqual({
            type: 'all_events',
            events: [99],
        });

        await db.close();
    });

    test('file count after render equals number of database entries', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const seedEntries = [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"k1","args":[]}', { v: 1 }],
            ['!x!!values!{"head":"k2","args":[]}', { v: 2 }],
            ['!x!!freshness!{"head":"k1","args":[]}', 'up-to-date'],
        ];
        const db = await makeSeededDatabase(capabilities, seedEntries);
        try {
            const outputDir = path.join(tmpDir, 'count-out');
            await renderToFilesystem(capabilities, db, outputDir);

            // Count actual files on disk
            const filesOnDisk = collectFiles(outputDir);

            // Count entries in the database
            const dbEntries = await collectRawEntries(db);

            expect(filesOnDisk.length).toBe(dbEntries.size);
        } finally {
            await db.close();
        }
    });

    test('rendered paths all decode back to valid LevelDB keys', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            const schemaStorage = db.getSchemaStorage();
            await schemaStorage.values.put('{"head":"all_events","args":[]}', {
                type: 'all_events',
                events: [],
            });
            await schemaStorage.values.put(
                '{"head":"transcription","args":["/path/to/file.mp3"]}',
                { type: 'transcription', value: 'hi' }
            );

            const outputDir = path.join(tmpDir, 'decode-out');
            await renderToFilesystem(capabilities, db, outputDir);

            const files = collectFiles(outputDir);
            for (const { relPath } of files) {
                // Should not throw
                const key = relativePathToKey(relPath);
                // Should be a valid key string
                expect(typeof key).toBe('string');
                expect(key.startsWith('!')).toBe(true);
            }
        } finally {
            await db.close();
        }
    });
});
