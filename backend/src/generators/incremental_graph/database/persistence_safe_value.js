const { types } = require("util");

/**
 * Describes the first place where a value leaves the persistence-safe ordinary
 * JSON domain.
 */
class InvalidPersistenceSafeValueError extends Error {
    /**
     * @param {string} path
     * @param {string} reason
     */
    constructor(path, reason) {
        super(`Invalid persistence-safe value at ${path}: ${reason}`);
        this.name = "InvalidPersistenceSafeValueError";
        this.path = path;
        this.reason = reason;
    }
}

/**
 * @param {unknown} object
 * @returns {object is InvalidPersistenceSafeValueError}
 */
function isInvalidPersistenceSafeValueError(object) {
    return object instanceof InvalidPersistenceSafeValueError;
}

/**
 * Return the first violation of the ordinary-JSON persistence domain.
 * Successful validation proves that JSON stringify/parse preserves the value
 * under IncrementalGraph's order-sensitive semantic equality.
 *
 * @param {unknown} value
 * @param {string} [path="value"]
 * @param {Set<object>} [ancestors]
 * @returns {InvalidPersistenceSafeValueError | undefined}
 */
function findInvalidPersistenceSafeValue(value, path = "value", ancestors = new Set()) {
    if (value === null || typeof value === "string" || typeof value === "boolean") {
        return undefined;
    }
    if (typeof value === "number") {
        return Number.isFinite(value)
            ? undefined
            : new InvalidPersistenceSafeValueError(path, "numbers must be finite");
    }
    if (typeof value !== "object") {
        return new InvalidPersistenceSafeValueError(path, "only ordinary JSON values are permitted");
    }
    if (types.isProxy(value)) {
        return new InvalidPersistenceSafeValueError(path, "proxies are not plain JSON containers");
    }
    if (ancestors.has(value)) {
        return new InvalidPersistenceSafeValueError(path, "cycles are not permitted");
    }

    const prototype = Object.getPrototypeOf(value);
    if (Array.isArray(value)) {
        if (prototype !== Array.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
            return new InvalidPersistenceSafeValueError(path, "arrays must use the ordinary array prototype and string keys");
        }
        const expectedNames = [
            ...Array.from({ length: value.length }, (_, index) => String(index)),
            "length",
        ];
        const names = Object.getOwnPropertyNames(value);
        if (names.length !== expectedNames.length ||
            names.some((name, index) => name !== expectedNames[index])) {
            return new InvalidPersistenceSafeValueError(path, "arrays must be dense and have no named properties");
        }
        ancestors.add(value);
        for (let index = 0; index < value.length; index += 1) {
            const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
            if (descriptor === undefined || !("value" in descriptor)) {
                ancestors.delete(value);
                return new InvalidPersistenceSafeValueError(`${path}[${index}]`, "array elements must be data properties");
            }
            const invalid = findInvalidPersistenceSafeValue(
                descriptor.value,
                `${path}[${index}]`,
                ancestors
            );
            if (invalid !== undefined) {
                ancestors.delete(value);
                return invalid;
            }
        }
        ancestors.delete(value);
        return undefined;
    }

    if (prototype !== Object.prototype || Object.getOwnPropertySymbols(value).length !== 0) {
        return new InvalidPersistenceSafeValueError(path, "records must use Object.prototype and string keys");
    }
    ancestors.add(value);
    for (const key of Object.getOwnPropertyNames(value)) {
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || !descriptor.enumerable) {
            ancestors.delete(value);
            return new InvalidPersistenceSafeValueError(`${path}.${key}`, "record fields must be enumerable data properties");
        }
        const invalid = findInvalidPersistenceSafeValue(
            descriptor.value,
            `${path}.${key}`,
            ancestors
        );
        if (invalid !== undefined) {
            ancestors.delete(value);
            return invalid;
        }
    }
    ancestors.delete(value);
    return undefined;
}

module.exports = {
    findInvalidPersistenceSafeValue,
    isInvalidPersistenceSafeValueError,
};
