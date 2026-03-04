# Unique Functor

The *unique functor* module (`backend/src/unique_functor.js`) provides a
two-level identity system for creating collision-resistant, type-safe keys at
module scope.

---

## The Problem

Plain string keys are fragile.  Suppose two unrelated modules both decide to
call `sleeper.withMutex("worker", ...)`.  They will silently contend on the
same lock even though they have nothing to do with each other.  The bug only
shows up as unexpected serialisation, and only when both code paths happen to
run concurrently.

The unique-functor module makes this class of bug *impossible*: every lock key
is derived from an identity object that is registered globally at startup, and
the registration throws immediately if the name is already taken.  The conflict
becomes a loud crash at module load time rather than a silent race condition at
runtime.

---

## Concepts

### UniqueFunctor

A `UniqueFunctor` is a named, module-scope singleton.  Think of it as a
*named constructor* for keys.  Once created under a given name, no second
functor can ever carry that same name inside the same process.

```javascript
const myFunctor = makeUniqueFunctor("my-subsystem");
```

Calling `makeUniqueFunctor` twice with the same name throws:

```
Error: Unique functor with name "my-subsystem" already exists
```

This check fires at module initialisation time, before any request has been
served, making it easy to catch.

### UniqueTerm

A `UniqueTerm` is produced by *instantiating* a functor with a list of string
arguments.  It is the actual key object used at runtime.

```javascript
const key = myFunctor.instantiate(["/home/user/repo"]);
```

A functor can be instantiated as many times as needed.  The same functor with
the same arguments always serializes to the same string; the same functor with
different arguments produces different keys.

---

## Serialization

`UniqueTerm.serialize()` returns a canonical string of the form:

```
<functorName>(<arg1>,<arg2>,...)
```

For example:

| Functor name | Arguments | `serialize()` result |
|---|---|---|
| `"gitstore-operation"` | `["/home/user/repo"]` | `"gitstore-operation(/home/user/repo)"` |
| `"migration"` | `["v2", "v3"]` | `"migration(v2,v3)"` |
| `"incremental-graph-operations"` | `[]` | `"incremental-graph-operations()"` |

This string is consumed internally by `sleeper.withMutex` as the map key for
the promise chain.  Application code never has to construct or compare these
strings directly.

---

## Nominal Typing

Both `UniqueFunctor` and `UniqueTerm` carry a `__brand` field that is declared
but never assigned.  This makes the types structurally opaque from the
perspective of JSDoc type inference: a plain object `{ name, args, serialize }`
will not satisfy the `UniqueTerm` type even if it has the right structure.  The
only way to obtain a value that satisfies the type is to go through
`makeUniqueFunctor` and `.instantiate()`.

---

## Usage Pattern

The recommended pattern is:

1. **At module scope** — create the functor once.
2. **Per operation** — instantiate a term with the runtime parameters.

```javascript
const { makeUniqueFunctor } = require("../../unique_functor");

// Registered once when the module is first loaded.
const myFunctor = makeUniqueFunctor("my-subsystem");

async function doWork(capabilities, resourcePath) {
    const key = myFunctor.instantiate([resourcePath]);
    return capabilities.sleeper.withMutex(key, async () => {
        // … exclusive access to resourcePath …
    });
}
```

When no parameterisation is needed (a single global lock for a subsystem), pass
an empty array:

```javascript
const MUTEX_KEY = makeUniqueFunctor("my-global-lock").instantiate([]);
```

---

## Type Guards

The module exports `isUniqueTerm` and `isUniqueFunctor` for `instanceof`-based
narrowing:

```javascript
const { isUniqueTerm, isUniqueFunctor } = require("./unique_functor");

if (isUniqueTerm(value)) {
    // value is UniqueTermClass here
    console.log(value.serialize());
}
```

---

## Examples in the Codebase

| Location | Functor name | Arguments | Purpose |
|---|---|---|---|
| `backend/src/gitstore/mutex.js` | `"gitstore-operation"` | `[workingPath]` | Serialises `checkpoint` and `transaction` per repository path |
| `backend/src/generators/incremental_graph/lock.js` | `"incremental-graph-operations"` | `[]` | Global lock for incremental-graph `invalidate`, `pull`, and `runMigration` |

---

## API Reference

### `makeUniqueFunctor(name)`

| Parameter | Type | Description |
|---|---|---|
| `name` | `string` | Globally unique human-readable identifier. |

Returns a `UniqueFunctor`.  Throws if `name` was already registered.

### `UniqueFunctor.instantiate(args)`

| Parameter | Type | Description |
|---|---|---|
| `args` | `string[]` | Runtime parameters for this term. |

Returns a `UniqueTerm`.

### `UniqueTerm.serialize()`

Returns a `string` of the form `"<name>(<arg1>,<arg2>,…)"`.

### `isUniqueTerm(object)`

Returns `true` if `object` is a `UniqueTerm` instance.

### `isUniqueFunctor(object)`

Returns `true` if `object` is a `UniqueFunctor` instance.
