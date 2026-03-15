# Encoding Needs: `decodeUrlArg` and Argument Encoding

## 1. Executive Summary

Two independent but structurally similar encoding schemes exist in this codebase:
one for **HTTP URL path segments** (`graph_helpers.js`) and one for **filesystem
paths** (`database/render.js`).  Both are required, each for distinct and
well-founded reasons.  The schemes share a common design idiom (the `~` prefix
for non-string types) as a deliberate engineering choice.  Neither encoding is
accidental or vestigial.

---

## 2. The Root Cause: `ConstValue` Across String-Only Channels

The incremental graph identifies every node instance by a `NodeKey`:

```
{ head: string, args: Array<ConstValue> }
```

`ConstValue` is a recursive JSON-serialisable type:

```
number | string | boolean | Array<ConstValue> | Record<string, ConstValue>
```

Both HTTP URL paths and POSIX filesystem paths are fundamentally
**flat strings of Unicode characters**, with certain characters reserved for
structure (the path separator `/`).  Conveying an arbitrary `ConstValue` across
either channel therefore requires an encoding that:

1. Keeps each argument within a single path segment (no false structural splits).
2. Preserves the original type so it can be round-tripped losslessly.
3. Avoids reserved characters whose presence would corrupt the containing
   structure.

These three requirements drive every design decision in both encoding schemes.

---

## 3. URL Argument Encoding (`graph_helpers.js`)

### 3.1 Context

The REST graph API exposes node instances through paths of the form:

```
GET  /api/graph/nodes/:head/:arg0[/:arg1[/:arg2…]]
POST /api/graph/nodes/:head/:arg0[/:arg1[/:arg2…]]
DELETE /api/graph/nodes/:head/:arg0[/:arg1[/:arg2…]]
```

Each `/:argN` segment in the URL carries one element of `args`.

### 3.2 Problems Without Encoding

**Problem 1 — Slash ambiguity.**  An argument value that is itself a string
containing `/` (e.g., a file path like `/audio/recording.mp3`) would be
tokenised as multiple path segments by Express before the route handler ever
sees it.  The route would receive two args instead of one; the node identity
would be corrupted.

**Problem 2 — Type erasure.**  HTTP paths carry only strings.  A node
parameterised by the integer `100` (e.g., `last_entries(100)`) is semantically
distinct from one parameterised by the string `"100"`.  Without additional
marking the server cannot distinguish them, and the wrong node would be looked
up.

### 3.3 The `decodeUrlArg` Scheme

The encoding rules (applied after `decodeURIComponent` to each segment):

| Raw segment | Decoded value |
|---|---|
| `~~…rest` | String `"~rest"` (escaped tilde prefix) |
| `~…rest` | `JSON.parse(rest)` → a non-string `ConstValue` |
| anything else | Plain string (no further transformation) |

Constants:

```javascript
const NON_STRING_ARG_PREFIX = "~";
const ESCAPED_STRING_ARG_PREFIX = "~~";
```

**Slash preservation.**  Express's wildcard capture `/:head/*` joins all
remaining segments with `/`.  If a client sends `GET /api/graph/nodes/event/foo%2Fbar`,
Express decodes this to `foo/bar` in the plain param, making it look like two
args.  `getArgsFromRequest` avoids this by reading the *raw* `req.url` (which
still has `%2F` unexpanded), locating the raw wildcard tail, splitting on literal
`/`, and then calling `decodeURIComponent` on each individual segment before
applying `decodeUrlArg`.  This correctly yields one arg `"foo/bar"`.

**Type round-trip.**  A numeric arg `100` is sent as `~100` in the URL path.
`decodeUrlArg` recognises the `~` prefix, strips it, and calls `JSON.parse("100")`
to recover the number `100`.  The string `"100"` is sent without a prefix and
recovered as-is.

**Tilde escape.**  A string that legitimately starts with `~` (e.g. `"~tilde-id"`)
is sent as `~~tilde-id`.  `decodeUrlArg` recognises the double tilde, strips one
tilde, and returns the string `"~tilde-id"`.  Without this escape the string
`"~tilde-id"` would be misinterpreted as the JSON value produced by
`JSON.parse("tilde-id")`, which would throw or produce `NaN`.

### 3.4 Verdict

The URL encoding is **fully justified**.  Without it:
- Argument values containing `/` would silently corrupt node identity.
- Non-string argument types (numbers, booleans) would silently be coerced to
  strings, causing cache misses and wrong results.

---

## 4. Filesystem Argument Encoding (`database/render.js`)

### 4.1 Context

The live LevelDB database is periodically rendered to a git-tracked directory
tree (via `renderToFilesystem`) so that incremental graph state can be versioned,
diffed, and restored (`scanFromFilesystem`).  The rendering maps each raw LevelDB
key to a relative filesystem path:

```
!namespace!!sublevel!{"head":"event","args":["/audio/file.mp3"]}
    ↓  keyToRelativePath()
namespace/sublevel/event/%2Faudio%2Ffile.mp3
```

The inverse mapping (`relativePathToKey`) must be an exact bijection.

### 4.2 The Structure of Raw LevelDB Keys

LevelDB sublevel keys are structured as:

```
!sub1!!sub2!keyContent
```

The `!` character is the sublevel separator.  `keyContent` for data sublevels
(values, freshness, inputs, revdeps, counters, timestamps) is NodeKey JSON:

```json
{"head":"event","args":["evt-abc123"]}
```

### 4.3 Problems Without Encoding

**Problem 1 — Slash in argument values.**  An argument string like
`"/audio/recording.mp3"` written as a literal filesystem path segment would
create a directory at the root of the output tree.  The path
`namespace/sublevel/event//audio/recording.mp3` would be misinterpreted as
`namespace/sublevel/event/` (root-relative path) or parsed as having an empty
segment.

**Problem 2 — Exclamation mark.**  The `!` character is the LevelDB sublevel
separator.  An argument value containing `!` written literally into a filesystem
path would corrupt the reverse mapping: `relativePathToKey` would mistake the
literal `!` for part of a sublevel name and reconstruct the wrong LevelDB key.

**Problem 3 — Percent sign.**  If `%` were written literally into path segments,
a subsequent decode pass (e.g., by `scanFromFilesystem`) might interpret it as
the start of a percent-escape sequence and produce a double-decoded value.  The
rule "encode `%` first as `%25`" prevents this.

**Problem 4 — Dot segments.**  POSIX filesystems treat `.` and `..` as the
current and parent directories.  An argument that is literally `"."` or `".."`
would be collapsed or traversed by the OS, silently destroying the path.  The
sentinels `%2E` and `%2E%2E` represent these strings on disk without triggering
OS-level path resolution.

**Problem 5 — Type erasure** (same as URL context).  Argument values that are
numbers, booleans, or nested structures would be indistinguishable from strings
once converted to path segments.

### 4.4 The `encodeSegment` / `encodeArg` Scheme

**`encodeSegment(s)`** percent-encodes a plain string for use as a single
filesystem path component:

| Input | Output |
|---|---|
| `"."` | `"%2E"` (sentinel) |
| `".."` | `"%2E%2E"` (sentinel) |
| string with `%` | `%` → `%25` first, then `/` → `%2F`, `!` → `%21` |
| other string | `%25`, `%2F`, `%21` applied in order |

Encoding `%` before `/` and `!` prevents double-encoding: a literal `%2F` in an
argument would otherwise become `%252F` after encoding, which would then
incorrectly decode to `%2F` (a slash) instead of the original string `%2F`.

**`encodeArg(arg)`** layers type tagging on top of `encodeSegment`:

| Argument type | Encoded segment |
|---|---|
| string not starting with `~` | `encodeSegment(arg)` |
| string starting with `~` | `"~~" + encodeSegment(arg.slice(1))` |
| non-string (number, boolean, etc.) | `"~" + encodeSegment(JSON.stringify(arg))` |

**`decodeSegment(s)`** reverses `encodeSegment`: accepts both uppercase and
lowercase sentinel forms for tolerance of manually created snapshots.

**`decodeArg(segment)`** reverses `encodeArg`.

### 4.5 The Bijection Guarantee

The encoding is designed so that for every key generated by this database:

```
relativePathToKey(keyToRelativePath(key)) === key
```

This bijection is the correctness property that makes `renderToFilesystem` and
`scanFromFilesystem` reliable inverses of each other.  The `resolveContainedPath`
guard provides an additional security check: after encoding, the resolved path
must still fall within the output directory, preventing path-traversal attacks
even in the presence of edge-case inputs.

### 4.6 Verdict

The filesystem encoding is **fully justified**.  Without it:
- Arguments containing `/` would create malformed or incorrect directory trees.
- Arguments containing `!` would produce keys that round-trip to a different LevelDB key.
- Arguments `"."` or `".."` would cause OS-level directory traversal.
- Arguments containing `%` could double-decode and produce the wrong string.
- Non-string arguments would lose their type on round-trip.

---

## 5. Why the Two Schemes Share the `~` Prefix

The URL scheme (`graph_helpers.js`) mirrors the filesystem scheme
(`database/render.js`) in its use of `~` as the type-tagging prefix.  The
comment in `graph_helpers.js` makes this explicit:

> "This mirrors the encoding used for filesystem paths in `database/render.js`."

This is a deliberate engineering choice.  A single mental model covers both
contexts: `~<JSON>` always means "non-string ConstValue encoded as JSON", and
`~~<rest>` always means "string starting with `~`".  The frontend (`DescriptionEntry/api.js`)
constructs a URL with `~${SORTED_EVENTS_CACHE_SIZE}` to send a numeric argument
via HTTP, consistent with the same convention.

The two schemes are **not** identical at the `%`-encoding level:

| Concern | URL scheme | Filesystem scheme |
|---|---|---|
| Slash in arg | `%2F` (preserved by reading raw URL) | `%2F` via `encodeSegment` |
| Exclamation | Not needed (valid in URLs) | `%21` via `encodeSegment` |
| Percent | Handled by `decodeURIComponent` | `%25` applied first |
| Dot/double-dot | Not a concern in URL paths | `%2E` / `%2E%2E` sentinels |
| Type tagging | `~` prefix + JSON | `~` prefix + JSON |

Each scheme encodes exactly the characters that are dangerous in its own channel.
No excess encoding is applied.

---

## 6. Summary of Findings

| Question | Answer |
|---|---|
| Why does `decodeUrlArg` exist? | To recover typed `ConstValue` arguments from URL path segments where all data is inherently text. |
| Why are URL slashes percent-encoded? | A `/` inside an argument value would be misinterpreted as a path separator, changing node identity. Express must be bypassed to preserve `%2F` inside args. |
| Why does `encodeSegment` exist? | To write LevelDB keys faithfully as filesystem paths without corrupting the inverse mapping. |
| Why does the filesystem encoding also use `~`? | It reuses the same type-tagging convention as the URL scheme to form a single coherent mental model. |
| Is all of this justified? | Yes. Each encoded character is dangerous in its channel; the encoding is the minimal necessary transformation to preserve correctness and security. |
| Are there redundancies or unnecessary steps? | No. Each rule addresses a distinct failure mode that has been validated by the test suite (`database_render.test.js`, `graph_routes.test.js`). |
