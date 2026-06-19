/**
 * Regression checks for cleanup: verifies banned terminology from
 * previous storage-shape remnants has been fully removed and does not
 * reappear in backend, docs, or scripts.
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
 * @param {{ name: string, regex: RegExp }} pattern
 * @param {string[]} searchPaths
 * @returns {PatternMatch[]}
 */
function findMatches(pattern, searchPaths) {
    const matches = [];
    const files = searchPaths.flatMap(collectTextFiles);
    for (const filePath of files) {
        if (filePath === 'backend/tests/regression_cleanup.test.js') continue;
        const content = fs.readFileSync(path.join(ROOT, filePath), 'utf-8');
        const lines = content.split(/\r?\n/u);
        for (let index = 0; index < lines.length; index += 1) {
            pattern.regex.lastIndex = 0;
            if (pattern.regex.test(lines[index])) {
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

describe('regression: banned terminology', () => {
    const BANNED_PATTERNS = [
        { name: 'storage inputs API', regex: new RegExp('storage' + '\\.' + 'inputs', 'u') },
        { name: 'batch inputs API', regex: new RegExp('batch' + '\\.' + 'inputs', 'u') },
        { name: 'inputs get API', regex: new RegExp('\\.' + 'inputs' + '\\.' + 'get', 'u') },
        { name: 'inputs put API', regex: new RegExp('\\.' + 'inputs' + '\\.' + 'put', 'u') },
        { name: 'inputs keys API', regex: new RegExp('\\.' + 'inputs' + '\\.' + 'keys', 'u') },
        { name: 'materialization compatibility helper', regex: new RegExp('ensure' + 'Materialized', 'u') },
        { name: 'input compatibility getter', regex: new RegExp('get' + 'Inputs', 'u') },
        { name: 'inputs database factory', regex: new RegExp("makeDatabase" + "\\([\"']" + "inputs" + "[\"']\\)", "u") },
        { name: 'semantic batch inputs API', regex: new RegExp('semanticBatch' + '\\.' + 'inputs', 'u') },
        { name: 'const-kind template argument', regex: new RegExp("kind:" + "\\s*" + "[\"']" + "const" + "[\"']", "u") },
        { name: 'constant dependency argument', regex: new RegExp('constant ' + 'input(?: argument| edge| template| graph| record)?', 'iu') },
        { name: 'const dependency argument', regex: new RegExp('const ' + 'input(?: argument| edge| template| graph| record)', 'iu') },
        { name: 'graph scheme template arg type', regex: new RegExp('GraphScheme' + 'TemplateArg', 'u') },
        { name: 'value based template wording', regex: new RegExp('value-based ' + 'template', 'u') },
        { name: 'template arg object wording', regex: new RegExp('template arg ' + 'object', 'u') },
        { name: 'record empty dependency stub', regex: /record = \[\]/u },
        { name: 'depRecord empty dependency stub', regex: /depRecord = \[\]/u },
        { name: 'storedInputEdges empty dependency stub', regex: /storedInputEdges = \[\]/u },
        { name: 'persistedInputEdges empty dependency stub', regex: /persistedInputEdges = \[\]/u },
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
