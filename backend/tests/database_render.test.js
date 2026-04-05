/**
 * Tests for renderToFilesystem() and scanFromFilesystem() in the
 * incremental-graph database module.
 *
 * Focus areas:
 *   1. keyToRelativePath / relativePathToKey are exact inverses (bijection),
 *      including keys containing '!', '/', and '%' in argument values.
 *   2. renderToFilesystem creates files whose names and contents faithfully
 *      represent the database.
 *   3. scanFromFilesystem restores the database exactly (bijection with render),
 *      AND removes stale keys that were present before the scan.
 *   4. Edge cases: '!' in args, '/' in args, deeply-nested args, non-string
 *      args, empty databases, multiple namespaces.
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
    LIVE_DATABASE_WORKING_PATH,
} = require('../src/generators/incremental_graph/database');
const { RAW_BATCH_CHUNK_SIZE } = require('../src/generators/incremental_graph/database/root_database');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Creates a full set of test capabilities.
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
 * Opens a fresh RootDatabase seeded with the given raw LevelDB entries.
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
// keyToRelativePath() — unit tests for the new head/arg1/arg2 encoding
// ---------------------------------------------------------------------------

describe('keyToRelativePath()', () => {
    test('root meta format key', () => {
        expect(keyToRelativePath('!_meta!format')).toBe('_meta/format');
    });

    test('namespace meta version key', () => {
        expect(keyToRelativePath('!x!!meta!version')).toBe('x/meta/version');
    });

    test('zero-arg NodeKey', () => {
        expect(keyToRelativePath('!x!!values!{"head":"all_events","args":[]}')).toBe(
            'x/values/all_events'
        );
    });

    test('one-arg NodeKey with plain string arg', () => {
        expect(keyToRelativePath('!x!!values!{"head":"event","args":["abc123"]}')).toBe(
            'x/values/event/abc123'
        );
    });

    test('one-arg NodeKey with "/" in arg', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"transcription","args":["/audio/file.mp3"]}'
        )).toBe('x/values/transcription/%2Faudio%2Ffile.mp3');
    });

    test('one-arg NodeKey with "!" in arg (P1 fix)', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event","args":["a!b"]}'
        )).toBe('x/values/event/a%21b');
    });

    test('one-arg NodeKey with "!!" in arg keeps content intact', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event","args":["a!!b"]}'
        )).toBe('x/values/event/a%21%21b');
    });

    test('one-arg NodeKey with "%" in arg', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event","args":["50%off"]}'
        )).toBe('x/values/event/50%25off');
    });

    test('dot segments are escaped so they remain literal path values', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event","args":[".",".."]}'
        )).toBe('x/values/event/%2E/%2E%2E');
        expect(keyToRelativePath('!_meta!..')).toBe('_meta/%2E%2E');
    });

    test('string arg beginning with "~" is escaped to stay distinct from non-string args', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event","args":["~42"]}'
        )).toBe('x/values/event/~~42');
    });

    test('two-arg NodeKey', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event_transcription","args":["evtId","/audio/x.mp3"]}'
        )).toBe('x/values/event_transcription/evtId/%2Faudio%2Fx.mp3');
    });

    test('non-string arg (number) uses ~ prefix', () => {
        const encodedPath = keyToRelativePath('!x!!values!{"head":"event","args":[42]}');
        expect(encodedPath).toBe('x/values/event/~42');
    });

    test('different sublevel (freshness) uses same head/arg encoding', () => {
        expect(keyToRelativePath('!x!!freshness!{"head":"all_events","args":[]}')).toBe(
            'x/freshness/all_events'
        );
    });

    test('mixed non-string args encode via JSON segments', () => {
        expect(keyToRelativePath(
            '!x!!values!{"head":"event","args":[true,null,{"nested":["x",1]},["a",2]]}'
        )).toBe(
            'x/values/event/~true/~null/~{"nested":["x",1]}/~["a",2]'
        );
    });

    test('throws for non-plain sublevel key content that is not NodeKey JSON', () => {
        expect(() => keyToRelativePath('!x!!values!not-json')).toThrow(
            'expected NodeKey JSON'
        );
    });

    test('throws for raw keys without the required leading "!"', () => {
        expect(() => keyToRelativePath('x!!values!{"head":"event","args":[]}')).toThrow(
            "expected raw LevelDB keys to start with '!'"
        );
    });

    test('throws for raw keys missing the separator before key content', () => {
        expect(() => keyToRelativePath('!x!!values')).toThrow(
            "expected a '!' separator before key content"
        );
    });

    test('throws for raw keys with empty sublevel names', () => {
        expect(() => keyToRelativePath('!x!!!!values!{"head":"event","args":[]}')).toThrow(
            'sublevel names must not be empty'
        );
    });
});

// ---------------------------------------------------------------------------
// relativePathToKey() — unit tests
// ---------------------------------------------------------------------------

describe('relativePathToKey()', () => {
    test('root meta format', () => {
        expect(relativePathToKey('_meta/format')).toBe('!_meta!format');
    });

    test('namespace meta version', () => {
        expect(relativePathToKey('x/meta/version')).toBe('!x!!meta!version');
    });

    test('zero-arg NodeKey path', () => {
        expect(relativePathToKey('x/values/all_events')).toBe(
            '!x!!values!{"head":"all_events","args":[]}'
        );
    });

    test('one-arg NodeKey with plain string', () => {
        expect(relativePathToKey('x/values/event/abc123')).toBe(
            '!x!!values!{"head":"event","args":["abc123"]}'
        );
    });

    test('decodes "%2F" back to "/" in arg', () => {
        expect(relativePathToKey('x/values/transcription/%2Faudio%2Ffile.mp3')).toBe(
            '!x!!values!{"head":"transcription","args":["/audio/file.mp3"]}'
        );
    });

    test('decodes "%21" back to "!" in arg (P1 fix)', () => {
        expect(relativePathToKey('x/values/event/a%21b')).toBe(
            '!x!!values!{"head":"event","args":["a!b"]}'
        );
    });

    test('decodes "%21%21" back to "!!" in arg', () => {
        expect(relativePathToKey('x/values/event/a%21%21b')).toBe(
            '!x!!values!{"head":"event","args":["a!!b"]}'
        );
    });

    test('decodes "%25" back to "%" in arg', () => {
        expect(relativePathToKey('x/values/event/50%25off')).toBe(
            '!x!!values!{"head":"event","args":["50%off"]}'
        );
    });

    test('decodes escaped dot segments back to literal "." and ".."', () => {
        expect(relativePathToKey('x/values/event/%2E/%2E%2E')).toBe(
            '!x!!values!{"head":"event","args":[".",".."]}'
        );
        expect(relativePathToKey('_meta/%2E%2E')).toBe('!_meta!..');
    });

    test('two-arg NodeKey path', () => {
        expect(relativePathToKey('x/values/event_transcription/evtId/%2Faudio%2Fx.mp3')).toBe(
            '!x!!values!{"head":"event_transcription","args":["evtId","/audio/x.mp3"]}'
        );
    });

    test('non-string arg with ~ prefix decodes to number', () => {
        expect(relativePathToKey('x/values/event/~42')).toBe(
            '!x!!values!{"head":"event","args":[42]}'
        );
    });

    test('string arg with leading "~" remains a string', () => {
        expect(relativePathToKey('x/values/event/~~42')).toBe(
            '!x!!values!{"head":"event","args":["~42"]}'
        );
    });

    test('mixed JSON-encoded arg segments decode back to original values', () => {
        expect(relativePathToKey(
            'x/values/event/~true/~null/~{"nested":["x",1]}/~["a",2]'
        )).toBe(
            '!x!!values!{"head":"event","args":[true,null,{"nested":["x",1]},["a",2]]}'
        );
    });

    test('throws for fewer than two segments', () => {
        expect(() => relativePathToKey('onlyone')).toThrow();
        expect(() => relativePathToKey('')).toThrow();
    });

    test('throws when plain-key sublevels have extra path segments', () => {
        expect(() => relativePathToKey('_meta/format/extra')).toThrow(
            'plain-key sublevels require exactly one key segment'
        );
        expect(() => relativePathToKey('x/meta/version/extra')).toThrow(
            'plain-key sublevels require exactly one key segment'
        );
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
        '!x!!counters!{"head":"all_events","args":[]}',
        '!x!!timestamps!{"head":"all_events","args":[]}',
        '!x!!values!{"head":"transcription","args":["/path/to/audio.mp3"]}',
        '!x!!values!{"head":"event","args":["id/with/slashes"]}',
        '!x!!values!{"head":"event","args":["a!b"]}',
        '!x!!values!{"head":"event","args":["a!!b"]}',
        '!x!!values!{"head":"event","args":["50%off"]}',
        '!x!!values!{"head":"event","args":["~42"]}',
        '!x!!values!{"head":"event","args":[42]}',
        '!x!!values!{"head":"event_transcription","args":["evtId","/audio/x.mp3"]}',
        '!y!!values!{"head":"all_events","args":[]}',
        '!y!!meta!version',
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

    test('string "~42" and number 42 map to distinct paths', () => {
        expect(
            keyToRelativePath('!x!!values!{"head":"event","args":["~42"]}')
        ).not.toBe(
            keyToRelativePath('!x!!values!{"head":"event","args":[42]}')
        );
    });

    test('dot-segment sentinels stay distinct from literal percent-encoded text', () => {
        expect(
            keyToRelativePath('!x!!values!{"head":"event","args":["."]}')
        ).not.toBe(
            keyToRelativePath('!x!!values!{"head":"event","args":["%2E"]}')
        );
        expect(
            keyToRelativePath('!x!!values!{"head":"event","args":[".."]}')
        ).not.toBe(
            keyToRelativePath('!x!!values!{"head":"event","args":["%2E%2E"]}')
        );
    });

    test('empty-string argument round-trips via a dedicated sentinel', () => {
        const key = '!x!!values!{"head":"event","args":[""]}';
        const rel = keyToRelativePath(key);
        expect(rel).toBe('x/values/event/%00');
        expect(relativePathToKey(rel)).toBe(key);
    });
});

// ---------------------------------------------------------------------------
// renderToFilesystem
// ---------------------------------------------------------------------------

describe('renderToFilesystem()', () => {
    test('zero-arg node produces human-readable path without JSON blob', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-readable');
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const files = collectFiles(path.join(outputDir, 'db'));
            const allEventsFile = files.find(f => f.relPath === 'x/values/all_events');
            expect(allEventsFile).toBeDefined();
        } finally {
            await db.close();
        }
    });

    test('one-arg node with "/" in arg produces percent-encoded segment', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const keyWithSlash = '!x!!values!{"head":"transcription","args":["/audio/file.mp3"]}';
        const db = await makeSeededDatabase(capabilities, [
            [keyWithSlash, { type: 'transcription', value: 'hello world' }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-slash');
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const files = collectFiles(path.join(outputDir, 'db'));
            expect(files.some(f => f.relPath.includes('%2F'))).toBe(true);
            // The filename should NOT contain literal '/'
            const fileRelPaths = files.map(f => f.relPath.split('/').pop());
            for (const filename of fileRelPaths) {
                expect(filename).not.toContain('/');
            }
        } finally {
            await db.close();
        }
    });

    test('one-arg node with "!" in arg produces %21-encoded segment (P1 fix)', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const keyWithBang = '!x!!values!{"head":"event","args":["a!b"]}';
        const db = await makeSeededDatabase(capabilities, [
            [keyWithBang, { type: 'event', value: 'test' }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-bang');
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const files = collectFiles(path.join(outputDir, 'db'));
            const relPath = keyToRelativePath(keyWithBang);
            const matchedFile = files.find(f => f.relPath === relPath);
            expect(matchedFile).toBeDefined();
            // Path contains %21 for the '!' in the arg
            expect(relPath).toContain('%21');
        } finally {
            await db.close();
        }
    });

    test('dot-segment keys render to contained encoded paths', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"event","args":[".."]}', { type: 'event', value: 'safe' }],
            ['!_meta!..', 'meta-dotdot'],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-dot-segments');
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const files = collectFiles(path.join(outputDir, 'db')).sort((a, b) => a.relPath.localeCompare(b.relPath));
            expect(files).toEqual([
                { relPath: '_meta/%2E%2E', content: JSON.stringify('meta-dotdot') },
                { relPath: '_meta/format', content: JSON.stringify('xy-v1') },
                { relPath: 'x/values/event/%2E%2E', content: JSON.stringify({ type: 'event', value: 'safe' }, null, 2) },
            ]);
        } finally {
            await db.close();
        }
    });

    test('object values are rendered as pretty-printed JSON', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const value = {
            type: 'event',
            nested: {
                count: 1,
                values: ['a', 'b'],
            },
        };
        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"event","args":["pretty"]}', value],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-pretty');
            await renderToFilesystem(capabilities, db, outputDir, 'db');

            const files = collectFiles(path.join(outputDir, 'db'));
            const renderedFile = files.find(f => f.relPath === 'x/values/event/pretty');
            expect(renderedFile).toBeDefined();
            expect(renderedFile.content).toBe(JSON.stringify(value, null, 2));
        } finally {
            await db.close();
        }
    });

    test('re-render to same outputDir removes stale files from previous snapshot', async () => {
        const { capabilities: firstCapabilities, tmpDir } = makeTestCapabilities();
        const { capabilities: secondCapabilities } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'render-shrink');
        const staleRelPath = 'x/values/stale_node';
        const firstDb = await makeSeededDatabase(firstCapabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"stale_node","args":[]}', { stale: true }],
        ]);
        const isolatedTmpDir = await secondCapabilities.creator.createTemporaryDirectory(
        );
        secondCapabilities.environment.workingDirectory = jest.fn().mockReturnValue(
            path.join(isolatedTmpDir, 'results')
        );
        try {
            await renderToFilesystem(firstCapabilities, firstDb, outputDir, 'db');
            expect(collectFiles(path.join(outputDir, 'db')).some(file => file.relPath === staleRelPath)).toBe(true);
        } finally {
            await firstDb.close();
        }

        try {
            const secondDb = await makeSeededDatabase(secondCapabilities, [
                ['!_meta!format', 'xy-v1'],
            ]);
            try {
                expect(secondCapabilities.environment.workingDirectory).toHaveBeenCalled();
                expect(await secondCapabilities.checker.directoryExists(
                    path.join(
                        isolatedTmpDir,
                        'results',
                        LIVE_DATABASE_WORKING_PATH
                    )
                )).toBeTruthy();
                await renderToFilesystem(secondCapabilities, secondDb, outputDir, 'db');
                expect(collectFiles(path.join(outputDir, 'db')).some(file => file.relPath === staleRelPath)).toBe(false);
            } finally {
                await secondDb.close();
            }
        } finally {
            await secondCapabilities.deleter.deleteDirectory(isolatedTmpDir);
        }
    });

    test('file content is valid JSON matching the stored value', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'test-marker'],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-content');
            await renderToFilesystem(capabilities, db, outputDir, 'db');

            const files = collectFiles(path.join(outputDir, 'db'));
            const metaFormatFile = files.find(f => f.relPath === '_meta/format');
            expect(metaFormatFile).toBeDefined();
            expect(JSON.parse(metaFormatFile.content)).toBe('test-marker');
        } finally {
            await db.close();
        }
    });

    test('logs a summary after rendering', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-log');
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ outputDir: path.join(outputDir, 'db'), count: expect.any(Number) }),
                'Rendered database to filesystem'
            );
        } finally {
            await db.close();
        }
    });

    test('rejects non-NodeKey content in data sublevels without deleting an existing snapshot', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'render-invalid-raw-key');
        await capabilities.creator.createDirectory(path.join(outputDir, 'db', '_meta'));
        const existingFile = await capabilities.creator.createFile(
            path.join(outputDir, 'db', '_meta', 'format')
        );
        await capabilities.writer.writeFile(existingFile, JSON.stringify('previous-snapshot'));

        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"all_events","args":[]}', { ok: true }],
            ['!x!!values!not-json', { broken: true }],
        ]);
        try {
            await expect(
                renderToFilesystem(capabilities, db, outputDir, 'db')
            ).rejects.toThrow('expected NodeKey JSON');
            const files = collectFiles(path.join(outputDir, 'db'));
            expect(files).toEqual([
                { relPath: '_meta/format', content: JSON.stringify('previous-snapshot') },
            ]);
        } finally {
            await db.close();
        }
    });

    test('rejects malformed raw key structure without deleting an existing snapshot', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'render-malformed-raw-key');
        await capabilities.creator.createDirectory(path.join(outputDir, 'db', '_meta'));
        const existingFile = await capabilities.creator.createFile(
            path.join(outputDir, 'db', '_meta', 'format')
        );
        await capabilities.writer.writeFile(existingFile, JSON.stringify('previous-snapshot'));

        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values', { broken: true }],
        ]);
        try {
            await expect(
                renderToFilesystem(capabilities, db, outputDir, 'db')
            ).rejects.toThrow("expected a '!' separator before key content");
            const files = collectFiles(path.join(outputDir, 'db'));
            expect(files).toEqual([
                { relPath: '_meta/format', content: JSON.stringify('previous-snapshot') },
            ]);
        } finally {
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// scanFromFilesystem — P2: stale key deletion
// ---------------------------------------------------------------------------

describe('scanFromFilesystem() — stale key deletion (P2)', () => {
    test('keys present in DB but absent from snapshot are deleted', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();

        // Render a database with one entry
        const dbA = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
        ]);
        const renderDir = path.join(tmpDir, 'stale-render');
        await renderToFilesystem(capabilities, dbA, renderDir, 'db');
        await dbA.close();

        // Open a fresh DB and inject a STALE key (not in the snapshot)
        const dbB = await getRootDatabase(capabilities);
        await dbB._rawPut('!x!!values!{"head":"stale_node","args":[]}', { stale: true });

        // Verify stale key is present before scan
        const beforeScan = await collectRawEntries(dbB);
        expect(beforeScan.has('!x!!values!{"head":"stale_node","args":[]}')).toBe(true);

        // Scan from filesystem — this MUST delete the stale key
        await scanFromFilesystem(capabilities, dbB, renderDir, 'db');
        const afterScan = await collectRawEntries(dbB);

        // Stale key must be gone
        expect(afterScan.has('!x!!values!{"head":"stale_node","args":[]}')).toBe(false);

        await dbB.close();
    });

    test('only keys in the snapshot survive after scan', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();

        // Snapshot directory with ONE key
        const inputDir = path.join(tmpDir, 'scan-only-input');
        fs.mkdirSync(path.join(inputDir, 'db', '_meta'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'db', '_meta', 'format'),
            JSON.stringify('xy-v1')
        );

        // DB has TWO keys — one matching snapshot, one extra (stale)
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'old-value'],
            ['!x!!values!{"head":"extra","args":[]}', { extra: true }],
        ]);

        await scanFromFilesystem(capabilities, db, inputDir, 'db');
        const entries = await collectRawEntries(db);

        // Only the scanned key should survive
        expect(entries.size).toBe(1);
        expect(entries.get('!_meta!format')).toBe('xy-v1');
        expect(entries.has('!x!!values!{"head":"extra","args":[]}')).toBe(false);

        await db.close();
    });

    test('logs a summary after scanning', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-log-in');
        fs.mkdirSync(path.join(inputDir, 'db', '_meta'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'db', '_meta', 'format'),
            JSON.stringify('xy-v1')
        );

        const db = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db, inputDir, 'db');
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ inputDir: path.join(inputDir, 'db'), count: 1 }),
                'Scanned database from filesystem'
            );
        } finally {
            await db.close();
        }
    });

    test('invalid JSON snapshot leaves existing database unchanged', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-invalid-json');
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', '_meta'));
        const invalidFile = await capabilities.creator.createFile(
            path.join(inputDir, 'db', '_meta', 'format')
        );
        await capabilities.writer.writeFile(invalidFile, '{"broken":');

        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
            ['!x!!values!{"head":"event","args":["stable"]}', { stable: true }],
        ]);
        try {
            const before = await collectRawEntries(db);
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'db')).rejects.toThrow();
            const after = await collectRawEntries(db);
            expect(after).toEqual(before);
        } finally {
            await db.close();
        }
    });

    test('partially valid snapshot leaves existing database unchanged when one file path is malformed', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-partial-invalid-path');
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', '_meta'));
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', '_meta', 'format'));

        const validFile = await capabilities.creator.createFile(
            path.join(inputDir, 'db', '_meta', 'version')
        );
        await capabilities.writer.writeFile(validFile, JSON.stringify('v1'));
        const invalidFile = await capabilities.creator.createFile(
            path.join(inputDir, 'db', '_meta', 'format', 'extra')
        );
        await capabilities.writer.writeFile(invalidFile, JSON.stringify('broken'));

        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
            ['!x!!values!{"head":"event","args":["stable"]}', { stable: true }],
        ]);
        try {
            const before = await collectRawEntries(db);
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'db')).rejects.toThrow(
                'plain-key sublevels require exactly one key segment'
            );
            const after = await collectRawEntries(db);
            expect(after).toEqual(before);
        } finally {
            await db.close();
        }
    });

    test('partially valid snapshot leaves existing database unchanged when one file has invalid JSON', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-partial-invalid-json');
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', '_meta'));
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', 'x', 'values', 'event'));

        const validFile = await capabilities.creator.createFile(
            path.join(inputDir, 'db', '_meta', 'format')
        );
        await capabilities.writer.writeFile(validFile, JSON.stringify('xy-v1'));
        const invalidFile = await capabilities.creator.createFile(
            path.join(inputDir, 'db', 'x', 'values', 'event', 'bad')
        );
        await capabilities.writer.writeFile(invalidFile, '{not valid json');

        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
            ['!x!!values!{"head":"event","args":["stable"]}', { stable: true }],
        ]);
        try {
            const before = await collectRawEntries(db);
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'db')).rejects.toThrow();
            const after = await collectRawEntries(db);
            expect(after).toEqual(before);
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

        await renderToFilesystem(capA, dbA, renderDir, 'db');
        await dbA.close();

        const dbB = await getRootDatabase(capB);
        await scanFromFilesystem(capB, dbB, renderDir, 'db');

        const dbAEntries = new Map(seedEntries);
        const dbBEntries = await collectRawEntries(dbB);
        await dbB.close();

        return { dbAEntries, dbBEntries };
    }

    /**
     * Asserts that every seeded entry appears in the scanned database with the
     * same value.
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

    test('entry with "/" in the key arg (P1 adjacent)', async () => {
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

    test('entry with "!" in the key arg (P1 fix)', async () => {
        const seed = [
            [
                '!x!!values!{"head":"event","args":["a!b"]}',
                { type: 'event', value: 'test' },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has('!x!!values!{"head":"event","args":["a!b"]}')).toBe(true);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('entry with "!!" in the key arg round-trips', async () => {
        const seed = [
            [
                '!x!!values!{"head":"event","args":["a!!b"]}',
                { type: 'event', value: 'double-bang' },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has('!x!!values!{"head":"event","args":["a!!b"]}')).toBe(true);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });

    test('entry with "%" in the key arg', async () => {
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

    test('string arg beginning with "~" round-trips as a string', async () => {
        const seed = [
            [
                '!x!!values!{"head":"event","args":["~42"]}',
                { type: 'event', value: 'tilde-string' },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has('!x!!values!{"head":"event","args":["~42"]}')).toBe(true);
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

    test('two-arg NodeKey round-trips', async () => {
        const seed = [
            [
                '!x!!values!{"head":"event_transcription","args":["evtId","/audio/x.mp3"]}',
                { type: 'event_transcription', value: 'hello' },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has(
            '!x!!values!{"head":"event_transcription","args":["evtId","/audio/x.mp3"]}'
        )).toBe(true);
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

    test('mixed non-string arguments round-trip across render and scan', async () => {
        const seed = [
            [
                '!x!!values!{"head":"event","args":[true,null,{"nested":["x",1]},["a",2]]}',
                { type: 'event', value: 'mixed-args' },
            ],
        ];
        const { dbAEntries, dbBEntries } = await renderAndScan(seed);
        expect(dbBEntries.has(
            '!x!!values!{"head":"event","args":[true,null,{"nested":["x",1]},["a",2]]}'
        )).toBe(true);
        assertAllEntriesPresent(dbAEntries, dbBEntries);
    });
});

// ---------------------------------------------------------------------------
// Sublevel parameter tests
// ---------------------------------------------------------------------------

describe('sublevel parameter', () => {
    test('renderToFilesystem places files inside the sublevel subdirectory', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'sublevel-test');
            await renderToFilesystem(capabilities, db, outputDir, 'snapshot');
            // Files must be inside outputDir/snapshot/, not directly in outputDir
            const topLevelEntries = fs.readdirSync(outputDir);
            expect(topLevelEntries).toEqual(['snapshot']);
            const files = collectFiles(path.join(outputDir, 'snapshot'));
            expect(files.length).toBeGreaterThan(0);
        } finally {
            await db.close();
        }
    });

    test('scanFromFilesystem reads files from the sublevel subdirectory', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'sublevel-scan');
        fs.mkdirSync(path.join(inputDir, 'snapshot', '_meta'), { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'snapshot', '_meta', 'format'),
            JSON.stringify('xy-v1')
        );
        const db = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db, inputDir, 'snapshot');
            const entries = await collectRawEntries(db);
            expect(entries.get('!_meta!format')).toBe('xy-v1');
        } finally {
            await db.close();
        }
    });

    test('two different sublevels can coexist in the same outputDir', async () => {
        const { capabilities: capA, tmpDir } = makeTestCapabilities();
        const { capabilities: capB } = makeTestCapabilities();
        capB.environment.workingDirectory = jest.fn().mockReturnValue(
            path.join(tmpDir, 'results-b')
        );
        const dbA = await makeSeededDatabase(capA, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"node_a","args":[]}', { type: 'node_a' }],
        ]);
        const dbB = await makeSeededDatabase(capB, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"node_b","args":[]}', { type: 'node_b' }],
        ]);
        const outputDir = path.join(tmpDir, 'shared-output');
        try {
            await renderToFilesystem(capA, dbA, outputDir, 'alpha');
            await renderToFilesystem(capB, dbB, outputDir, 'beta');
            const topLevel = fs.readdirSync(outputDir).sort();
            expect(topLevel).toEqual(['alpha', 'beta']);
            const filesAlpha = collectFiles(path.join(outputDir, 'alpha'));
            const filesBeta = collectFiles(path.join(outputDir, 'beta'));
            expect(filesAlpha.some(f => f.relPath === 'x/values/node_a')).toBe(true);
            expect(filesBeta.some(f => f.relPath === 'x/values/node_b')).toBe(true);
            expect(filesAlpha.some(f => f.relPath === 'x/values/node_b')).toBe(false);
            expect(filesBeta.some(f => f.relPath === 'x/values/node_a')).toBe(false);
        } finally {
            await dbA.close();
            await dbB.close();
        }
    });

    test('render and scan with the same sublevel are exact inverses', async () => {
        const { capabilities: capA, tmpDir } = makeTestCapabilities();
        const { capabilities: capB } = makeTestCapabilities();
        capB.environment.workingDirectory = jest.fn().mockReturnValue(
            path.join(tmpDir, 'results-b')
        );
        const seedEntries = [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"event","args":["hello"]}', { type: 'event', value: 42 }],
            ['!x!!freshness!{"head":"event","args":["hello"]}', 'up-to-date'],
        ];
        const dbA = await makeSeededDatabase(capA, seedEntries);
        const sharedDir = path.join(tmpDir, 'shared-dir');
        await renderToFilesystem(capA, dbA, sharedDir, 'snap');
        await dbA.close();

        const dbB = await getRootDatabase(capB);
        await scanFromFilesystem(capB, dbB, sharedDir, 'snap');
        const dbBEntries = await collectRawEntries(dbB);
        await dbB.close();

        for (const [key, value] of seedEntries) {
            expect(dbBEntries.has(key)).toBe(true);
            expect(dbBEntries.get(key)).toEqual(value);
        }
    });
});



describe('additional reliability tests', () => {
    test('renderToFilesystem is idempotent when called twice on same outputDir', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'idem-out');
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const filesFirst = collectFiles(path.join(outputDir, 'db')).sort((a, b) => a.relPath.localeCompare(b.relPath));
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const filesSecond = collectFiles(path.join(outputDir, 'db')).sort((a, b) => a.relPath.localeCompare(b.relPath));
            expect(filesSecond).toEqual(filesFirst);
        } finally {
            await db.close();
        }
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
            await renderToFilesystem(capabilities, db, outputDir, 'db');
            const filesOnDisk = collectFiles(path.join(outputDir, 'db'));
            const dbEntries = await collectRawEntries(db);
            expect(filesOnDisk.length).toBe(dbEntries.size);
        } finally {
            await db.close();
        }
    });

    test('rendered paths all decode back to valid LevelDB keys starting with !', async () => {
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
            await renderToFilesystem(capabilities, db, outputDir, 'db');

            const files = collectFiles(path.join(outputDir, 'db'));
            for (const { relPath } of files) {
                const key = relativePathToKey(relPath);
                expect(typeof key).toBe('string');
                expect(key.startsWith('!')).toBe(true);
            }
        } finally {
            await db.close();
        }
    });

    test('scan rejects malformed plain-key snapshot paths with extra segments', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'malformed-plain-key');
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', '_meta'));
        await capabilities.creator.createDirectory(path.join(inputDir, 'db', '_meta', 'format'));
        const malformedFile = await capabilities.creator.createFile(
            path.join(inputDir, 'db', '_meta', 'format', 'extra')
        );
        await capabilities.writer.writeFile(malformedFile, JSON.stringify('xy-v1'));
        const db = await getRootDatabase(capabilities);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'db')).rejects.toThrow(
                'plain-key sublevels require exactly one key segment'
            );
        } finally {
            await db.close();
        }
    });

    test('key paths for every rendered file stay unique after encoding special arguments', async () => {
        const relPaths = [
            keyToRelativePath('!x!!values!{"head":"event","args":["~42"]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":[42]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":["a!b"]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":["a!!b"]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":["a/b"]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":["a%b"]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":["."]}'),
            keyToRelativePath('!x!!values!{"head":"event","args":[".."]}'),
        ];
        expect(new Set(relPaths).size).toBe(relPaths.length);
    });

    test('_rawPutAll writes large batches in chunks', async () => {
        const { capabilities } = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        const batchSpy = jest.spyOn(db.db, 'batch');
        try {
            const entriesCount = RAW_BATCH_CHUNK_SIZE + 1;
            const entries = Array.from({ length: entriesCount }, (_, index) => {
                return {
                    key: `!x!!values!{"head":"event","args":["${index}"]}`,
                    value: { index },
                };
            });
            await db._rawPutAll(entries);
            expect(batchSpy).toHaveBeenCalledTimes(2);
            const storedEntries = await collectRawEntries(db);
            // +1 accounts for the format marker that getRootDatabase() writes on open.
            expect(storedEntries.size).toBe(entriesCount + 1);
            expect(
                storedEntries.get(
                    `!x!!values!{"head":"event","args":["${entriesCount - 1}"]}`
                )
            ).toEqual({ index: entriesCount - 1 });
        } finally {
            batchSpy.mockRestore();
            await db.close();
        }
    });

    test('empty Level instance has no entries', async () => {
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
});
