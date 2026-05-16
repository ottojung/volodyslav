const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    getRootDatabase,
    makeRootDatabase,
    renderToFilesystem,
    scanFromFilesystem,
    keyToRelativePath,
    relativePathToKey,
} = require('../src/generators/incremental_graph/database');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

function makeTestCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-render-test-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { capabilities, tmpDir };
}

function collectFiles(dir, base = dir) {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const result = [];
    for (const entry of entries) {
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            result.push(...collectFiles(abs, base));
            continue;
        }
        result.push({
            relPath: path.relative(base, abs).split(path.sep).join('/'),
            content: fs.readFileSync(abs, 'utf8'),
        });
    }
    return result.sort((left, right) => left.relPath.localeCompare(right.relPath));
}

async function collectRawEntries(db) {
    const map = new Map();
    for await (const [key, value] of db._rawEntries()) {
        map.set(key, value);
    }
    return map;
}

describe('identifier-based snapshot encoding', () => {
    test('keyToRelativePath keeps plain keys for meta/global and single-segment identifiers for graph state', () => {
        expect(keyToRelativePath('!x!!global!version')).toBe('x/global/version');
        expect(keyToRelativePath('!x!!global!identifiers_keys_map')).toBe('x/global/identifiers_keys_map');
        expect(keyToRelativePath('!x!!values!nodecachex')).toBe('x/values/nodecachex');
        expect(keyToRelativePath('!x!!inputs!abcdefghi')).toBe('x/inputs/abcdefghi');
    });

    test('relativePathToKey round-trips identifier-addressed graph-state paths', () => {
        expect(relativePathToKey('x/values/nodecachex')).toBe('!x!!values!nodecachex');
        expect(relativePathToKey('x/revdeps/abcdefghi')).toBe('!x!!revdeps!abcdefghi');
        expect(relativePathToKey('x/global/identifiers_keys_map')).toBe('!x!!global!identifiers_keys_map');
    });

    test('identifier-addressed graph-state paths reject extra semantic segments', () => {
        expect(() => relativePathToKey('x/values/event/abc123')).toThrow(
            'identifier-key sublevels require exactly one key segment'
        );
    });

    test('key/path conversion is bijective for current identifier-addressed keys', () => {
        const keys = [
            '!_meta!current_replica',
            '!x!!global!version',
            '!x!!global!identifiers_keys_map',
            '!x!!values!nodecachex',
            '!x!!freshness!nodecachex',
            '!x!!inputs!nodecachex',
            '!x!!revdeps!abcdefghi',
            '!x!!counters!nodecachex',
            '!x!!timestamps!nodecachex',
        ];
        for (const key of keys) {
            expect(relativePathToKey(keyToRelativePath(key))).toBe(key);
        }
    });
});

describe('renderToFilesystem / scanFromFilesystem', () => {
    test('round-trips identifier-addressed graph state and identifiers_keys_map', async () => {
        const { capabilities, tmpDir } = makeTestCapabilities();
        const outputDir = path.join(tmpDir, 'rendered');
        fs.mkdirSync(outputDir, { recursive: true });

        const original = await getRootDatabase(capabilities);
        const expectedEntries = new Map([
            ['!_meta!current_replica', 'x'],
            ['!x!!global!version', '1.2.3'],
            ['!x!!global!identifiers_keys_map', [['nodecachex', '{"head":"event","args":["evt-1"]}']]],
            ['!x!!values!nodecachex', { items: [1, 2, 3] }],
            ['!x!!freshness!nodecachex', 'up-to-date'],
            ['!x!!inputs!nodecachex', { inputs: ['abcdefghi'], inputCounters: [7] }],
            ['!x!!revdeps!abcdefghi', ['nodecachex']],
            ['!x!!counters!nodecachex', 8],
            ['!x!!timestamps!nodecachex', {
                createdAt: '2026-01-01T00:00:00.000Z',
                modifiedAt: '2026-01-02T00:00:00.000Z',
            }],
        ]);

        try {
            for (const [key, value] of expectedEntries) {
                await original._rawPut(key, value);
            }

            await renderToFilesystem(capabilities, original, outputDir, 'x');
            const files = collectFiles(outputDir);
            const renderedPaths = files.map((file) => file.relPath);
            expect(renderedPaths).toEqual(expect.arrayContaining([
                'global/version',
                'global/identifiers_keys_map',
                'values/nodecachex',
                'inputs/nodecachex',
                'revdeps/abcdefghi',
            ]));

            const restored = await makeRootDatabase(capabilities, path.join(tmpDir, 'restored-db'));
            try {
                await scanFromFilesystem(capabilities, restored, outputDir, 'x');
                const restoredEntries = await collectRawEntries(restored);
                expect(restoredEntries).toEqual(expectedEntries);
            } finally {
                await restored.close();
            }
        } finally {
            await original.close();
        }
    });
});
