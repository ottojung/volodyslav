/**
 * Regression checks for cleanup: verifies banned terminology from
 * previous storage-shape remnants has been fully removed and does not
 * reappear in backend, docs, or scripts.
 */

const { execSync } = require('child_process');

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();

const EXCLUDE_GLOB = '--exclude=regression_cleanup.test.js';

function grepCount(pattern, paths) {
    try {
        const result = execSync(
            `grep -rn ${EXCLUDE_GLOB} "${pattern}" ${paths.join(' ')} 2>/dev/null | wc -l`,
            { encoding: 'utf-8', cwd: ROOT }
        );
        return parseInt(result.trim(), 10);
    } catch {
        return 0;
    }
}

describe('regression: banned terminology', () => {
    const SEARCH_PATHS = ['backend/src', 'backend/tests', 'docs', 'scripts'];

    const BANNED_PATTERNS = [
        'readInputRecord',
        'input_record',
        'inputsRecord',
        'InputsRecord',
        'inputCounters',
        'inputs record',
        'input record',
        'ensureMaterialized',
    ];

    for (const pattern of BANNED_PATTERNS) {
        test(`banned pattern "${pattern}" must not appear in backend, docs, or scripts`, () => {
            const count = grepCount(pattern, SEARCH_PATHS);
            expect(count).toBe(0);
        });
    }

    test('old object-shaped "{ inputs:" must not appear in stored inputs', () => {
        const count = grepCount('\\{ *inputs *:', SEARCH_PATHS);
        expect(count).toBe(0);
    });

    test('durable inputs sublevel access patterns must not appear in backend/src', () => {
        for (const pattern of ['storage\\.inputs', 'batch\\.inputs', 'getInputs']) {
            const count = grepCount(pattern, ['backend/src']);
            expect(count).toBe(0);
        }
    });

    test('graph_scheme constant-style template arg must not appear', () => {
        // Only match { kind: "const" ... } or {kind:'const'...} patterns
        const precise = execSync(
            'grep -rn ' + EXCLUDE_GLOB + " 'kind.*\"const\"\\|kind.*\\x27const\\x27' backend/src backend/tests docs 2>/dev/null | grep -v fixtures | grep -v rendered | wc -l",
            { encoding: 'utf-8', cwd: ROOT }
        );
        expect(parseInt(precise.trim(), 10)).toBe(0);
    });

    test('fake makeDatabase("inputs") must not appear in test helpers', () => {
        const count = grepCount('makeDatabase.*inputs', ['backend/tests']);
        expect(count).toBe(0);
    });
});
