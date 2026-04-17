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
            const outputDir = path.join(tmpDir, 'render-readable', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const files = collectFiles(outputDir);
            const allEventsFile = files.find(f => f.relPath === 'values/all_events');
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
            const outputDir = path.join(tmpDir, 'render-slash', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const files = collectFiles(outputDir);
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
            const outputDir = path.join(tmpDir, 'render-bang', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const files = collectFiles(outputDir);
            const relPath = keyToRelativePath(keyWithBang);
            const matchedFile = files.find(f => f.relPath === relPath.slice(2));
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
            const xOutputDir = path.join(outputDir, 'x');
            const metaOutputDir = path.join(outputDir, '_meta');
            await renderToFilesystem(capabilities, db, xOutputDir, 'x');
            await renderToFilesystem(capabilities, db, metaOutputDir, '_meta');
            const files = [
                ...collectFiles(xOutputDir).map((entry) => ({ ...entry, relPath: `x/${entry.relPath}` })),
                ...collectFiles(metaOutputDir).map((entry) => ({ ...entry, relPath: `_meta/${entry.relPath}` })),
            ].sort((a, b) => a.relPath.localeCompare(b.relPath));
            expect(files).toEqual([
                { relPath: '_meta/%2E%2E', content: JSON.stringify('meta-dotdot') },
                { relPath: '_meta/current_replica', content: JSON.stringify('x') },
                { relPath: '_meta/format', content: JSON.stringify('xy-v2') },
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
            const outputDir = path.join(tmpDir, 'render-pretty', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');

            const files = collectFiles(outputDir);
            const renderedFile = files.find(f => f.relPath === 'values/event/pretty');
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
        const staleRelPath = 'values/stale_node';
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
            await renderToFilesystem(firstCapabilities, firstDb, outputDir, 'x');
            expect(collectFiles(outputDir).some(file => file.relPath === staleRelPath)).toBe(true);
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
                await renderToFilesystem(secondCapabilities, secondDb, outputDir, 'x');
                expect(collectFiles(outputDir).some(file => file.relPath === staleRelPath)).toBe(false);
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
            const outputDir = path.join(tmpDir, 'render-content', '_meta');
            await renderToFilesystem(capabilities, db, outputDir, '_meta');

            const files = collectFiles(outputDir);
            const metaFormatFile = files.find(f => f.relPath === 'format');
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
            const outputDir = path.join(tmpDir, 'render-log', '_meta');
            await renderToFilesystem(capabilities, db, outputDir, '_meta');
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ outputDir, sublevel: '_meta', count: expect.any(Number) }),
                'Rendered database to filesystem'
            );
        } finally {
            await db.close();
        }
    });

    test('rejects non-NodeKey content in data sublevels without deleting an existing snapshot', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'render-invalid-raw-key', 'x');
        await capabilities.creator.createDirectory(path.join(outputDir, 'values'));
        const existingFile = await capabilities.creator.createFile(
            path.join(outputDir, 'values', 'existing')
        );
        await capabilities.writer.writeFile(existingFile, JSON.stringify('previous-snapshot'));

        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"all_events","args":[]}', { ok: true }],
            ['!x!!values!not-json', { broken: true }],
        ]);
        try {
            await expect(
                renderToFilesystem(capabilities, db, outputDir, 'x')
            ).rejects.toThrow('expected NodeKey JSON');
            const files = collectFiles(outputDir);
            expect(files).toEqual([
                { relPath: 'values/existing', content: JSON.stringify('previous-snapshot') },
            ]);
        } finally {
            await db.close();
        }
    });

    test('rejects malformed raw key structure without deleting an existing snapshot', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'render-malformed-raw-key', 'x');
        await capabilities.creator.createDirectory(path.join(outputDir, 'values'));
        const existingFile = await capabilities.creator.createFile(
            path.join(outputDir, 'values', 'existing')
        );
        await capabilities.writer.writeFile(existingFile, JSON.stringify('previous-snapshot'));

        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values', { broken: true }],
        ]);
        try {
            await expect(
                renderToFilesystem(capabilities, db, outputDir, 'x')
            ).rejects.toThrow("expected a '!' separator before key content");
            const files = collectFiles(outputDir);
            expect(files).toEqual([
                { relPath: 'values/existing', content: JSON.stringify('previous-snapshot') },
            ]);
        } finally {
            await db.close();
        }
    });

    test('rejects invalid sublevel path traversal', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'render-invalid-sublevel', 'x');
            await expect(
                renderToFilesystem(capabilities, db, outputDir, '../x')
            ).rejects.toThrow('Invalid sublevel');
        } finally {
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// scanFromFilesystem — P2: stale key deletion
// ---------------------------------------------------------------------------

describe('scanFromFilesystem() — stale key deletion (P2)', () => {
    test('keys present in the scanned sublevel but absent from snapshot are deleted', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();

        // Render a database with one entry
        const dbA = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v2'],
        ]);
        const renderDir = path.join(tmpDir, 'stale-render', '_meta');
        await renderToFilesystem(capabilities, dbA, renderDir, '_meta');
        await dbA.close();

        // Open a fresh DB and inject stale keys (one in scanned sublevel, one outside it)
        const dbB = await getRootDatabase(capabilities);
        await dbB._rawPut('!_meta!stale_key', 'stale');
        await dbB._rawPut('!y!!values!{"head":"keep_node","args":[]}', { keep: true });

        // Verify stale key is present before scan
        const beforeScan = await collectRawEntries(dbB);
        expect(beforeScan.has('!_meta!stale_key')).toBe(true);

        // Scan from filesystem — this MUST delete the stale key
        await scanFromFilesystem(capabilities, dbB, renderDir, '_meta');
        const afterScan = await collectRawEntries(dbB);

        // stale key in scanned sublevel must be gone; non-scanned sublevel survives
        expect(afterScan.has('!_meta!stale_key')).toBe(false);
        expect(afterScan.get('!y!!values!{"head":"keep_node","args":[]}')).toEqual({ keep: true });

        await dbB.close();
    });

    test('only keys in the scanned sublevel are replaced by snapshot entries', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();

        // Snapshot directory with ONE key
        const inputDir = path.join(tmpDir, 'scan-only-input', '_meta');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'format'),
            JSON.stringify('xy-v1')
        );

        // DB has two keys — snapshot key plus one in a different top-level sublevel
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'old-value'],
            ['!x!!values!{"head":"extra","args":[]}', { extra: true }],
        ]);

        await scanFromFilesystem(capabilities, db, inputDir, '_meta');
        const entries = await collectRawEntries(db);

        // scanned key is replaced; non-scanned sublevel key survives
        expect(entries.size).toBe(2);
        expect(entries.get('!_meta!format')).toBe('xy-v1');
        expect(entries.has('!x!!values!{"head":"extra","args":[]}')).toBe(true);

        await db.close();
    });

    test('logs a summary after scanning', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-log-in', '_meta');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'format'),
            JSON.stringify('xy-v1')
        );

        const db = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db, inputDir, '_meta');
            expect(capabilities.logger.logInfo).toHaveBeenCalledWith(
                expect.objectContaining({ inputDir, sublevel: '_meta', count: 1 }),
                'Scanned database from filesystem'
            );
        } finally {
            await db.close();
        }
    });

    test('invalid JSON snapshot throws an error (no atomicity guarantee)', async () => {
        // Note: scanFromFilesystem is NOT atomic at the adapter level.
        // If a parse error occurs mid-run, the target sublevel may be partially
        // mutated (e.g. some stale keys already deleted before the error).
        // Atomicity is guaranteed at a higher level by the replica-cutover
        // mechanism: the target is always an inactive replica that is never
        // read until cutover succeeds, so partial mutations are safe.
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-invalid-json', '_meta');
        await capabilities.creator.createDirectory(inputDir);
        const invalidFile = await capabilities.creator.createFile(
            path.join(inputDir, 'format')
        );
        await capabilities.writer.writeFile(invalidFile, '{"broken":');

        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
            ['!x!!values!{"head":"event","args":["stable"]}', { stable: true }],
        ]);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, '_meta')).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    test('partially valid snapshot with malformed file path throws an error', async () => {
        // Note: scanFromFilesystem is NOT atomic at the adapter level.
        // Atomicity is guaranteed at a higher level by the replica-cutover mechanism.
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-partial-invalid-path', '_meta');
        await capabilities.creator.createDirectory(inputDir);
        await capabilities.creator.createDirectory(path.join(inputDir, 'format'));

        const validFile = await capabilities.creator.createFile(
            path.join(inputDir, 'version')
        );
        await capabilities.writer.writeFile(validFile, JSON.stringify('v1'));
        const invalidFile = await capabilities.creator.createFile(
            path.join(inputDir, 'format', 'extra')
        );
        await capabilities.writer.writeFile(invalidFile, JSON.stringify('broken'));

        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
            ['!x!!values!{"head":"event","args":["stable"]}', { stable: true }],
        ]);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, '_meta')).rejects.toThrow(
                'plain-key sublevels require exactly one key segment'
            );
        } finally {
            await db.close();
        }
    });

    test('partially valid snapshot with one file having invalid JSON throws an error', async () => {
        // Note: scanFromFilesystem is NOT atomic at the adapter level.
        // Atomicity is guaranteed at a higher level by the replica-cutover mechanism.
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-partial-invalid-json', 'x');
        await capabilities.creator.createDirectory(path.join(inputDir, 'values', 'event'));

        const validFile = await capabilities.creator.createFile(
            path.join(inputDir, 'values', 'event', 'stable')
        );
        await capabilities.writer.writeFile(validFile, JSON.stringify({ stable: true }));
        const invalidFile = await capabilities.creator.createFile(
            path.join(inputDir, 'values', 'event', 'bad')
        );
        await capabilities.writer.writeFile(invalidFile, '{not valid json');

        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
            ['!x!!values!{"head":"event","args":["stable"]}', { stable: true }],
        ]);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'x')).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    test('rejects invalid sublevel path traversal before deleting database', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'scan-invalid-sublevel', '_meta');
        await capabilities.creator.createDirectory(inputDir);
        const formatFile = await capabilities.creator.createFile(path.join(inputDir, 'format'));
        await capabilities.writer.writeFile(formatFile, JSON.stringify('xy-v1'));
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'keep-me'],
        ]);
        try {
            const before = await collectRawEntries(db);
            await expect(scanFromFilesystem(capabilities, db, inputDir, '../_meta')).rejects.toThrow(
                'Invalid sublevel'
            );
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

        await renderToFilesystem(capA, dbA, path.join(renderDir, 'x'), 'x');
        await renderToFilesystem(capA, dbA, path.join(renderDir, 'y'), 'y');
        await renderToFilesystem(capA, dbA, path.join(renderDir, '_meta'), '_meta');
        await dbA.close();

        const dbB = await getRootDatabase(capB);
        await scanFromFilesystem(capB, dbB, path.join(renderDir, 'x'), 'x');
        await scanFromFilesystem(capB, dbB, path.join(renderDir, 'y'), 'y');
        await scanFromFilesystem(capB, dbB, path.join(renderDir, '_meta'), '_meta');

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
// sublevel parameter tests
// ---------------------------------------------------------------------------

describe('sublevel parameter', () => {
    test('renderToFilesystem writes only the requested top-level database sublevel', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'sublevel-test', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const files = collectFiles(outputDir);
            expect(files.some(file => file.relPath === 'values/all_events')).toBe(true);
            expect(files.some(file => file.relPath.startsWith('_meta/'))).toBe(false);
        } finally {
            await db.close();
        }
    });

    test('scanFromFilesystem scans into the requested top-level database sublevel', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'sublevel-scan', '_meta');
        fs.mkdirSync(inputDir, { recursive: true });
        fs.writeFileSync(
            path.join(inputDir, 'format'),
            JSON.stringify('xy-v1')
        );
        const db = await getRootDatabase(capabilities);
        try {
            await scanFromFilesystem(capabilities, db, inputDir, '_meta');
            const entries = await collectRawEntries(db);
            expect(entries.get('!_meta!format')).toBe('xy-v1');
        } finally {
            await db.close();
        }
    });

    test('two different database sublevels can be rendered side-by-side', async () => {
        const { capabilities: capA, tmpDir } = makeTestCapabilities();
        const dbA = await makeSeededDatabase(capA, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"node_a","args":[]}', { type: 'node_a' }],
            ['!y!!values!{"head":"node_b","args":[]}', { type: 'node_b' }],
        ]);
        const outputDir = path.join(tmpDir, 'shared-output', 'rendered');
        try {
            await renderToFilesystem(capA, dbA, path.join(outputDir, 'x'), 'x');
            await renderToFilesystem(capA, dbA, path.join(outputDir, 'y'), 'y');
            const topLevel = fs.readdirSync(outputDir).sort();
            expect(topLevel).toEqual(['x', 'y']);
            const filesX = collectFiles(path.join(outputDir, 'x'));
            const filesY = collectFiles(path.join(outputDir, 'y'));
            expect(filesX.some(f => f.relPath === 'values/node_a')).toBe(true);
            expect(filesY.some(f => f.relPath === 'values/node_b')).toBe(true);
            expect(filesX.some(f => f.relPath === 'values/node_b')).toBe(false);
            expect(filesY.some(f => f.relPath === 'values/node_a')).toBe(false);
        } finally {
            await dbA.close();
        }
    });

    test('render and scan with the same sublevel are exact inverses', async () => {
        const { capabilities: capA, tmpDir } = makeTestCapabilities();
        const { capabilities: capB } = makeTestCapabilities();
        capB.environment.workingDirectory = jest.fn().mockReturnValue(
            path.join(tmpDir, 'results-b')
        );
        const seedEntries = [
            ['!_meta!format', 'xy-v2'],
            ['!x!!values!{"head":"event","args":["hello"]}', { type: 'event', value: 42 }],
            ['!x!!freshness!{"head":"event","args":["hello"]}', 'up-to-date'],
        ];
        const dbA = await makeSeededDatabase(capA, seedEntries);
        const sharedDir = path.join(tmpDir, 'shared-dir', 'rendered', 'x');
        await renderToFilesystem(capA, dbA, sharedDir, 'x');
        await dbA.close();

        const dbB = await getRootDatabase(capB);
        await scanFromFilesystem(capB, dbB, sharedDir, 'x');
        const dbBEntries = await collectRawEntries(dbB);
        await dbB.close();

        for (const [key, value] of seedEntries) {
            expect(dbBEntries.has(key)).toBe(true);
            expect(dbBEntries.get(key)).toEqual(value);
        }
    });

    test('rendering and scanning only "x" preserves existing "_meta" entries', async () => {
        const { capabilities: capA, tmpDir } = makeTestCapabilities();
        const { capabilities: capB } = makeTestCapabilities();
        capB.environment.workingDirectory = jest.fn().mockReturnValue(
            path.join(tmpDir, 'results-b')
        );
        const seedEntries = [
            ['!_meta!format', 'xy-v2'],
            ['!x!!values!{"head":"event","args":["hello"]}', { type: 'event', value: 42 }],
        ];
        const dbA = await makeSeededDatabase(capA, seedEntries);
        const sharedDir = path.join(tmpDir, 'shared-dir-x-only', 'rendered', 'x');
        await renderToFilesystem(capA, dbA, sharedDir, 'x');
        await dbA.close();

        const dbB = await getRootDatabase(capB);
        await scanFromFilesystem(capB, dbB, sharedDir, 'x');
        const dbBEntries = await collectRawEntries(dbB);
        await dbB.close();

        expect(dbBEntries.get('!x!!values!{"head":"event","args":["hello"]}')).toEqual({
            type: 'event',
            value: 42,
        });
        expect(dbBEntries.get('!_meta!format')).toBe('xy-v2');
    });

    test('scanFromFilesystem rejects mismatched filesystem and sublevel pair', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'mismatch', 'rendered', '_meta');
        await capabilities.creator.createDirectory(inputDir);
        const formatFile = await capabilities.creator.createFile(path.join(inputDir, 'format'));
        await capabilities.writer.writeFile(formatFile, JSON.stringify('xy-v1'));
        const db = await getRootDatabase(capabilities);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'x')).rejects.toThrow();
        } finally {
            await db.close();
        }
    });

    test('scanFromFilesystem throws ScanInputDirMissingError when inputDir does not exist', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'does-not-exist', 'rendered', 'x');
        const db = await getRootDatabase(capabilities);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, 'x')).rejects.toThrow(
                'does not exist'
            );
        } finally {
            await db.close();
        }
    });

    test('scanFromFilesystem does not mutate the database when inputDir is missing', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"event","args":["keep"]}', { keep: true }],
        ]);
        const before = await collectRawEntries(db);
        const inputDir = path.join(tmpDir, 'absent-dir', 'rendered', 'x');
        try {
            await scanFromFilesystem(capabilities, db, inputDir, 'x');
        } catch (_err) {
            // expected
        }
        const after = await collectRawEntries(db);
        expect(after).toEqual(before);
        await db.close();
    });

    test('validateTopLevelSublevel rejects non-string sublevel argument', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            // @ts-expect-error intentionally passing a non-string
            await expect(renderToFilesystem(capabilities, db, path.join(tmpDir, 'out'), null)).rejects.toThrow(
                'expected a string'
            );
            // @ts-expect-error intentionally passing a non-string
            await expect(renderToFilesystem(capabilities, db, path.join(tmpDir, 'out'), 42)).rejects.toThrow(
                'expected a string'
            );
        } finally {
            await db.close();
        }
    });
});

// ---------------------------------------------------------------------------
// Additional reliability tests
// ---------------------------------------------------------------------------

describe('additional reliability tests', () => {
    test('renderToFilesystem is idempotent when called twice on same outputDir', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const db = await makeSeededDatabase(capabilities, [
            ['!_meta!format', 'xy-v1'],
            ['!x!!values!{"head":"all_events","args":[]}', { type: 'all_events', events: [] }],
        ]);
        try {
            const outputDir = path.join(tmpDir, 'idem-out', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const filesFirst = collectFiles(outputDir).sort((a, b) => a.relPath.localeCompare(b.relPath));
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const filesSecond = collectFiles(outputDir).sort((a, b) => a.relPath.localeCompare(b.relPath));
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
            const outputDir = path.join(tmpDir, 'count-out', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');
            const filesOnDisk = collectFiles(outputDir);
            const dbEntries = await collectRawEntries(db);
            const xEntriesCount = Array.from(dbEntries.keys()).filter((key) => key.startsWith('!x!!')).length;
            expect(filesOnDisk.length).toBe(xEntriesCount);
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

            const outputDir = path.join(tmpDir, 'decode-out', 'x');
            await renderToFilesystem(capabilities, db, outputDir, 'x');

            const files = collectFiles(outputDir);
            for (const { relPath } of files) {
                const key = relativePathToKey(`x/${relPath}`);
                expect(typeof key).toBe('string');
                expect(key.startsWith('!')).toBe(true);
            }
        } finally {
            await db.close();
        }
    });

    test('scan rejects malformed plain-key snapshot paths with extra segments', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const inputDir = path.join(tmpDir, 'malformed-plain-key', '_meta');
        await capabilities.creator.createDirectory(inputDir);
        await capabilities.creator.createDirectory(path.join(inputDir, 'format'));
        const malformedFile = await capabilities.creator.createFile(
            path.join(inputDir, 'format', 'extra')
        );
        await capabilities.writer.writeFile(malformedFile, JSON.stringify('xy-v1'));
        const db = await getRootDatabase(capabilities);
        try {
            await expect(scanFromFilesystem(capabilities, db, inputDir, '_meta')).rejects.toThrow(
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
            // +2 accounts for the format marker and current_replica that getRootDatabase() writes on open.
            expect(storedEntries.size).toBe(entriesCount + 2);
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
