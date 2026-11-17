/**
 * The shape combinators the `ComputedValue` member shapes are built from.
 *
 * A shape check reports the first way a value fails a shape, so a rejected
 * payload can say which member of which union member was wrong. Keeping the
 * combinators here and the union's own member shapes in `./computed_value.js`
 * leaves each file stating one thing: how a shape is written, and what the
 * current union's shapes are.
 */

/**
 * @typedef {(value: unknown, path: string) => string | undefined} Shape
 */

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

const { hasOwnProperty } = Object.prototype;

/** @type {Shape} */
function stringShape(value, path) {
    return typeof value === "string" ? undefined : `${path} must be a string`;
}

/**
 * A member whose declared type admits `undefined`. A live value carries the
 * member as an own property whose value is `undefined`, and the persisted
 * encoding of that live value carries no member at all, so both representations
 * of one declared type are accepted.
 * @type {Shape}
 */
function stringOrUndefinedShape(value, path) {
    return value === undefined ? undefined : stringShape(value, path);
}

/**
 * A finite number. A count or a binding which is `Infinity` is not a value the
 * current format can carry, because `JSON.stringify` never writes it.
 * @type {Shape}
 */
function numberShape(value, path) {
    if (typeof value !== "number") {
        return `${path} must be a number`;
    }
    return Number.isFinite(value) ? undefined : `${path} must be a finite number`;
}

/**
 * A member whose declared value is one constant. A nominal brand member is
 * declared with the value `undefined`, so the constant a shape requires is
 * `string | undefined` rather than a string.
 * @param {string | undefined} expected
 * @returns {Shape}
 */
function constantShape(expected) {
    return (value, path) =>
        value === expected ? undefined : `${path} must be ${JSON.stringify(expected) ?? "undefined"}`;
}

/**
 * A closed object: every declared member must be present with its declared
 * shape, and a member which the declaration does not declare is rejected
 * instead of being carried into meaning by whichever reader happens to see it.
 * @param {Record<string, Shape>} required
 * @param {Record<string, Shape>} [optional]
 * @returns {Shape}
 */
function closedObjectShape(required, optional = {}) {
    return (value, path) => {
        if (!isPlainRecord(value)) {
            return `${path} must be an object`;
        }
        for (const [name, shape] of Object.entries(required)) {
            if (!hasOwnProperty.call(value, name)) {
                return `${path} is missing member ${JSON.stringify(name)}`;
            }
            const violation = shape(value[name], `${path}.${name}`);
            if (violation !== undefined) {
                return violation;
            }
        }
        for (const [name, member] of Object.entries(value)) {
            if (hasOwnProperty.call(required, name)) {
                continue;
            }
            const shape = hasOwnProperty.call(optional, name) ? optional[name] : undefined;
            if (shape === undefined) {
                return `${path} has unknown member ${JSON.stringify(name)}`;
            }
            const violation = shape(member, `${path}.${name}`);
            if (violation !== undefined) {
                return violation;
            }
        }
        return undefined;
    };
}

/**
 * @param {Shape} shape
 * @returns {Shape}
 */
function arrayOfShape(shape) {
    return (value, path) => {
        if (!Array.isArray(value)) {
            return `${path} must be an array`;
        }
        for (const [index, member] of value.entries()) {
            const violation = shape(member, `${path}[${index}]`);
            if (violation !== undefined) {
                return violation;
            }
        }
        return undefined;
    };
}

/**
 * @param {Shape} shape
 * @returns {Shape}
 */
function nullableShape(shape) {
    return (value, path) => (value === null ? undefined : shape(value, path));
}

/**
 * @param {ReadonlyArray<Shape>} shapes
 * @returns {Shape}
 */
function oneOfShape(shapes) {
    return (value, path) => {
        for (const shape of shapes) {
            if (shape(value, path) === undefined) {
                return undefined;
            }
        }
        return `${path} matches none of the declared shapes`;
    };
}

/**
 * @param {Shape} shape
 * @returns {Shape}
 */
function stringRecordShape(shape) {
    return (value, path) => {
        if (!isPlainRecord(value)) {
            return `${path} must be an object`;
        }
        for (const [name, member] of Object.entries(value)) {
            const violation = shape(member, `${path}.${name}`);
            if (violation !== undefined) {
                return violation;
            }
        }
        return undefined;
    };
}

module.exports = {
    arrayOfShape,
    closedObjectShape,
    constantShape,
    isPlainRecord,
    nullableShape,
    numberShape,
    oneOfShape,
    stringOrUndefinedShape,
    stringRecordShape,
    stringShape,
};
