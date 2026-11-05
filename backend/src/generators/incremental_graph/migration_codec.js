/**
 * The directed source->target Journal format codec of a Journal-aware migration.
 *
 * `incremental-graph-journal-migrations.md` §9a gives Journal-aware representation
 * change exactly one mechanism: a pure directed source->target
 * `JournalFormatCodec`. A codec changes representation only. It never decides
 * semantic occurrence identity, never authors a record and never reads the
 * replica — the semantic decisions of §11 own that, and `migration_m1.js` owns
 * the records they author.
 *
 * The rewrite a codec is applied by, and the target-key view of the migration's
 * materialized set, live in `journal_rewrite.js`.
 */

const { makeJournalVersionCompatibilityError } = require("./journal");

/** @typedef {import('./database/node_key').NodeKey} NodeKey */
/** @typedef {import('./database/types').ComputedValue} ComputedValue */

/**
 * The rejection §9a requires when retained history has no deterministic target
 * representation, when a codec transform is not total, or when a rewrite this
 * replica performs observes a NodeKey collision.
 *
 * @typedef {ReturnType<typeof makeJournalVersionCompatibilityError>} CodecRejection
 */

/**
 * The two transforms a `JournalFormatCodec` may declare.
 *
 * §9a: an omitted transform defaults to the identity transform, so a transition
 * which changes nothing about either representation declares neither.
 *
 * @typedef {object} JournalFormatCodecTransforms
 * @property {(sourceKey: NodeKey) => NodeKey} [rewriteNodeKey]
 * @property {(sourceKey: NodeKey, payload: ComputedValue) => ComputedValue} [rewriteComputedValue]
 */

/**
 * The properties that this class carries are:
 * - `rewriteNodeKey` and `rewriteComputedValue` are both callable, so no caller
 *   tests whether a transform was declared: §9a's identity default is settled at
 *   construction;
 * - neither transform is an async or a generator function, so a rewrite which
 *   reached the filesystem, the clock, the network or a database handle could
 *   not present itself as one;
 * - the codec is frozen, so a migration definition cannot change its own
 *   transition halfway through rewriting retained history.
 *
 * The proof of those properties is guaranteed by:
 * - This class can only be introduced through `makeJournalFormatCodec(...)` and
 *   `makeIdentityJournalFormatCodec()`.
 * - `makeJournalFormatCodec(...)` satisfies the first property because it
 *   installs the declared transform when one is given and the identity transform
 *   when it is omitted, and rejects a declared value which is not a function.
 * - `makeJournalFormatCodec(...)` satisfies the second property because it
 *   rejects a transform whose own constructor is `AsyncFunction` or
 *   `GeneratorFunction`, and `makeHistoryRewriter(...)` additionally rejects a
 *   transform result which is a thenable.
 * - `makeJournalFormatCodec(...)` and `makeIdentityJournalFormatCodec()`
 *   satisfy the third property because each freezes the instance before
 *   returning it.
 */
class JournalFormatCodecClass {
    /**
     * @param {(sourceKey: NodeKey) => NodeKey} rewriteNodeKey
     * @param {(sourceKey: NodeKey, payload: ComputedValue) => ComputedValue} rewriteComputedValue
     */
    constructor(rewriteNodeKey, rewriteComputedValue) {
        this.rewriteNodeKey = rewriteNodeKey;
        this.rewriteComputedValue = rewriteComputedValue;
        Object.freeze(this);
    }
}

/** @typedef {JournalFormatCodecClass} JournalFormatCodec */

/**
 * A codec which rewrites neither representation: the transition of a Journal
 * whose retained history already is target-format.
 * @returns {JournalFormatCodec}
 */
function makeIdentityJournalFormatCodec() {
    return new JournalFormatCodecClass(
        (sourceKey) => sourceKey,
        (_sourceKey, payload) => payload
    );
}

/**
 * @param {unknown} transform
 * @returns {boolean}
 */
function isSynchronousFunction(transform) {
    if (typeof transform !== "function") {
        return false;
    }
    const constructorName = Object.getPrototypeOf(transform).constructor.name;
    return constructorName !== "AsyncFunction" && constructorName !== "GeneratorFunction";
}

/**
 * Build the source->target codec of one migration definition.
 * @param {JournalFormatCodecTransforms} [transforms]
 * @returns {JournalFormatCodec | CodecRejection}
 */
function makeJournalFormatCodec(transforms) {
    const declared = transforms ?? {};
    /** @type {(sourceKey: NodeKey) => NodeKey} */
    let rewriteNodeKey;
    /** @type {(sourceKey: NodeKey, payload: ComputedValue) => ComputedValue} */
    let rewriteComputedValue;
    const declaredNodeKeyTransform = declared.rewriteNodeKey;
    const declaredValueTransform = declared.rewriteComputedValue;
    if (declaredNodeKeyTransform === undefined) {
        rewriteNodeKey = (sourceKey) => sourceKey;
    } else if (isSynchronousFunction(declaredNodeKeyTransform)) {
        rewriteNodeKey = declaredNodeKeyTransform;
    } else {
        return makeJournalVersionCompatibilityError(
            "the migration definition's journal format codec declares a rewriteNodeKey which is not a synchronous function",
            "a synchronous rewriteNodeKey",
            String(typeof declaredNodeKeyTransform)
        );
    }
    if (declaredValueTransform === undefined) {
        rewriteComputedValue = (_sourceKey, payload) => payload;
    } else if (isSynchronousFunction(declaredValueTransform)) {
        rewriteComputedValue = declaredValueTransform;
    } else {
        return makeJournalVersionCompatibilityError(
            "the migration definition's journal format codec declares a rewriteComputedValue which is not a synchronous function",
            "a synchronous rewriteComputedValue",
            String(typeof declaredValueTransform)
        );
    }
    return new JournalFormatCodecClass(rewriteNodeKey, rewriteComputedValue);
}

/**
 * @param {unknown} object
 * @returns {object is JournalFormatCodec}
 */
function isJournalFormatCodec(object) {
    return object instanceof JournalFormatCodecClass;
}

module.exports = {
    isJournalFormatCodec,
    makeIdentityJournalFormatCodec,
    makeJournalFormatCodec,
};
