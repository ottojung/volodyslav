const {
    projectExplodedJsonValue,
    scanExplodedJsonProjection,
    isUnsupportedRenderedValueError,
    isCycleInRenderedValueError,
    isSparseArrayRenderedValueError,
    isNonPlainObjectRenderedValueError,
} = require('../src/generators/incremental_graph/database/render');

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function captureError(callback) {
    try { callback(); } catch (error) { return error; }
    return undefined;
}

function roundTrip(value) {
    const projection = projectExplodedJsonValue(value);
    const leaves = new Map(projection.leaves.map((leaf) => [leaf.descendantPath, leaf.content]));
    return scanExplodedJsonProjection(projection.schema, (descendantPath) => leaves.get(descendantPath));
}

describe('exploded JSON value codec', () => {
    test.each([
        ['string scalar', 'hello'],
        ['empty string', ''],
        ['whitespace-preserving string', '  hello\t '],
        ['multiline string with final newline', 'first\nsecond\n'],
        ['numeric-looking string', '5'],
        ['null-looking string', 'null'],
        ['true-looking string', 'true'],
        ['false-looking string', 'false'],
        ['JSON-looking string', '{"value":5}'],
        ['integer', 5],
        ['decimal', 1.5],
        ['zero', 0],
        ['negative number', -12.25],
        ['exponent-valued number', 1e20],
        ['root true', true],
        ['root false', false],
        ['null', null],
        ['flat object', { name: 'event', count: 2, enabled: true, missing: null }],
        ['nested object', { outer: { inner: 'leaf' } }],
        ['deeply nested object and array', { a: [{ b: [null, false, { c: 3 }] }] }],
        ['root empty object', {}],
        ['root empty array', []],
        ['empty object property', { empty: {} }],
        ['empty array property', { empty: [] }],
        ['array element empty object', [{}]],
        ['array element empty array', [[]]],
        ['object containing primitive-free compounds', { object: {}, array: [], nested: { empty: [] } }],
        ['array containing primitive-free compounds', [{}, [], { nested: {} }]],
        ['numeric object keys', { 0: 'zero', 1: 'one' }],
        ['dangerous keys', { '': 0, '/': 1, '%': 2, '!': 3, '.': 4, '..': 5 }],
        ['escape-looking keys remain distinct', { '/': 1, '%2F': 2, '.': 3, '%2E': 4, '': 5, '%00': 6 }],
        ['ordinary tree-like names', { items: 1, rendered: 2, kindtree: 3 }],
        ['boolean object properties', { yes: true, no: false }],
        ['boolean array elements', [true, false]],
        ['array index ten', Array.from({ length: 11 }, (_, index) => index)],
    ])('%s round trips', (_name, value) => {
        expect(roundTrip(value)).toEqual(value);
    });

    test('opposite object insertion orders produce byte-identical canonical output', () => {
        const first = projectExplodedJsonValue({ zebra: 1, alpha: { z: false, a: true } });
        const second = projectExplodedJsonValue({ alpha: { a: true, z: false }, zebra: 1 });
        expect(first.schemaText).toBe(second.schemaText);
        expect(first.leaves).toEqual(second.leaves);
    });

    test('negative zero renders canonically as zero', () => {
        expect(projectExplodedJsonValue(-0).leaves).toEqual([{ descendantPath: '', content: '0' }]);
    });

    test.each([
        ['undefined root', undefined, isUnsupportedRenderedValueError],
        ['NaN', NaN, isUnsupportedRenderedValueError],
        ['Infinity', Infinity, isUnsupportedRenderedValueError],
        ['negative Infinity', -Infinity, isUnsupportedRenderedValueError],
        ['bigint', BigInt(1), isUnsupportedRenderedValueError],
        ['function', () => undefined, isUnsupportedRenderedValueError],
        ['symbol', Symbol('value'), isUnsupportedRenderedValueError],
        ['class instance', new (class Example {})(), isNonPlainObjectRenderedValueError],
        ['Date-like instance', Object.create(Date.prototype), isNonPlainObjectRenderedValueError],
        ['Buffer', Buffer.from('value'), isNonPlainObjectRenderedValueError],
        ['Map', new Map([['key', 'value']]), isNonPlainObjectRenderedValueError],
        ['Set', new Set(['value']), isNonPlainObjectRenderedValueError],
    ])('rejects %s', (_name, value, guard) => {
        const error = captureError(() => projectExplodedJsonValue(value));
        expect(guard(error)).toBe(true);
    });

    test.each([
        ['undefined property', { value: undefined }],
        ['undefined array element', [undefined]],
        ['function property', { value: () => undefined }],
        ['symbol property', { value: Symbol('value') }],
    ])('rejects %s', (_name, value) => {
        const error = captureError(() => projectExplodedJsonValue(value));
        expect(isUnsupportedRenderedValueError(error)).toBe(true);
    });

    test('rejects sparse arrays specifically', () => {
        const value = [];
        value[2] = 'third';
        const error = captureError(() => projectExplodedJsonValue(value));
        expect(isSparseArrayRenderedValueError(error)).toBe(true);
    });

    test.each([
        ['cyclic object', () => { const value = {}; value.self = value; return value; }],
        ['cyclic array', () => { const value = []; value.push(value); return value; }],
    ])('rejects %s specifically', (_name, makeValue) => {
        const error = captureError(() => projectExplodedJsonValue(makeValue()));
        expect(isCycleInRenderedValueError(error)).toBe(true);
    });

    test('rejects accessor-driven objects', () => {
        const value = {};
        Object.defineProperty(value, 'field', { enumerable: true, get: () => 'value' });
        const error = captureError(() => projectExplodedJsonValue(value));
        expect(isNonPlainObjectRenderedValueError(error)).toBe(true);
    });

    test('rejects symbol-keyed semantic data', () => {
        const error = captureError(() => projectExplodedJsonValue({ [Symbol('field')]: 'value' }));
        expect(isNonPlainObjectRenderedValueError(error)).toBe(true);
    });

    test('rejects non-plain records', () => {
        const error = captureError(() => projectExplodedJsonValue(Object.create(null)));
        expect(isNonPlainObjectRenderedValueError(error)).toBe(true);
    });
});
