const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    getRootDatabase,
    renderSublevelToSnapshot,
    scanSublevelFromSnapshot,
    renderToFilesystem,
    scanFromFilesystem,
    isMissingKindtreeRootError,
    isExtraRenderedFileError,
    isScanInputDirMissingError,
} = require('../src/generators/incremental_graph/database');
const {
    isDuplicateDecodedValueRootError,
} = require('../src/generators/incremental_graph/database/render');
const { getMockedRootCapabilities } = require('./spies');
const { stubLogger, stubEnvironment } = require('./stubs');

function makeCapabilities() {
    const capabilities = getMockedRootCapabilities();
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'exploded-snapshot-'));
    stubLogger(capabilities);
    stubEnvironment(capabilities);
    return { capabilities, tmpDir };
}

async function captureRejection(callback) {
    try { await callback(); } catch (error) { return error; }
    return undefined;
}

async function readRaw(db, key) {
    const marker = key.indexOf('!', 1);
    const sublevel = key.slice(1, marker);
    return await db._rawGetInSublevel(sublevel, key.slice(marker + 1));
}

describe('paired exploded JSON snapshots', () => {
    test('[19.5-1/19.6-1] renders and scans one complete value through sibling trees', async () => {
        const { capabilities, tmpDir } = makeCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            await db._rawPut('!x!!values!node', { text: 'hello', flags: [true, null], empty: {} });
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: tmpDir, sourceSublevel: 'x', snapshotSublevel: 'r' });
            expect(fs.readFileSync(path.join(tmpDir, 'kindtree/r/values/node'), 'utf8')).toContain('"text": "string"');
            expect(fs.readFileSync(path.join(tmpDir, 'rendered/r/values/node/text'), 'utf8')).toBe('hello');
            expect(fs.existsSync(path.join(tmpDir, 'rendered/r/values/node/empty'))).toBe(false);
            await scanSublevelFromSnapshot(capabilities, db, { snapshotRoot: tmpDir, targetSublevel: 'y', snapshotSublevel: 'r' });
            expect(await readRaw(db, '!y!!values!node')).toEqual({ empty: {}, flags: [true, null], text: 'hello' });
        } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    test('[19.5-15/16/17/18/19/20] authoritative rerender resolves scalar and compound shape conflicts', async () => {
        const { capabilities, tmpDir } = makeCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            await db._rawPut('!x!!values!node', 'scalar');
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: tmpDir, sourceSublevel: 'x', snapshotSublevel: 'r' });
            await db._rawPut('!x!!values!node', { child: 'leaf' });
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: tmpDir, sourceSublevel: 'x', snapshotSublevel: 'r' });
            expect(fs.statSync(path.join(tmpDir, 'rendered/r/values/node')).isDirectory()).toBe(true);
            expect(fs.readFileSync(path.join(tmpDir, 'rendered/r/values/node/child'), 'utf8')).toBe('leaf');
            await db._rawPut('!x!!values!node', []);
            await renderSublevelToSnapshot(capabilities, db, { snapshotRoot: tmpDir, sourceSublevel: 'x', snapshotSublevel: 'r' });
            expect(fs.existsSync(path.join(tmpDir, 'rendered/r/values/node'))).toBe(false);
        } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    test('[19.3-25] scan rejects unclaimed rendered files before DB mutation', async () => {
        const { capabilities, tmpDir } = makeCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            fs.mkdirSync(path.join(tmpDir, 'kindtree/r/values'), { recursive: true });
            fs.mkdirSync(path.join(tmpDir, 'rendered/r/values/node'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'kindtree/r/values/node'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'rendered/r/values/node/extra'), 'stale');
            const error = await captureRejection(() => scanSublevelFromSnapshot(capabilities, db, { snapshotRoot: tmpDir, targetSublevel: 'y', snapshotSublevel: 'r' }));
            expect(isExtraRenderedFileError(error)).toBe(true);
        } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    test('scan rejects rendered-only legacy snapshots (missing kindtree root)', async () => {
        const { capabilities, tmpDir } = makeCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            fs.mkdirSync(path.join(tmpDir, 'rendered/r/values'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'rendered/r/values/node'), '{"legacy":true}');
            const error = await captureRejection(() => scanSublevelFromSnapshot(capabilities, db, { snapshotRoot: tmpDir, targetSublevel: 'y', snapshotSublevel: 'r' }));
            expect(isMissingKindtreeRootError(error)).toBe(true);
        } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    test('[19.7-12] duplicate schema paths that decode to the same raw key are rejected', async () => {
        const { capabilities, tmpDir } = makeCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            fs.mkdirSync(path.join(tmpDir, 'kindtree/r/values'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'kindtree/r/values/a%2Fb'), '{}');
            fs.writeFileSync(path.join(tmpDir, 'kindtree/r/values/a%2fb'), '{}');
            const error = await captureRejection(() => scanSublevelFromSnapshot(capabilities, db, { snapshotRoot: tmpDir, targetSublevel: 'y', snapshotSublevel: 'r' }));
            expect(isDuplicateDecodedValueRootError(error)).toBe(true);
        } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });

    describe('compatibility API (renderToFilesystem / scanFromFilesystem)', () => {
        test('renderToFilesystem writes under the exact snapshot root', async () => {
            const { capabilities, tmpDir } = makeCapabilities();
            const db = await getRootDatabase(capabilities);
            try {
                const snapshotRoot = path.join(tmpDir, 'snapshot');
                await db._rawPut('!x!!values!node', { text: 'hello' });
                await renderToFilesystem(capabilities, db, snapshotRoot, 'x');

                expect(fs.existsSync(path.join(snapshotRoot, 'kindtree/x/values/node'))).toBe(true);
                expect(fs.existsSync(path.join(snapshotRoot, 'rendered/x/values/node/text'))).toBe(true);

                expect(fs.existsSync(path.join(tmpDir, 'kindtree'))).toBe(false);
                expect(fs.existsSync(path.join(tmpDir, 'rendered'))).toBe(false);
            } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
        });

        test('scanFromFilesystem reads from the exact snapshot root', async () => {
            const { capabilities, tmpDir } = makeCapabilities();
            const db = await getRootDatabase(capabilities);
            try {
                const snapshotRoot = path.join(tmpDir, 'snapshot');
                fs.mkdirSync(path.join(snapshotRoot, 'kindtree/x/values'), { recursive: true });
                fs.mkdirSync(path.join(snapshotRoot, 'rendered/x/values/node'), { recursive: true });
                fs.writeFileSync(path.join(snapshotRoot, 'kindtree/x/values/node'), '{"text": "string"}');
                fs.writeFileSync(path.join(snapshotRoot, 'rendered/x/values/node/text'), 'world');

                await scanFromFilesystem(capabilities, db, snapshotRoot, 'x');
                expect(await readRaw(db, '!x!!values!node')).toEqual({ text: 'world' });
            } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
        });

        test('round-trip through compatibility API', async () => {
            const { capabilities, tmpDir } = makeCapabilities();
            const db = await getRootDatabase(capabilities);
            try {
                const snapshotRoot = path.join(tmpDir, 'snapshot');
                await db._rawPut('!x!!values!node', { value: 42 });
                await renderToFilesystem(capabilities, db, snapshotRoot, 'x');

                await db._rawDel('!x!!values!node');
                expect(await readRaw(db, '!x!!values!node')).toBeUndefined();

                await scanFromFilesystem(capabilities, db, snapshotRoot, 'x');
                expect(await readRaw(db, '!x!!values!node')).toEqual({ value: 42 });
            } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
        });

        test('empty snapshot rendering does not break later scan', async () => {
            const { capabilities, tmpDir } = makeCapabilities();
            const db = await getRootDatabase(capabilities);
            try {
                const snapshotRoot = path.join(tmpDir, 'snapshot');
                fs.mkdirSync(snapshotRoot, { recursive: true });
                await renderToFilesystem(capabilities, db, snapshotRoot, 'y');
                expect(fs.existsSync(path.join(snapshotRoot, 'kindtree/y'))).toBe(false);
                expect(fs.existsSync(path.join(snapshotRoot, 'rendered/y'))).toBe(false);
                await scanFromFilesystem(capabilities, db, snapshotRoot, 'y');
            } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
        });

        test('scanFromFilesystem throws when snapshotRoot is missing', async () => {
            const { capabilities, tmpDir } = makeCapabilities();
            const db = await getRootDatabase(capabilities);
            try {
                const missingRoot = path.join(tmpDir, 'nonexistent');
                const error = await captureRejection(() => scanFromFilesystem(capabilities, db, missingRoot, 'x'));
                expect(isScanInputDirMissingError(error)).toBe(true);
            } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
        });
    });
});
