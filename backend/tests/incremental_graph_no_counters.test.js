const fs = require('fs');
const path = require('path');

const REPOSITORY_ROOT = path.resolve(__dirname, '..', '..');
const SCANNED_PATHS = [
    'backend/src/generators/incremental_graph',
    'docs/specs/incremental-graph.md',
    'docs/specs/incremental-graph-flag-based-inverse-validity.md',
    'docs/specs/incremental-graph-volatile-consistency.md',
    'docs/database.md',
];
const ALLOWED_FILES = new Set([
    path.join('backend', 'src', 'generators', 'incremental_graph', 'expr.js'),
]);

function* walkFiles(relativePath) {
    const absolutePath = path.join(REPOSITORY_ROOT, relativePath);
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) {
        yield relativePath;
        return;
    }
    for (const entry of fs.readdirSync(absolutePath)) {
        const child = path.join(relativePath, entry);
        const childStat = fs.statSync(path.join(REPOSITORY_ROOT, child));
        if (childStat.isDirectory()) {
            yield* walkFiles(child);
        } else {
            yield child;
        }
    }
}

describe('incremental graph persisted schema', () => {
    test('does not expose a counters sublevel', () => {
        const offenders = [];
        for (const scannedPath of SCANNED_PATHS) {
            for (const file of walkFiles(scannedPath)) {
                if (ALLOWED_FILES.has(file)) continue;
                const text = fs.readFileSync(path.join(REPOSITORY_ROOT, file), 'utf8');
                if (/\bcounters\b|storage\.counters|\.counters|node counter|increment counter/i.test(text)) {
                    offenders.push(file);
                }
            }
        }
        expect(offenders).toEqual([]);
    });
});
