const {
    projectExplodedJsonValue,
    scanExplodedJsonProjection,
    parseTypeSchema,
    formatTypeSchema,
    isUnsupportedRenderedValueError,
    isCycleInRenderedValueError,
    isSparseArrayRenderedValueError,
    isNonPlainObjectRenderedValueError,
    isTypeSchemaError,
    isDuplicateMemberNameError,
    isRenderedLeafError,
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
    describe('[19.1] codec and rendering: positive cases', () => {
        test.each([
            ['[19.1-1] string scalar', 'hello'],
            ['[19.1-2] empty string', ''],
            ['[19.1-3] whitespace-preserving string', '  hello\t '],
            ['[19.1-4] multiline string with final newline', 'first\nsecond\n'],
            ['[19.1-5] numeric-looking string ("5")', '5'],
            ['[19.1-5] null-looking string ("null")', 'null'],
            ['[19.1-5] true-looking string', 'true'],
            ['[19.1-5] false-looking string', 'false'],
            ['[19.1-5] JSON-looking string', '{"value":5}'],
            ['[19.1-6] integer', 5],
            ['[19.1-6] decimal', 1.5],
            ['[19.1-6] zero', 0],
            ['[19.1-6] negative number', -12.25],
            ['[19.1-6] exponent-valued number', 1e20],
            ['[19.1-7] root true', true],
            ['[19.1-8] root false', false],
            ['[19.1-9] boolean object properties', { yes: true, no: false }],
            ['[19.1-10] boolean array elements', [true, false]],
            ['[19.1-11] null', null],
            ['[19.1-12] flat object', { name: 'event', count: 2, enabled: true, missing: null }],
            ['[19.1-12] nested object', { outer: { inner: 'leaf' } }],
            ['[19.1-12] deeply nested object and array', { a: [{ b: [null, false, { c: 3 }] }] }],
            ['[19.1-13] root empty object', {}],
            ['[19.1-14] root empty array', []],
            ['[19.1-15] empty object property', { empty: {} }],
            ['[19.1-16] empty array property', { empty: [] }],
            ['[19.1-17] array element empty object', [{}]],
            ['[19.1-18] array element empty array', [[]]],
            ['[19.1-19] object containing primitive-free compounds', { object: {}, array: [], nested: { empty: [] } }],
            ['[19.1-20] array containing primitive-free compounds', [{}, [], { nested: {} }]],
            ['[19.1-23] numeric object keys (0 and 1)', { 0: 'zero', 1: 'one' }],
            ['[19.1-24] dangerous keys (/, %, !, ., .., empty)', { '': 0, '/': 1, '%': 2, '!': 3, '.': 4, '..': 5 }],
            ['[19.1-25] escape-looking keys remain distinct', { '/': 1, '%2F': 2, '.': 3, '%2E': 4, '': 5, '%00': 6 }],
            ['[19.1-26] ordinary tree-like names', { items: 1, rendered: 2, kindtree: 3 }],
            ['[19.1-28] array index ten', Array.from({ length: 11 }, (_, index) => index)],
        ])('%s round trips', (_name, value) => {
            expect(roundTrip(value)).toEqual(value);
        });

        test('[19.1-21] deeply nested empty compounds with no primitive leaves have schema but no rendered files', () => {
            const projection = projectExplodedJsonValue({ a: { b: { c: [] } } });
            expect(projection.leaves).toEqual([]);
        });

        test('[19.1-22] compound with both primitive and primitive-free children renders only the primitive descendants', () => {
            const projection = projectExplodedJsonValue({
                name: 'test',
                empty: {},
                nested: { x: 1, empty: [] },
            });
            const leafPaths = projection.leaves.map((l) => l.descendantPath);
            expect(leafPaths).toContain('name');
            expect(leafPaths).toContain('nested/x');
            expect(leafPaths).not.toContain('empty');
            expect(leafPaths).not.toContain('nested/empty');
        });

        test('[19.1-27] opposite object insertion orders produce byte-identical canonical output', () => {
            const first = projectExplodedJsonValue({ zebra: 1, alpha: { z: false, a: true } });
            const second = projectExplodedJsonValue({ alpha: { a: true, z: false }, zebra: 1 });
            expect(first.schemaText).toBe(second.schemaText);
            expect(first.leaves).toEqual(second.leaves);
        });

        test('[19.1-29] _meta/current_replica and r/global/version use same projection rules as other DB entries', () => {
            const metaProj = projectExplodedJsonValue('r');
            const versionProj = projectExplodedJsonValue('3');
            expect(metaProj.schema).toBe('string');
            expect(versionProj.schema).toBe('string');
            expect(metaProj.leaves).toEqual([{ descendantPath: '', content: 'r' }]);
            expect(versionProj.leaves).toEqual([{ descendantPath: '', content: '3' }]);
        });

        test('negative zero renders canonically as zero', () => {
            expect(projectExplodedJsonValue(-0).leaves).toEqual([{ descendantPath: '', content: '0' }]);
        });
    });

    describe('[19.2] rendering: unsupported source values', () => {
        test.each([
            ['[19.2-1] undefined root', undefined, isUnsupportedRenderedValueError],
            ['[19.2-2] NaN', NaN, isUnsupportedRenderedValueError],
            ['[19.2-2] Infinity', Infinity, isUnsupportedRenderedValueError],
            ['[19.2-2] negative Infinity', -Infinity, isUnsupportedRenderedValueError],
            ['[19.2-3] bigint', BigInt(1), isUnsupportedRenderedValueError],
            ['[19.2-3] function', () => undefined, isUnsupportedRenderedValueError],
            ['[19.2-3] symbol', Symbol('value'), isUnsupportedRenderedValueError],
            ['[19.2-6] class instance', new (class Example {})(), isNonPlainObjectRenderedValueError],
            ['[19.2-7] Date-like instance', Object.create(Date.prototype), isNonPlainObjectRenderedValueError],
            ['[19.2-7] Buffer', Buffer.from('value'), isNonPlainObjectRenderedValueError],
            ['[19.2-7] Map', new Map([['key', 'value']]), isNonPlainObjectRenderedValueError],
            ['[19.2-7] Set', new Set(['value']), isNonPlainObjectRenderedValueError],
        ])('[19.2] rejects %s', (_name, value, guard) => {
            const error = captureError(() => projectExplodedJsonValue(value));
            expect(guard(error)).toBe(true);
        });

        test.each([
            ['[19.2-1] undefined property', { value: undefined }],
            ['[19.2-1] undefined array element', [undefined]],
            ['[19.2-3] function property', { value: () => undefined }],
            ['[19.2-3] symbol property', { value: Symbol('value') }],
        ])('[19.2] rejects %s', (_name, value) => {
            const error = captureError(() => projectExplodedJsonValue(value));
            expect(isUnsupportedRenderedValueError(error)).toBe(true);
        });

        test('[19.2-4] rejects sparse arrays specifically', () => {
            const value = [];
            value[2] = 'third';
            const error = captureError(() => projectExplodedJsonValue(value));
            expect(isSparseArrayRenderedValueError(error)).toBe(true);
        });

        test.each([
            ['[19.2-5] cyclic object', () => { const value = {}; value.self = value; return value; }],
            ['[19.2-5] cyclic array', () => { const value = []; value.push(value); return value; }],
        ])('[19.2] rejects %s', (_name, makeValue) => {
            const error = captureError(() => projectExplodedJsonValue(makeValue()));
            expect(isCycleInRenderedValueError(error)).toBe(true);
        });

        test('[19.2-8] rejects accessor-driven objects', () => {
            const value = {};
            Object.defineProperty(value, 'field', { enumerable: true, get: () => 'value' });
            const error = captureError(() => projectExplodedJsonValue(value));
            expect(isNonPlainObjectRenderedValueError(error)).toBe(true);
        });

        test('[19.2-9] rejects symbol-keyed semantic data', () => {
            const error = captureError(() => projectExplodedJsonValue({ [Symbol('field')]: 'value' }));
            expect(isNonPlainObjectRenderedValueError(error)).toBe(true);
        });

        test('[19.2-10] rejects non-plain records', () => {
            const error = captureError(() => projectExplodedJsonValue(Object.create(null)));
            expect(isNonPlainObjectRenderedValueError(error)).toBe(true);
        });
    });

    describe('[19.3] codec and scanning: validation cases', () => {
        describe('missing required rendered leaf (19.3-1 to 4)', () => {
            test('[19.3-1] schema "string" requires a file but rendered path is missing', () => {
                const error = captureError(() => scanExplodedJsonProjection('string', () => undefined));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test('[19.3-2] schema "number" requires a file but rendered path is missing', () => {
                const error = captureError(() => scanExplodedJsonProjection('number', () => undefined));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test('[19.3-3] schema "boolean" requires a file but rendered path is missing', () => {
                const error = captureError(() => scanExplodedJsonProjection('boolean', () => undefined));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test('[19.3-4] schema "null" requires a file but rendered path is missing', () => {
                const error = captureError(() => scanExplodedJsonProjection('null', () => undefined));
                expect(isRenderedLeafError(error)).toBe(true);
            });
        });

        describe('invalid scalar content (19.3-9 to 11)', () => {
            test.each([
                ['TRUE', 'TRUE'],
                ['False', 'False'],
                ['1', '1'],
                ['0', '0'],
                ['leading space ( false)', ' false'],
                ['trailing space (true )', 'true '],
            ])('[19.3-9] boolean file contains %s', (_name, content) => {
                const error = captureError(() => scanExplodedJsonProjection('boolean', () => content));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test.each([
                ['trailing newline true', 'true\n'],
                ['trailing newline false', 'false\n'],
            ])('[19.3-9] boolean file contains %s: rejected', (_name, content) => {
                const error = captureError(() => scanExplodedJsonProjection('boolean', () => content));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test.each([
                ['non-number text', 'abc'],
                ['trailing garbage after number', '5abc'],
                ['multiple tokens', '5 3'],
                ['leading whitespace', ' 5'],
                ['trailing whitespace', '5 '],
                ['NaN', 'NaN'],
                ['Infinity', 'Infinity'],
                ['JSON string syntax', '"5"'],
                ['empty string', ''],
            ])('[19.3-10] number file contains %s', (_name, content) => {
                const error = captureError(() => scanExplodedJsonProjection('number', () => content));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test('[19.3-10] number file contains trailing newline', () => {
                const error = captureError(() => scanExplodedJsonProjection('number', () => '5\n'));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test.each([
                ['empty file', ''],
                ['NULL', 'NULL'],
                ['leading space', ' null'],
                ['trailing space', 'null '],
            ])('[19.3-11] null file contains %s', (_name, content) => {
                const error = captureError(() => scanExplodedJsonProjection('null', () => content));
                expect(isRenderedLeafError(error)).toBe(true);
            });

            test('[19.3-11] null file contains trailing newline', () => {
                const error = captureError(() => scanExplodedJsonProjection('null', () => 'null\n'));
                expect(isRenderedLeafError(error)).toBe(true);
            });
        });

        describe('type-schema validation (19.3-12 to 17)', () => {
            test('[19.3-12] type schema contains unknown token "undefined"', () => {
                const error = captureError(() => parseTypeSchema('"undefined"'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-13] type schema uses "object" instead of structural shape', () => {
                const error = captureError(() => parseTypeSchema('"object"'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-13] type schema uses "array" instead of structural shape', () => {
                const error = captureError(() => parseTypeSchema('"array"'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-14] type schema contains literal JSON null where a schema is expected', () => {
                const error = captureError(() => parseTypeSchema('null'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-14] type schema contains literal JSON number where a schema is expected', () => {
                const error = captureError(() => parseTypeSchema('5'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-14] type schema contains literal JSON true where a schema is expected', () => {
                const error = captureError(() => parseTypeSchema('true'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-14] type schema contains literal JSON false where a schema is expected', () => {
                const error = captureError(() => parseTypeSchema('false'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-15] type-schema JSON is malformed', () => {
                const error = captureError(() => parseTypeSchema('{invalid}'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-15] type-schema JSON has trailing data', () => {
                const error = captureError(() => parseTypeSchema('"string" "extra"'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-16] type-schema JSON object contains duplicate member names at root level: invalid', () => {
                const error = captureError(() => parseTypeSchema('{"a": "string", "a": "number"}'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-16] type-schema JSON root array with duplicate member names inside: invalid', () => {
                const error = captureError(() => parseTypeSchema('[{"a": "string", "a": "number"}]'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-16] type-schema JSON nested array in object with duplicate member names: invalid', () => {
                const error = captureError(() => parseTypeSchema('{"outer": [{"a": "string", "a": "number"}]}'));
                expect(isTypeSchemaError(error)).toBe(true);
            });

            test('[19.3-16] type-schema JSON member names that decode to same key through JSON escapes: invalid', () => {
                const error = captureError(() => parseTypeSchema('{"\\u0061": "string", "a": "number"}'));
                expect(isTypeSchemaError(error)).toBe(true);
            });
        });

        describe('incidental directory acceptance (19.3-28 to 36)', () => {
            test('[19.3-28] root {} with no required rendered files is valid', () => {
                expect(scanExplodedJsonProjection({}, () => undefined)).toEqual({});
            });

            test('[19.3-31] root [] with no required rendered files is valid', () => {
                expect(scanExplodedJsonProjection([], () => undefined)).toEqual([]);
            });
        });
    });

    describe('[19.4] round-trip and canonicalization', () => {
        test('[19.4-2] boolean/string disambiguation: same rendered text "true" with different schemas', () => {
            const boolProj = projectExplodedJsonValue(true);
            expect(boolProj.schema).toBe('boolean');
            const strProj = projectExplodedJsonValue('true');
            expect(strProj.schema).toBe('string');
            expect(boolProj.leaves[0].content).toBe('true');
            expect(strProj.leaves[0].content).toBe('true');
            const boolResult = scanExplodedJsonProjection('boolean', () => 'true');
            expect(boolResult).toBe(true);
            const strResult = scanExplodedJsonProjection('string', () => 'true');
            expect(strResult).toBe('true');
        });

        test('[19.4-3] canonicalize unusual schema whitespace and unsorted schema object members', () => {
            const schema = parseTypeSchema('{  "b"  :  "number" ,  "a" : "string" }');
            expect(formatTypeSchema(schema)).toBe('{\n  "a": "string",\n  "b": "number"\n}');
        });

        test('[19.4-5] normalize valid noncanonical number text (1.0 → 1)', () => {
            expect(scanExplodedJsonProjection('number', () => '1.0')).toBe(1);
        });

        test('[19.4-5] normalize valid noncanonical number text (1e0 → 1)', () => {
            expect(scanExplodedJsonProjection('number', () => '1e0')).toBe(1);
        });

        test('[19.4-8] schema-only empty root {} has no required rendered files after scan and render', () => {
            const projection = projectExplodedJsonValue({});
            expect(projection.leaves).toEqual([]);
            expect(projection.schema).toEqual({});
        });

        test('[19.4-8] schema-only empty root [] has no required rendered files after scan and render', () => {
            const projection = projectExplodedJsonValue([]);
            expect(projection.leaves).toEqual([]);
            expect(projection.schema).toEqual([]);
        });

        test('[19.4-10] single-final-LF "true\\n" is rejected', () => {
            const error = captureError(() => scanExplodedJsonProjection('boolean', () => 'true\n'));
            expect(isRenderedLeafError(error)).toBe(true);
        });

        test('[19.4-10] single-final-LF "false\\n" is rejected', () => {
            const error = captureError(() => scanExplodedJsonProjection('boolean', () => 'false\n'));
            expect(isRenderedLeafError(error)).toBe(true);
        });

        test('[19.4-10] single-final-LF "null\\n" is rejected', () => {
            const error = captureError(() => scanExplodedJsonProjection('null', () => 'null\n'));
            expect(isRenderedLeafError(error)).toBe(true);
        });

        test('[19.4-10] single-final-LF "5\\n" is rejected', () => {
            const error = captureError(() => scanExplodedJsonProjection('number', () => '5\n'));
            expect(isRenderedLeafError(error)).toBe(true);
        });
    });
});
