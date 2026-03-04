
/**
 * Unique functor and term module.
 *
 * This module provides a two-level identity system for creating
 * collision-resistant, type-safe keys at module scope.
 *
 * ## The problem it solves
 *
 * Plain string keys (e.g. `"my-mutex"`) are fragile: two unrelated subsystems
 * can accidentally use the same string, causing them to contend on the same
 * lock or share state they should not share.  A global registry of *unique
 * names* catches such collisions at startup time, long before they cause
 * hard-to-reproduce bugs.
 *
 * ## The two-level structure
 *
 * A **UniqueFunctor** is a named, singleton identity, registered once at module
 * load time.  Think of it as a named constructor.  You can never obtain two
 * distinct `UniqueFunctor` objects with the same name.
 *
 * A **UniqueTerm** is a value produced by applying a functor to a concrete list
 * of string arguments.  It is the thing that gets used as a key (e.g. for a
 * mutex).
 *
 * ```
 * const myFunctor = makeUniqueFunctor("my-subsystem");  // registered once
 * const key1 = myFunctor.instantiate(["/path/to/repo"]); // per-path key
 * const key2 = myFunctor.instantiate(["/other/repo"]);   // different key
 * ```
 *
 * `key1.serialize()` → `"my-subsystem(/path/to/repo)"`
 * `key2.serialize()` → `"my-subsystem(/other/repo)"`
 *
 * ## Nominal typing
 *
 * Both classes use a `__brand` field (never assigned) to make the types
 * structurally distinct from plain objects, preventing accidental substitution
 * via JSDoc type-casting.
 *
 * ## Typical usage
 *
 * ```javascript
 * // module-level — runs once at startup
 * const myFunctor = makeUniqueFunctor("my-subsystem");
 *
 * // per-operation — instantiate with the varying parameters
 * async function doWork(capabilities, resourcePath) {
 *     const key = myFunctor.instantiate([resourcePath]);
 *     return capabilities.sleeper.withMutex(key, async () => {
 *         // exclusive access to resourcePath here
 *     });
 * }
 * ```
 *
 * @module unique_functor
 */

/**
 * A concrete, immutable key produced by applying a UniqueFunctor to a list of
 * string arguments.  Used as the identity token for operations such as mutex
 * locking.
 *
 * Do not construct directly; use `UniqueFunctor.instantiate()`.
 */
class UniqueTermClass {
    /** @type {string} The functor name, used in serialization and debugging. */
    name;

    /** @type {Array<string>} The arguments bound to this term. */
    args;

    /**
     * @private
     * @type {undefined} Branding property that enforces nominal typing and
     *   prevents structural substitution with plain objects.  It is never
     *   assigned; its sole purpose is to make this class opaque to JSDoc type
     *   inference.
     */
    __brand;

    /**
     * @param {string} name - Functor name, inherited from the parent
     *   `UniqueFunctorClass`.  Used in serialization and debug output.
     * @param {Array<string>} args - The concrete arguments that distinguish
     *   one term from another under the same functor.
     */
    constructor(name, args) {
        this.name = name;
        this.args = args;
        if (this.__brand !== undefined) {
            throw new Error("Nominal class invariant violated: __brand should be undefined");
        }
    }

    /**
     * Returns a canonical string representation of this term that is suitable
     * for use as a map key.
     *
     * Format: `"<name>(<arg1>,<arg2>,...)"` — for example,
     * `"gitstore-operation(/home/user/repo)"`.
     *
     * Two terms are considered equal if and only if their serializations are
     * equal.
     *
     * @returns {string}
     */
    serialize() {
        return `${this.name}(${this.args.map(arg => arg.toString()).join(",")})`;
    }
}

/**
 * A named, module-scope identity token.  Registered globally on creation so
 * that no two functors can share the same name within a process.
 *
 * Do not construct directly; use `makeUniqueFunctor()`.
 */
class UniqueFunctorClass {
    /** @type {string} The globally unique name of this functor. */
    name;

    /**
     * @private
     * @type {undefined} Branding property — see `UniqueTermClass.__brand`.
     */
    __brand;

    /**
     * @param {string} name - The human-readable, globally unique name.
     *   Used in error messages, serialization, and debugging.
     */
    constructor(name) {
        this.name = name;
        if (this.__brand !== undefined) {
            throw new Error("Nominal class invariant violated: __brand should be undefined");
        }
    }

    /**
     * Produces a `UniqueTermClass` by binding this functor to a concrete list
     * of string arguments.
     *
     * @param {Array<string>} args - The arguments that parameterise this term.
     *   Pass an empty array `[]` when no parameterisation is needed (singleton
     *   key).
     * @returns {UniqueTermClass}
     */
    instantiate(args) {
        return new UniqueTermClass(this.name, args);
    }
}

/**
 * Process-wide registry.  Maps every functor name that has been registered to
 * the corresponding `UniqueFunctorClass` instance.  Checked on every call to
 * `makeUniqueFunctor` to guarantee uniqueness.
 *
 * @type {Map<string, UniqueFunctorClass>}
 */
const EXISTING = new Map();

/**
 * Creates and registers a new unique functor.
 *
 * Each name may only be registered once per process.  Call this at module scope
 * so the duplicate check runs at startup rather than at runtime.
 *
 * @param {string} name - A globally unique, human-readable identifier for the
 *   functor.  Appears in serialized keys and error messages.
 * @returns {UniqueFunctorClass}
 * @throws {Error} If a functor with the same name has already been registered.
 *
 * @example
 * // At the top of a module:
 * const myFunctor = makeUniqueFunctor("my-subsystem");
 *
 * // Later, per operation:
 * const key = myFunctor.instantiate([resourceId]);
 * await sleeper.withMutex(key, procedure);
 */
function makeUniqueFunctor(name) {
    if (EXISTING.has(name)) {
        throw new Error(`Unique functor with name ${JSON.stringify(name)} already exists`);
    }

    const functor = new UniqueFunctorClass(name);
    EXISTING.set(name, functor);
    return functor;
}

/**
 * Returns `true` when `object` is a `UniqueTermClass` instance.
 *
 * @param {unknown} object
 * @returns {object is UniqueTermClass}
 */
function isUniqueTerm(object) {
    return object instanceof UniqueTermClass;
}

/**
 * Returns `true` when `object` is a `UniqueFunctorClass` instance.
 *
 * @param {unknown} object
 * @returns {object is UniqueFunctorClass}
 */
function isUniqueFunctor(object) {
    return object instanceof UniqueFunctorClass;
}

/**
 * @typedef {UniqueFunctorClass} UniqueFunctor
 * @typedef {UniqueTermClass} UniqueTerm
 */

module.exports = {
    makeUniqueFunctor,
    isUniqueTerm,
    isUniqueFunctor,
};
