const { renderScalar, scanScalar } = require('./scalar_codec');
const { formatTypeSchema, validateTypeSchema } = require('./schema_codec');
const { encodeObjectKeySegment, appendDescendantPath, encodeArrayIndex } = require('./path_codec');
const {
    UnsupportedRenderedValueError,
    CycleInRenderedValueError,
    SparseArrayRenderedValueError,
    NonPlainObjectRenderedValueError,
    MissingRenderedLeafError,
} = require('./errors');

/** @typedef {unknown} TypeSchema */
/** @typedef {{descendantPath: string, content: string}} ProjectedLeaf */
/** @typedef {{schema: TypeSchema, schemaText: string, leaves: ProjectedLeaf[]}} ValueProjection */

/** @param {unknown} value @returns {ValueProjection} */
function projectExplodedJsonValue(value) {
    /** @type {ProjectedLeaf[]} */
    const leaves = [];
    const ancestors = new Set();
    /** @param {unknown} current @param {string} descendantPath @returns {TypeSchema} */
    function visit(current, descendantPath) {
        if (current === null) { leaves.push({ descendantPath, content: renderScalar(null) }); return 'null'; }
        if (typeof current === 'string' || typeof current === 'boolean') {
            leaves.push({ descendantPath, content: renderScalar(current) });
            return typeof current;
        }
        if (typeof current === 'number') {
            if (!Number.isFinite(current)) throw new UnsupportedRenderedValueError(descendantPath, String(current));
            leaves.push({ descendantPath, content: renderScalar(current) });
            return 'number';
        }
        if (typeof current !== 'object') throw new UnsupportedRenderedValueError(descendantPath, typeof current);
        if (ancestors.has(current)) throw new CycleInRenderedValueError(descendantPath);
        ancestors.add(current);
        try {
            if (Array.isArray(current)) {
                const descriptors = Object.getOwnPropertyDescriptors(current);
                for (let index = 0; index < current.length; index += 1) {
                    if (!Object.prototype.hasOwnProperty.call(current, index)) throw new SparseArrayRenderedValueError(descendantPath, index);
                    const descriptor = descriptors[String(index)];
                    if (descriptor === undefined || !('value' in descriptor)) throw new NonPlainObjectRenderedValueError(descendantPath, 'array accessor');
                }
                const extraKeys = Object.keys(current).filter((key) => !/^(?:0|[1-9]\d*)$/.test(key));
                if (extraKeys.length > 0 || Object.getOwnPropertySymbols(current).length > 0) throw new NonPlainObjectRenderedValueError(descendantPath, 'array has semantic properties');
                return current.map((item, index) => visit(item, appendDescendantPath(descendantPath, encodeArrayIndex(index))));
            }
            if (Object.getPrototypeOf(current) !== Object.prototype) throw new NonPlainObjectRenderedValueError(descendantPath, 'prototype is not Object.prototype');
            if (Object.getOwnPropertySymbols(current).length > 0) throw new NonPlainObjectRenderedValueError(descendantPath, 'symbol-keyed data');
            const descriptors = Object.getOwnPropertyDescriptors(current);
            const entries = [];
            for (const key of Object.keys(current).sort()) {
                const descriptor = descriptors[key];
                if (descriptor === undefined || !('value' in descriptor)) throw new NonPlainObjectRenderedValueError(descendantPath, `accessor property '${key}'`);
                entries.push([key, visit(descriptor.value, appendDescendantPath(descendantPath, encodeObjectKeySegment(key)))]);
            }
            return Object.fromEntries(entries);
        } finally { ancestors.delete(current); }
    }
    const schema = visit(value, '');
    return { schema, schemaText: formatTypeSchema(schema), leaves };
}

/** @param {TypeSchema} schema @param {(descendantPath: string) => string | undefined} leafReader @returns {unknown} */
function scanExplodedJsonProjection(schema, leafReader) {
    validateTypeSchema(schema);
    /** @param {TypeSchema} node @param {string} descendantPath @returns {unknown} */
    function visit(node, descendantPath) {
        if (typeof node === 'string') {
            const content = leafReader(descendantPath);
            if (content === undefined) throw new MissingRenderedLeafError(descendantPath);
            return scanScalar(node, content, descendantPath);
        }
        if (Array.isArray(node)) return node.map((child, index) => visit(child, appendDescendantPath(descendantPath, encodeArrayIndex(index))));
        if (node === null || typeof node !== 'object') throw new MissingRenderedLeafError(descendantPath);
        return Object.fromEntries(
            Object.entries(node).sort(([first], [second]) => first < second ? -1 : first > second ? 1 : 0)
                .map(([key, child]) => [key, visit(child, appendDescendantPath(descendantPath, encodeObjectKeySegment(key)))])
        );
    }
    return visit(schema, '');
}
module.exports = { projectExplodedJsonValue, scanExplodedJsonProjection };
