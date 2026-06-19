/**
 * Regression guard: the incremental graph's persisted graph-state model
 * does not include a `counters` sublevel.
 *
 * The persisted sublevels are: values, freshness, inputs, valid,
 * timestamps, global.
 *
 * Asserting cache correctness with counter semantics (e.g. "incrementing
 * the value counter", "writes new counter", "counter unchanged") is
 * forbidden.  Allowed: ordinary English "counter" for unrelated concepts
 * such as call-counting test helpers, NodeIdentifier allocation index,
 * or audio recording fragment counters.
 */

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');

const ROOT = execSync('git rev-parse --show-toplevel', { encoding: 'utf-8' }).trim();
const SEARCH_PATHS = ['backend/src', 'backend/tests', 'docs', 'scripts'];
const SKIPPED_DIRS = new Set(['node_modules', 'fixtures', 'rendered', 'dist', 'build', 'coverage']);

/**
 * @typedef {object} PatternMatch
 * @property {string} filePath
 * @property {number} lineNumber
 * @property {string} line
 * @property {string} patternName
 */

/**
 * @param {string} filePath
 * @returns {boolean}
 */
function isTextFile(filePath) {
    const extension = path.extname(filePath);
    if (extension === '') return true;
    return new Set(['.js', '.json', '.md', '.txt', '.sh', '.yml', '.yaml', '.html', '.css']).has(extension);
}

/**
 * @param {string} relativePath
 * @returns {string[]}
 */
function collectTextFiles(relativePath) {
    const absolutePath = path.join(ROOT, relativePath);
    if (!fs.existsSync(absolutePath)) return [];
    const stat = fs.statSync(absolutePath);
    if (stat.isFile()) return isTextFile(absolutePath) ? [relativePath] : [];

    const files = [];
    for (const entry of fs.readdirSync(absolutePath, { withFileTypes: true })) {
        if (entry.isDirectory() && SKIPPED_DIRS.has(entry.name)) continue;
        files.push(...collectTextFiles(path.join(relativePath, entry.name)));
    }
    return files;
}

/**
 * @param {string} filePath
 * @param {number} lineNumber
 * @returns {boolean}
 */
function isAllowlisted(filePath, lineNumber) {
    // Allowlist: docs/diary.md line 161 is about audio recording session
    // fragment assembly counters, not graph-state value counters.
    if (filePath.endsWith('docs/diary.md') && lineNumber === 161) return true;

    // Allowlist: docs/specs/keys-design.md lines about NodeIdentifier
    // monotonic allocation counter — unrelated to graph-state value counter.
    if (filePath.endsWith('docs/specs/keys-design.md') && lineNumber === 129) return true;

    // Allowlist: the regression test file itself.
    if (filePath.endsWith('backend/tests/incremental_graph_no_counters.test.js')) return true;

    // Allowlist: reference to the deleted counters test file.
    if (filePath.endsWith('backend/tests/regression_cleanup.test.js')) return false;

    // Allowlist: incremental_graph.test.js or incremental_graph_spec.test.js
    // may reference the old test file in a comment.
    return false;
}

/**
 * @param {{ name: string, regex: RegExp }} pattern
 * @param {string[]} searchPaths
 * @returns {PatternMatch[]}
 */
function findMatches(pattern, searchPaths) {
    const matches = [];
    const files = searchPaths.flatMap(collectTextFiles);
    for (const filePath of files) {
        const content = fs.readFileSync(path.join(ROOT, filePath), 'utf-8');
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
            pattern.regex.lastIndex = 0;
            if (pattern.regex.test(lines[index])) {
                if (isAllowlisted(filePath, index + 1)) continue;
                matches.push({
                    filePath,
                    lineNumber: index + 1,
                    line: lines[index],
                    patternName: pattern.name,
                });
            }
        }
    }
    return matches;
}

/**
 * @param {PatternMatch[]} matches
 * @returns {string}
 */
function formatMatches(matches) {
    return matches
        .map((match) => `${match.filePath}:${match.lineNumber} ${match.patternName}: ${match.line.trim()}`)
        .join('\n');
}

describe('no-counters regression guard', () => {
    const BANNED_PATTERNS = [
        { name: 'graph-state counters', regex: /\bcounters\b/u },
    ];

    for (const pattern of BANNED_PATTERNS) {
        test(`banned pattern "${pattern.name}" must not appear in backend, docs, or scripts`, () => {
            const matches = findMatches(pattern, SEARCH_PATHS);
            if (matches.length !== 0) {
                throw new Error(formatMatches(matches));
            }
            expect(matches).toHaveLength(0);
        });
    }
});
