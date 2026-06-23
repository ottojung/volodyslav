const fs = require('fs');
const path = require('path');

const repoRoot = path.join(__dirname, '..', '..');
const scannedRoots = ['backend', 'docs', 'scripts'];

function allFiles(root) {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        if (entry.name === 'node_modules' || entry.name === '.git') {
            continue;
        }
        const entryPath = path.join(root, entry.name);
        if (entry.isDirectory()) {
            files.push(...allFiles(entryPath));
        } else if (entry.isFile()) {
            files.push(entryPath);
        }
    }
    return files;
}

describe('repository cleanup regressions', () => {
    test('legacy persisted dependency-shape terms stay absent', () => {
        const banned = [
            'read' + 'InputRecord',
            'input' + '_record',
            'inputs' + 'Record',
            'Inputs' + 'Record',
            'input' + 'Counters',
            'inputs' + ' record',
            'input' + ' record',
        ];
        const matches = [];
        for (const rootName of scannedRoots) {
            const root = path.join(repoRoot, rootName);
            if (!fs.existsSync(root)) {
                continue;
            }
            for (const filePath of allFiles(root)) {
                const content = fs.readFileSync(filePath, 'utf8');
                for (const term of banned) {
                    if (content.includes(term)) {
                        matches.push(`${path.relative(repoRoot, filePath)} contains ${term}`);
                    }
                }
            }
        }
        expect(matches).toEqual([]);
    });
});
