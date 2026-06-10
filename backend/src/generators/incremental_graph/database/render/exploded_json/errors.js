class ExplodedJsonValueError extends Error {
    /** @param {string} message @param {string} descendantPath */
    constructor(message, descendantPath) {
        super(message);
        this.name = 'ExplodedJsonValueError';
        this.descendantPath = descendantPath;
    }
}

class UnsupportedRenderedValueError extends ExplodedJsonValueError {
    /** @param {string} descendantPath @param {string} observedType */
    constructor(descendantPath, observedType) {
        super(`Unsupported rendered value at '${descendantPath}': ${observedType}`, descendantPath);
        this.name = 'UnsupportedRenderedValueError';
        this.observedType = observedType;
    }
}

class CycleInRenderedValueError extends ExplodedJsonValueError {
    /** @param {string} descendantPath */
    constructor(descendantPath) {
        super(`Cycle in rendered value at '${descendantPath}'`, descendantPath);
        this.name = 'CycleInRenderedValueError';
    }
}

class SparseArrayRenderedValueError extends ExplodedJsonValueError {
    /** @param {string} descendantPath @param {number} index */
    constructor(descendantPath, index) {
        super(`Sparse array at '${descendantPath}' is missing index ${index}`, descendantPath);
        this.name = 'SparseArrayRenderedValueError';
        this.index = index;
    }
}

class NonPlainObjectRenderedValueError extends ExplodedJsonValueError {
    /** @param {string} descendantPath @param {string} reason */
    constructor(descendantPath, reason) {
        super(`Non-plain rendered object at '${descendantPath}': ${reason}`, descendantPath);
        this.name = 'NonPlainObjectRenderedValueError';
        this.reason = reason;
    }
}

class TypeSchemaError extends Error {}
class MalformedTypeSchemaError extends TypeSchemaError {
    /** @param {unknown} cause */
    constructor(cause) {
        super(`Malformed type schema: ${cause}`);
        this.name = 'MalformedTypeSchemaError';
        this.cause = cause;
    }
}
class InvalidTypeSchemaNodeError extends TypeSchemaError {
    /** @param {string} schemaPath @param {string} observedType */
    constructor(schemaPath, observedType) {
        super(`Invalid type schema node at '${schemaPath}': ${observedType}`);
        this.name = 'InvalidTypeSchemaNodeError';
        this.schemaPath = schemaPath;
        this.observedType = observedType;
    }
}
class UnknownTypeSchemaTokenError extends TypeSchemaError {
    /** @param {string} schemaPath @param {string} token */
    constructor(schemaPath, token) {
        super(`Unknown type schema token at '${schemaPath}': '${token}'`);
        this.name = 'UnknownTypeSchemaTokenError';
        this.schemaPath = schemaPath;
        this.token = token;
    }
}

class RenderedLeafError extends Error {}
class MissingRenderedLeafError extends RenderedLeafError {
    /** @param {string} descendantPath */
    constructor(descendantPath) {
        super(`Missing rendered leaf '${descendantPath}'`);
        this.name = 'MissingRenderedLeafError';
        this.descendantPath = descendantPath;
    }
}
class InvalidNumberLeafError extends RenderedLeafError {
    /** @param {string} descendantPath @param {string} content */
    constructor(descendantPath, content) {
        super(`Invalid number leaf '${descendantPath}': '${content}'`);
        this.name = 'InvalidNumberLeafError';
        this.descendantPath = descendantPath;
        this.content = content;
    }
}
class InvalidBooleanLeafError extends RenderedLeafError {
    /** @param {string} descendantPath @param {string} content */
    constructor(descendantPath, content) {
        super(`Invalid boolean leaf '${descendantPath}': '${content}'`);
        this.name = 'InvalidBooleanLeafError';
        this.descendantPath = descendantPath;
        this.content = content;
    }
}
class InvalidNullLeafError extends RenderedLeafError {
    /** @param {string} descendantPath @param {string} content */
    constructor(descendantPath, content) {
        super(`Invalid null leaf '${descendantPath}': '${content}'`);
        this.name = 'InvalidNullLeafError';
        this.descendantPath = descendantPath;
        this.content = content;
    }
}


class PairedSnapshotError extends Error {}
class MissingKindtreeRootError extends PairedSnapshotError {
    /** @param {string} kindtreeRoot @param {string} renderedRoot */
    constructor(kindtreeRoot, renderedRoot) {
        super(`Kindtree root '${kindtreeRoot}' is missing while rendered files exist under '${renderedRoot}'`);
        this.name = 'MissingKindtreeRootError'; this.kindtreeRoot = kindtreeRoot; this.renderedRoot = renderedRoot;
    }
}
class ExtraRenderedFileError extends PairedSnapshotError {
    /** @param {string} relativePath */
    constructor(relativePath) { super(`Rendered file is not claimed by a schema: '${relativePath}'`); this.name = 'ExtraRenderedFileError'; this.relativePath = relativePath; }
}
class DuplicateDecodedValueRootError extends PairedSnapshotError {
    /** @param {string} rawKey @param {string} firstPath @param {string} secondPath */
    constructor(rawKey, firstPath, secondPath) { super(`Duplicate decoded value root '${rawKey}': '${firstPath}' and '${secondPath}'`); this.name = 'DuplicateDecodedValueRootError'; this.rawKey = rawKey; this.firstPath = firstPath; this.secondPath = secondPath; }
}
class UnsupportedFilesystemEntryError extends PairedSnapshotError {
    /** @param {string} entryPath */
    constructor(entryPath) { super(`Unsupported filesystem entry: '${entryPath}'`); this.name = 'UnsupportedFilesystemEntryError'; this.entryPath = entryPath; }
}
/** @param {unknown} object @returns {object is MissingKindtreeRootError} */
function isMissingKindtreeRootError(object) { return object instanceof MissingKindtreeRootError; }
/** @param {unknown} object @returns {object is ExtraRenderedFileError} */
function isExtraRenderedFileError(object) { return object instanceof ExtraRenderedFileError; }
/** @param {unknown} object @returns {object is DuplicateDecodedValueRootError} */
function isDuplicateDecodedValueRootError(object) { return object instanceof DuplicateDecodedValueRootError; }
/** @param {unknown} object @returns {object is UnsupportedFilesystemEntryError} */
function isUnsupportedFilesystemEntryError(object) { return object instanceof UnsupportedFilesystemEntryError; }

/** @param {unknown} object @returns {object is UnsupportedRenderedValueError} */
function isUnsupportedRenderedValueError(object) { return object instanceof UnsupportedRenderedValueError; }
/** @param {unknown} object @returns {object is CycleInRenderedValueError} */
function isCycleInRenderedValueError(object) { return object instanceof CycleInRenderedValueError; }
/** @param {unknown} object @returns {object is SparseArrayRenderedValueError} */
function isSparseArrayRenderedValueError(object) { return object instanceof SparseArrayRenderedValueError; }
/** @param {unknown} object @returns {object is NonPlainObjectRenderedValueError} */
function isNonPlainObjectRenderedValueError(object) { return object instanceof NonPlainObjectRenderedValueError; }
/** @param {unknown} object @returns {object is TypeSchemaError} */
function isTypeSchemaError(object) { return object instanceof TypeSchemaError; }
/** @param {unknown} object @returns {object is RenderedLeafError} */
function isRenderedLeafError(object) { return object instanceof RenderedLeafError; }

module.exports = {
    UnsupportedRenderedValueError,
    CycleInRenderedValueError,
    SparseArrayRenderedValueError,
    NonPlainObjectRenderedValueError,
    MalformedTypeSchemaError,
    InvalidTypeSchemaNodeError,
    UnknownTypeSchemaTokenError,
    MissingRenderedLeafError,
    InvalidNumberLeafError,
    InvalidBooleanLeafError,
    InvalidNullLeafError,
    isUnsupportedRenderedValueError,
    isCycleInRenderedValueError,
    isSparseArrayRenderedValueError,
    isNonPlainObjectRenderedValueError,
    isTypeSchemaError,
    MissingKindtreeRootError,
    ExtraRenderedFileError,
    DuplicateDecodedValueRootError,
    UnsupportedFilesystemEntryError,
    isMissingKindtreeRootError,
    isExtraRenderedFileError,
    isDuplicateDecodedValueRootError,
    isUnsupportedFilesystemEntryError,
    isRenderedLeafError,
};
