/**
 * @file Error classes for exploded JSON value rendering.
 */

class ExplodedJsonValueError extends Error {
    constructor(message) {
        super(message);
        this.name = "ExplodedJsonValueError";
    }
}
function isExplodedJsonValueError(object) {
    return object instanceof ExplodedJsonValueError;
}

class UnsupportedRenderedValueError extends ExplodedJsonValueError {
    constructor(message, value) {
        super(message);
        this.name = "UnsupportedRenderedValueError";
        this.value = value;
    }
}
function isUnsupportedRenderedValueError(object) {
    return object instanceof UnsupportedRenderedValueError;
}

class CycleInRenderedValueError extends ExplodedJsonValueError {
    constructor() {
        super("Cycle detected in rendered value");
        this.name = "CycleInRenderedValueError";
    }
}
function isCycleInRenderedValueError(object) {
    return object instanceof CycleInRenderedValueError;
}

class SparseArrayRenderedValueError extends ExplodedJsonValueError {
    constructor() {
        super("Sparse array is not supported as a rendered value");
        this.name = "SparseArrayRenderedValueError";
    }
}
function isSparseArrayRenderedValueError(object) {
    return object instanceof SparseArrayRenderedValueError;
}

class NonPlainObjectRenderedValueError extends ExplodedJsonValueError {
    constructor(message, value) {
        super(message);
        this.name = "NonPlainObjectRenderedValueError";
        this.value = value;
    }
}
function isNonPlainObjectRenderedValueError(object) {
    return object instanceof NonPlainObjectRenderedValueError;
}

class TypeSchemaError extends Error {
    constructor(message) {
        super(message);
        this.name = "TypeSchemaError";
    }
}
function isTypeSchemaError(object) {
    return object instanceof TypeSchemaError;
}

class MalformedTypeSchemaError extends TypeSchemaError {
    constructor(message, cause) {
        super(message);
        this.name = "MalformedTypeSchemaError";
        this.cause = cause;
    }
}
function isMalformedTypeSchemaError(object) {
    return object instanceof MalformedTypeSchemaError;
}

class InvalidTypeSchemaNodeError extends TypeSchemaError {
    constructor(message, node) {
        super(message);
        this.name = "InvalidTypeSchemaNodeError";
        this.node = node;
    }
}
function isInvalidTypeSchemaNodeError(object) {
    return object instanceof InvalidTypeSchemaNodeError;
}

class UnknownTypeSchemaTokenError extends TypeSchemaError {
    constructor(token) {
        super(`Unknown type schema token: ${token}`);
        this.name = "UnknownTypeSchemaTokenError";
        this.token = token;
    }
}
function isUnknownTypeSchemaTokenError(object) {
    return object instanceof UnknownTypeSchemaTokenError;
}

class DuplicateSchemaKeyError extends TypeSchemaError {
    constructor(key) {
        super(`Duplicate schema object key: ${key}`);
        this.name = "DuplicateSchemaKeyError";
        this.key = key;
    }
}
function isDuplicateSchemaKeyError(object) {
    return object instanceof DuplicateSchemaKeyError;
}

class RenderedLeafError extends Error {
    constructor(message, valueRoot, leafPath) {
        super(message);
        this.name = "RenderedLeafError";
        this.valueRoot = valueRoot;
        this.leafPath = leafPath;
    }
}
function isRenderedLeafError(object) {
    return object instanceof RenderedLeafError;
}

class MissingRenderedLeafError extends RenderedLeafError {
    constructor(valueRoot, leafPath, expectedType) {
        super(
            `Missing rendered leaf for ${valueRoot}${leafPath ? '/' + leafPath : ''}: expected ${expectedType}`,
            valueRoot, leafPath
        );
        this.name = "MissingRenderedLeafError";
        this.expectedType = expectedType;
    }
}
function isMissingRenderedLeafError(object) {
    return object instanceof MissingRenderedLeafError;
}

class InvalidNumberLeafError extends RenderedLeafError {
    constructor(valueRoot, leafPath, content) {
        super(
            `Invalid number leaf at ${valueRoot}${leafPath ? '/' + leafPath : ''}: ${JSON.stringify(content)}`,
            valueRoot, leafPath
        );
        this.name = "InvalidNumberLeafError";
        this.content = content;
    }
}
function isInvalidNumberLeafError(object) {
    return object instanceof InvalidNumberLeafError;
}

class InvalidBooleanLeafError extends RenderedLeafError {
    constructor(valueRoot, leafPath, content) {
        super(
            `Invalid boolean leaf at ${valueRoot}${leafPath ? '/' + leafPath : ''}: ${JSON.stringify(content)}`,
            valueRoot, leafPath
        );
        this.name = "InvalidBooleanLeafError";
        this.content = content;
    }
}
function isInvalidBooleanLeafError(object) {
    return object instanceof InvalidBooleanLeafError;
}

class InvalidNullLeafError extends RenderedLeafError {
    constructor(valueRoot, leafPath, content) {
        super(
            `Invalid null leaf at ${valueRoot}${leafPath ? '/' + leafPath : ''}: ${JSON.stringify(content)}`,
            valueRoot, leafPath
        );
        this.name = "InvalidNullLeafError";
        this.content = content;
    }
}
function isInvalidNullLeafError(object) {
    return object instanceof InvalidNullLeafError;
}

class RenderedDirectoryWhereFileRequiredError extends RenderedLeafError {
    constructor(valueRoot, leafPath) {
        super(
            `Directory where file required at ${valueRoot}${leafPath ? '/' + leafPath : ''}`,
            valueRoot, leafPath
        );
        this.name = "RenderedDirectoryWhereFileRequiredError";
    }
}
function isRenderedDirectoryWhereFileRequiredError(object) {
    return object instanceof RenderedDirectoryWhereFileRequiredError;
}

class RenderedFileWhereDirectoryRequiredError extends RenderedLeafError {
    constructor(valueRoot, leafPath) {
        super(
            `File where directory required at ${valueRoot}${leafPath ? '/' + leafPath : ''}`,
            valueRoot, leafPath
        );
        this.name = "RenderedFileWhereDirectoryRequiredError";
    }
}
function isRenderedFileWhereDirectoryRequiredError(object) {
    return object instanceof RenderedFileWhereDirectoryRequiredError;
}

class PairedSnapshotError extends Error {
    constructor(message) {
        super(message);
        this.name = "PairedSnapshotError";
    }
}
function isPairedSnapshotError(object) {
    return object instanceof PairedSnapshotError;
}

class MissingKindtreeRootError extends PairedSnapshotError {
    constructor(valueRoot) {
        super(`Missing kindtree root for value root: ${valueRoot}`);
        this.name = "MissingKindtreeRootError";
        this.valueRoot = valueRoot;
    }
}
function isMissingKindtreeRootError(object) {
    return object instanceof MissingKindtreeRootError;
}

class ExtraRenderedFileError extends PairedSnapshotError {
    constructor(valueRoot, leafPath) {
        super(
            `Extra rendered file not claimed by any schema at ${valueRoot}${leafPath ? '/' + leafPath : ''}`,
        );
        this.name = "ExtraRenderedFileError";
        this.valueRoot = valueRoot;
        this.leafPath = leafPath;
    }
}
function isExtraRenderedFileError(object) {
    return object instanceof ExtraRenderedFileError;
}

class DuplicateDecodedPathError extends PairedSnapshotError {
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
function isDuplicateDecodedPathError(object) {
    return object instanceof DuplicateDecodedPathError;
}

class DuplicateDecodedValueRootError extends PairedSnapshotError {
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
function isDuplicateDecodedValueRootError(object) {
    return object instanceof DuplicateDecodedValueRootError;
}

class UnsupportedFilesystemEntryError extends PairedSnapshotError {
    constructor(path, kind) {
        super(`Unsupported filesystem entry at ${path}: ${kind}`);
        this.name = "UnsupportedFilesystemEntryError";
        this.path = path;
        this.kind = kind;
    }
}
function isUnsupportedFilesystemEntryError(object) {
    return object instanceof UnsupportedFilesystemEntryError;
}

class FileDirectoryConflictError extends PairedSnapshotError {
    constructor(path, conflictKind) {
        super(`File/directory conflict at ${path}: ${conflictKind}`);
        this.name = "FileDirectoryConflictError";
        this.path = path;
        this.conflictKind = conflictKind;
    }
}
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
