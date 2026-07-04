# IncrementalGraph Journal Node Filter

## Purpose

A `NodeFilter` restricts journal queries to a specific set of node keys. It is used as the `to` parameter of `graph.possibleMaybeChanges` so that journal consumers ask only about changes to the part of the graph they depend on.

`NodeFilter` is an **object API**, not a parseable string language.

---

## Types

### NodeFilter

```js
/**
 * Describes a set of node keys.
 * @typedef {Wildcard | GroundFilter | UnionFilter} NodeFilter
 */
```

A `NodeFilter` is one of the following concrete variants.

### Wildcard

```js
/**
 * When used as a top-level NodeFilter, matches every node key.
 * When used inside GroundFilter.args, matches one top-level argument value.
 * @typedef {object} Wildcard
 * @property {'wildcard'} variant
 */
```

A `Wildcard` has two distinct meanings depending on context:

- **As a top-level `NodeFilter`:** `Wildcard` matches every node key. Passing `makeWildcard()` directly as the `to` parameter of `graph.possibleMaybeChanges` returns possible changes for all nodes.

- **Inside `GroundFilter.args`:** A `Wildcard` at a particular argument position matches any single `ConstValue` at that position. It does not match arbitrary-length or zero-length sequences. It does not match nested structure.

### GroundFilter

```js
/**
 * Matches concrete node keys: an exact head plus an argument list.
 * Each argument position is either a concrete ConstValue or a Wildcard.
 * @typedef {object} GroundFilter
 * @property {'ground'} variant
 * @property {NodeName} head
 * @property {Array<ConstValue | Wildcard>} args
 */
```

A `GroundFilter` matches node keys whose `NodeName` equals `head` and whose binding array length equals `args.length`. Each binding position is compared against the corresponding filter argument:

- If the filter argument is a `ConstValue`, the binding at that position must be `isEqual` to it.
- If the filter argument is a `Wildcard`, the binding at that position matches regardless of its value.

### UnionFilter

```js
/**
 * Matches the union of two NodeFilter sets.
 * @typedef {object} UnionFilter
 * @property {'union'} variant
 * @property {NodeFilter} left
 * @property {NodeFilter} right
 */
```

A `UnionFilter` matches a node key if it is matched by `left` or by `right`.

---

## Construction

### makeWildcard

```js
/**
 * @returns {Wildcard}
 */
function makeWildcard()
```

Returns a fresh `Wildcard`.

### makeGroundFilter

```js
/**
 * @param {NodeName} head
 * @param {Array<ConstValue | Wildcard>} args
 * @returns {GroundFilter}
 */
function makeGroundFilter(head, args)
```

Returns a `GroundFilter` with the given head and argument list.

`args` MUST NOT contain values other than values satisfying the `ConstValue` definition or `Wildcard` values. Implementations SHOULD validate this at construction and throw if the array contains invalid elements.

### makeUnionFilter

```js
/**
 * @param {NodeFilter} left
 * @param {NodeFilter} right
 * @returns {UnionFilter}
 */
function makeUnionFilter(left, right)
```

Returns a `UnionFilter` combining `left` and `right`.

---

## Matching

### DEF-NF-MATCH-01 (NodeFilter Match)

A `NodeFilter` `F` matches a node key `K = (nodeName, bindings)` if and only if:

- `F` is a `Wildcard` — matches every node key unconditionally. This covers the case where `Wildcard` is used as a top-level filter.
- `F` is a `GroundFilter` — `F.head` equals `nodeName` AND `bindings.length` equals `F.args.length` AND for every position `i`, `F.args[i]` matches `bindings[i]`:
  - If `F.args[i]` is a `ConstValue`: `isEqual(F.args[i], bindings[i])` returns `true`.
  - If `F.args[i]` is a `Wildcard`: always matches. This covers the case where `Wildcard` is used inside `GroundFilter.args`.
- `F` is a `UnionFilter` — `F.left` matches `K` OR `F.right` matches `K`.

REQ-NF-02: A `GroundFilter` with `args = []` matches only arity-0 nodes with the given head.

REQ-NF-03: A `GroundFilter` with `args` containing only `ConstValue` entries and no `Wildcard` entries matches exactly one node key (the node key obtained by combining the head with the argument values). If multiple node keys in the graph satisfy this, the filter still matches all of them, but normal graph identity rules ensure at most one such node exists.

REQ-NF-04: A `GroundFilter` MUST NOT match a node key whose arity differs from `args.length`. Arity is determined by the schema for the head; see `incremental-graph.md` §1.2.5.

---

## Type guards

REQ-NF-05: Implementations MUST expose type guards for use at serialization, deserialization, and storage boundaries where untyped `unknown` data is converted into the nominal `NodeFilter` type. At internal call sites where the type is already known, runtime re-verification is not required.

```js
/**
 * @param {unknown} value
 * @returns {value is NodeFilter}
 */
function isNodeFilter(value)
```

```js
/**
 * @param {unknown} value
 * @returns {value is Wildcard}
 */
function isWildcard(value)
```

```js
/**
 * @param {unknown} value
 * @returns {value is GroundFilter}
 */
function isGroundFilter(value)
```

```js
/**
 * @param {unknown} value
 * @returns {value is UnionFilter}
 */
function isUnionFilter(value)
```

---

## Equality and normalization

REQ-NF-06: Two `NodeFilter` values are **structurally equal** (as used by the implementation for identity, deduplication, and comparison) if and only if they satisfy the following structural equality rules:

1. All `Wildcard` values are equal to each other. Two freshly constructed `Wildcard` values are always equal.
2. Two `GroundFilter` values are equal if their `head` values are equal (same `NodeName`) AND their `args` arrays are position-wise equal, where each argument pair is compared as follows:
   - `Wildcard` equals `Wildcard`.
   - `ConstValue` equals `ConstValue` when `isEqual` returns `true`.
   - `Wildcard` does not equal any `ConstValue`, and vice versa.
3. Two `UnionFilter` values are equal if `(left₁ = left₂ AND right₁ = right₂)` OR `(left₁ = right₂ AND right₁ = left₂)`. Union is commutative.

This is structural equality, not semantic set equality. Two filters that represent the same set of node keys may not be structurally equal under these rules. For example:

- `Union(A, Union(B, C))` and `Union(Union(A, B), C)` represent the same set (union is associative), but are not structurally equal.
- `Union(A, A)` and `A` represent the same set (union is idempotent), but are not structurally equal.
- `Union(Wildcard, A)` and `Wildcard` represent the same set (union with wildcard absorbs), but are not structurally equal.

Implementations MAY normalize filters into a canonical structural form during construction. They MUST NOT introduce or eliminate match results as a consequence of normalization.

REQ-NF-07: Implementations MAY normalize nested unions into a canonical form (e.g., flatten `Union(Union(A, B), C)` into a flat set). They MUST NOT introduce or eliminate match results as a consequence of normalization.

---

## Future work (out of scope)

The following are explicitly out of scope for the initial specification:

- Nested wildcard matching (wildcards that match sub-structure within a `ConstValue`).
- Variable-length wildcards (matching zero or more arguments).
- Negation / exclusion filters.
- Pattern-based filters using string pattern syntax.
- Filter combinators beyond union (e.g., intersection, difference).
- Filter serialization / deserialization.

If future versions need these, they should be added as new filter variant types rather than changing the behavior of existing variants.
