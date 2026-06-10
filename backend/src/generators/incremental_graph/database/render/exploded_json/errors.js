/**
 * @file Error classes for exploded JSON value rendering.
 */

class ExplodedJsonValueError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "ExplodedJsonValueError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is ExplodedJsonValueError}
 */
function isExplodedJsonValueError(object) {
    return object instanceof ExplodedJsonValueError;
}

class UnsupportedRenderedValueError extends ExplodedJsonValueError {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message);
        this.name = "UnsupportedRenderedValueError";
        this.value = value;
    }
}
/**
 * @param {unknown} object
 * @returns {object is UnsupportedRenderedValueError}
 */
function isUnsupportedRenderedValueError(object) {
    return object instanceof UnsupportedRenderedValueError;
}

class CycleInRenderedValueError extends ExplodedJsonValueError {
    constructor() {
        super("Cycle detected in rendered value");
        this.name = "CycleInRenderedValueError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is CycleInRenderedValueError}
 */
function isCycleInRenderedValueError(object) {
    return object instanceof CycleInRenderedValueError;
}

class SparseArrayRenderedValueError extends ExplodedJsonValueError {
    constructor() {
        super("Sparse array is not supported as a rendered value");
        this.name = "SparseArrayRenderedValueError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is SparseArrayRenderedValueError}
 */
function isSparseArrayRenderedValueError(object) {
    return object instanceof SparseArrayRenderedValueError;
}

class NonPlainObjectRenderedValueError extends ExplodedJsonValueError {
    /**
     * @param {string} message
     * @param {unknown} value
     */
    constructor(message, value) {
        super(message);
        this.name = "NonPlainObjectRenderedValueError";
        this.value = value;
    }
}
/**
 * @param {unknown} object
 * @returns {object is NonPlainObjectRenderedValueError}
 */
function isNonPlainObjectRenderedValueError(object) {
    return object instanceof NonPlainObjectRenderedValueError;
}

class TypeSchemaError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "TypeSchemaError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is TypeSchemaError}
 */
function isTypeSchemaError(object) {
    return object instanceof TypeSchemaError;
}

class MalformedTypeSchemaError extends TypeSchemaError {
    /**
     * @param {string} message
     * @param {unknown} cause
     */
    constructor(message, cause) {
        super(message);
        this.name = "MalformedTypeSchemaError";
        this.cause = cause;
    }
}
/**
 * @param {unknown} object
 * @returns {object is MalformedTypeSchemaError}
 */
function isMalformedTypeSchemaError(object) {
    return object instanceof MalformedTypeSchemaError;
}

class InvalidTypeSchemaNodeError extends TypeSchemaError {
    /**
     * @param {string} message
     * @param {unknown} node
     */
    constructor(message, node) {
        super(message);
        this.name = "InvalidTypeSchemaNodeError";
        this.node = node;
    }
}
/**
 * @param {unknown} object
 * @returns {object is InvalidTypeSchemaNodeError}
 */
function isInvalidTypeSchemaNodeError(object) {
    return object instanceof InvalidTypeSchemaNodeError;
}

class UnknownTypeSchemaTokenError extends TypeSchemaError {
    /**
     * @param {string} token
     */
    constructor(token) {
        super(`Unknown type schema token: ${token}`);
        this.name = "UnknownTypeSchemaTokenError";
        this.token = token;
    }
}
/**
 * @param {unknown} object
 * @returns {object is UnknownTypeSchemaTokenError}
 */
function isUnknownTypeSchemaTokenError(object) {
    return object instanceof UnknownTypeSchemaTokenError;
}

class DuplicateSchemaKeyError extends TypeSchemaError {
    /**
     * @param {string} key
     */
    constructor(key) {
        super(`Duplicate schema object key: ${key}`);
        this.name = "DuplicateSchemaKeyError";
        this.key = key;
    }
}
/**
 * @param {unknown} object
 * @returns {object is DuplicateSchemaKeyError}
 */
function isDuplicateSchemaKeyError(object) {
    return object instanceof DuplicateSchemaKeyError;
}

class RenderedLeafError extends Error {
    /**
     * @param {string} message
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     */
    constructor(message, valueRoot, leafPath) {
        super(message);
        this.name = "RenderedLeafError";
        this.valueRoot = valueRoot;
        this.leafPath = leafPath;
    }
}
/**
 * @param {unknown} object
 * @returns {object is RenderedLeafError}
 */
function isRenderedLeafError(object) {
    return object instanceof RenderedLeafError;
}

class MissingRenderedLeafError extends RenderedLeafError {
    /**
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     * @param {string} expectedType
     */
    constructor(valueRoot, leafPath, expectedType) {
        super(
            `Missing rendered leaf for ${valueRoot}${leafPath ? '/' + leafPath : ''}: expected ${expectedType}`,
            valueRoot, leafPath
        );
        this.name = "MissingRenderedLeafError";
        this.expectedType = expectedType;
    }
}
/**
 * @param {unknown} object
 * @returns {object is MissingRenderedLeafError}
 */
function isMissingRenderedLeafError(object) {
    return object instanceof MissingRenderedLeafError;
}

class InvalidNumberLeafError extends RenderedLeafError {
    /**
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     * @param {unknown} content
     */
    constructor(valueRoot, leafPath, content) {
        super(
            `Invalid number leaf at ${valueRoot}${leafPath ? '/' + leafPath : ''}: ${JSON.stringify(content)}`,
            valueRoot, leafPath
        );
        this.name = "InvalidNumberLeafError";
        this.content = content;
    }
}
/**
 * @param {unknown} object
 * @returns {object is InvalidNumberLeafError}
 */
function isInvalidNumberLeafError(object) {
    return object instanceof InvalidNumberLeafError;
}

class InvalidBooleanLeafError extends RenderedLeafError {
    /**
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     * @param {unknown} content
     */
    constructor(valueRoot, leafPath, content) {
        super(
            `Invalid boolean leaf at ${valueRoot}${leafPath ? '/' + leafPath : ''}: ${JSON.stringify(content)}`,
            valueRoot, leafPath
        );
        this.name = "InvalidBooleanLeafError";
        this.content = content;
    }
}
/**
 * @param {unknown} object
 * @returns {object is InvalidBooleanLeafError}
 */
function isInvalidBooleanLeafError(object) {
    return object instanceof InvalidBooleanLeafError;
}

class InvalidNullLeafError extends RenderedLeafError {
    /**
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     * @param {unknown} content
     */
    constructor(valueRoot, leafPath, content) {
        super(
            `Invalid null leaf at ${valueRoot}${leafPath ? '/' + leafPath : ''}: ${JSON.stringify(content)}`,
            valueRoot, leafPath
        );
        this.name = "InvalidNullLeafError";
        this.content = content;
    }
}
/**
 * @param {unknown} object
 * @returns {object is InvalidNullLeafError}
 */
function isInvalidNullLeafError(object) {
    return object instanceof InvalidNullLeafError;
}

class RenderedDirectoryWhereFileRequiredError extends RenderedLeafError {
    /**
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     */
    constructor(valueRoot, leafPath) {
        super(
            `Directory where file required at ${valueRoot}${leafPath ? '/' + leafPath : ''}`,
            valueRoot, leafPath
        );
        this.name = "RenderedDirectoryWhereFileRequiredError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is RenderedDirectoryWhereFileRequiredError}
 */
function isRenderedDirectoryWhereFileRequiredError(object) {
    return object instanceof RenderedDirectoryWhereFileRequiredError;
}

class RenderedFileWhereDirectoryRequiredError extends RenderedLeafError {
    /**
     * @param {unknown} valueRoot
     * @param {string | undefined} leafPath
     */
    constructor(valueRoot, leafPath) {
        super(
            `File where directory required at ${valueRoot}${leafPath ? '/' + leafPath : ''}`,
            valueRoot, leafPath
        );
        this.name = "RenderedFileWhereDirectoryRequiredError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is RenderedFileWhereDirectoryRequiredError}
 */
function isRenderedFileWhereDirectoryRequiredError(object) {
    return object instanceof RenderedFileWhereDirectoryRequiredError;
}

class PairedSnapshotError extends Error {
    /**
     * @param {string} message
     */
    constructor(message) {
        super(message);
        this.name = "PairedSnapshotError";
    }
}
/**
 * @param {unknown} object
 * @returns {object is PairedSnapshotError}
 */
function isPairedSnapshotError(object) {
    return object instanceof PairedSnapshotError;
}

class MissingKindtreeRootError extends PairedSnapshotError {
    /**
     * @param {string} valueRoot
     */
    constructor(valueRoot) {
        super(`Missing kindtree root for value root: ${valueRoot}`);
        this.name = "MissingKindtreeRootError";
        this.valueRoot = valueRoot;
    }
}
/**
 * @param {unknown} object
 * @returns {object is MissingKindtreeRootError}
 */
function isMissingKindtreeRootError(object) {
    return object instanceof MissingKindtreeRootError;
}

class ExtraRenderedFileError extends PairedSnapshotError {
    /**
     * @param {string} valueRoot
     * @param {string} leafPath
     */
    constructor(valueRoot, leafPath) {
        super(
            `Extra rendered file not claimed by any schema at ${valueRoot}${leafPath ? '/' + leafPath : ''}`,
        );
        this.name = "ExtraRenderedFileError";
        this.valueRoot = valueRoot;
        this.leafPath = leafPath;
    }
}
/**
 * @param {unknown} object
 * @returns {object is ExtraRenderedFileError}
 */
function isExtraRenderedFileError(object) {
    return object instanceof ExtraRenderedFileError;
}

class DuplicateDecodedPathError extends PairedSnapshotError {
    /**
     * @param {string} valueRoot
     * @param {string} decodedKey
     * @param {string[]} variants
     */
    constructor(valueRoot, decodedKey, variants) {
        super(
            `Duplicate decoded path at ${valueRoot}: '${decodedKey}' from [${variants.join(', ')}]`,
        );
        this.name = "DuplicateDecodedPathError";
        this.valueRoot = valueRoot;
        this.decodedKey = decodedKey;
        this.variants = variants;
    }
}
/**
 * @param {unknown} object
 * @returns {object is DuplicateDecodedPathError}
 */
function isDuplicateDecodedPathError(object) {
    return object instanceof DuplicateDecodedPathError;
}

class DuplicateDecodedValueRootError extends PairedSnapshotError {
    /**
     * @param {string} rawKey1
     * @param {string} rawKey2
     * @param {string} valueRoot
     */
    constructor(rawKey1, rawKey2, valueRoot) {
        super(
            `Duplicate decoded value root: '${rawKey1}' and '${rawKey2}' both map to '${valueRoot}'`,
        );
        this.name = "DuplicateDecodedValueRootError";
        this.rawKey1 = rawKey1;
        this.rawKey2 = rawKey2;
        this.valueRoot = valueRoot;
    }
}
/**
 * @param {unknown} object
 * @returns {object is DuplicateDecodedValueRootError}
 */
function isDuplicateDecodedValueRootError(object) {
    return object instanceof DuplicateDecodedValueRootError;
}

class UnsupportedFilesystemEntryError extends PairedSnapshotError {
    /**
     * @param {string} path
     * @param {string} kind
     */
    constructor(path, kind) {
        super(`Unsupported filesystem entry at ${path}: ${kind}`);
        this.name = "UnsupportedFilesystemEntryError";
        this.path = path;
        this.kind = kind;
    }
}
/**
 * @param {unknown} object
 * @returns {object is UnsupportedFilesystemEntryError}
 */
function isUnsupportedFilesystemEntryError(object) {
    return object instanceof UnsupportedFilesystemEntryError;
}

class FileDirectoryConflictError extends PairedSnapshotError {
    /**
     * @param {string} path
     * @param {string} conflictKind
     */
    constructor(path, conflictKind) {
        super(`File/directory conflict at ${path}: ${conflictKind}`);
        this.name = "FileDirectoryConflictError";
        this.path = path;
        this.conflictKind = conflictKind;
    }
}
/**
 * @param {unknown} object
 * @returns {object is FileDirectoryConflictError}
 */
function isFileDirectoryConflictError(object) {
    return object instanceof FileDirectoryConflictError;
}

module.exports = {
    ExplodedJsonValueError, isExplodedJsonValueError,
    UnsupportedRenderedValueError, isUnsupportedRenderedValueError,
    CycleInRenderedValueError, isCycleInRenderedValueError,
    SparseArrayRenderedValueError, isSparseArrayRenderedValueError,
    NonPlainObjectRenderedValueError, isNonPlainObjectRenderedValueError,
    TypeSchemaError, isTypeSchemaError,
    MalformedTypeSchemaError, isMalformedTypeSchemaError,
    InvalidTypeSchemaNodeError, isInvalidTypeSchemaNodeError,
    UnknownTypeSchemaTokenError, isUnknownTypeSchemaTokenError,
    DuplicateSchemaKeyError, isDuplicateSchemaKeyError,
    RenderedLeafError, isRenderedLeafError,
    MissingRenderedLeafError, isMissingRenderedLeafError,
    InvalidNumberLeafError, isInvalidNumberLeafError,
    InvalidBooleanLeafError, isInvalidBooleanLeafError,
    InvalidNullLeafError, isInvalidNullLeafError,
    RenderedDirectoryWhereFileRequiredError, isRenderedDirectoryWhereFileRequiredError,
    RenderedFileWhereDirectoryRequiredError, isRenderedFileWhereDirectoryRequiredError,
    PairedSnapshotError, isPairedSnapshotError,
    MissingKindtreeRootError, isMissingKindtreeRootError,
    ExtraRenderedFileError, isExtraRenderedFileError,
    DuplicateDecodedPathError, isDuplicateDecodedPathError,
    DuplicateDecodedValueRootError, isDuplicateDecodedValueRootError,
    UnsupportedFilesystemEntryError, isUnsupportedFilesystemEntryError,
    FileDirectoryConflictError, isFileDirectoryConflictError,
};
