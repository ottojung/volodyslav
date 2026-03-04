
class UniqueTermClass {
    name;
    args;

    /**
     * @private
     * @type {undefined} __brand - A branding property to enforce nominal typing. This property is never set and serves only to prevent structural typing from treating this class as interchangeable with others.
     */
    __brand;

    /**
     * @param {string} name - The name of the unique term, typically derived from the functor's name for debugging purposes.
     * @param {Array<string>} args - The arguments associated with this unique term. These can be any values relevant to the term's semantics.
     */
    constructor(name, args) {
        this.name = name;
        this.args = args;
        if (this.__brand !== undefined) {
            throw new Error("Nominal class invariant violated: __brand should be undefined");
        }
    }

    /**
     * Serializes the functor with its arguments into a string representation.
     * @returns {string} A string representation of the functor with its arguments.
     */
    serialize() {
        return `${this.name}(${this.args.map(arg => arg.toString()).join(",")})`;
    }
}

// A nominal class for unique functors.
class UniqueFunctorClass {
    /** @type {string} */
    name;

    /**
     * @private
     * @type {undefined}
     */
    __brand;

    /**
     * @param {string} name - The unique name for this functor instance. This is used for debugging and error messages, but does not affect the uniqueness guarantee.
     */
    constructor(name) {
        this.name = name;
        if (this.__brand !== undefined) {
            throw new Error("Nominal class invariant violated: __brand should be undefined");
        }
    }

    /**
     * Instantiates a unique term with the given arguments.
     * @param {Array<string>} args - The arguments for the unique term.
     * @returns {UniqueTermClass} A unique term instance.
     */
    instantiate(args) {
        return new UniqueTermClass(this.name, args);
    }
}

/**
 * Factory function to create unique functors. Ensures that each functor name is unique across the application.
 * @param {string} name - The unique name for the functor.
 * @returns {UniqueFunctorClass} A unique functor instance.
 * @throws {Error} If a functor with the given name already exists.
 */
const EXISTING = new Map();

/**
 * Creates a unique functor with the given name. If a functor with the same name already exists, an error is thrown to prevent duplicates.
 *
 * @param {string} name - The unique name for the functor.
 * @returns {UniqueFunctorClass} A unique functor instance.
 * @throws {Error} If a functor with the given name already exists.
 */
function makeUniqueFunctor(name) {
    if (EXISTING.has(name)) {
        throw new Error(`Unique functor with name "${name}" already exists`);
    }

    const functor = new UniqueFunctorClass(name);
    EXISTING.set(name, functor);
    return functor;
}

/**
 * @typedef {UniqueFunctorClass} UniqueFunctor
 * @typedef {UniqueTermClass} UniqueTerm
 */

module.exports = {
    makeUniqueFunctor,
};
