const path = require('path');
const fs = require('fs');
const os = require('os');
const {
    getRootDatabase,
    renderSublevelToSnapshot,
    scanSublevelFromSnapshot,
    isMissingKindtreeRootError,
    isExtraRenderedFileError,
} = require('../src/generators/incremental_graph/database');
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
    test('renders and scans one complete value through sibling trees', async () => {
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

    test('authoritative rerender resolves scalar and compound shape conflicts', async () => {
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

    test('scan rejects unclaimed rendered files before DB mutation', async () => {
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

    test('scan rejects rendered-only legacy snapshots', async () => {
        const { capabilities, tmpDir } = makeCapabilities();
        const db = await getRootDatabase(capabilities);
        try {
            fs.mkdirSync(path.join(tmpDir, 'rendered/r/values'), { recursive: true });
            fs.writeFileSync(path.join(tmpDir, 'rendered/r/values/node'), '{"legacy":true}');
            const error = await captureRejection(() => scanSublevelFromSnapshot(capabilities, db, { snapshotRoot: tmpDir, targetSublevel: 'y', snapshotSublevel: 'r' }));
            expect(isMissingKindtreeRootError(error)).toBe(true);
        } finally { await db.close(); fs.rmSync(tmpDir, { recursive: true, force: true }); }
    });
});
