---
title: Exploded JSON Value Rendering
---

# Exploded JSON Value Rendering

## 1. Status and normative language

This document specifies the rendered-database snapshot format for exploded JSON
values. It defines the filesystem representation, its inverse scan operation,
canonicalization, validation, reconciliation, and compatibility boundary.

The key words **MUST**, **MUST NOT**, **SHOULD**, **SHOULD NOT**, and **MAY** are
normative.

This is a format specification. Names of private functions, classes, adapters,
and error types are implementation details unless this document explicitly
makes an observable behavior normative.

## 2. Purpose

A rendered database is both a synchronization artifact and a human-inspectable
view of database state. Rendering each database value as one JSON file preserves
data reliably, but nested values remain opaque to ordinary filesystem tools.
A change to one deeply nested property changes the whole value file.

Exploded JSON rendering maps:

- objects to directories whose children are object properties;
- arrays to directories whose children are array elements; and
- strings, numbers, and null to plain files.

This makes nested values useful with `tree`, `cat`, `grep`, `find`, and Git diffs.
String leaves contain the string itself rather than JSON string syntax.

Because plain leaf text does not identify its JSON type, every rendered value
has a parallel, local type-schema file. The rendered subtree and type-schema
file together are one logical value projection and one logical snapshot format.

## 3. Relationship to the database snapshot model

### 3.1 Identifier-native database keys remain opaque

The database key/path codec and the value codec are separate layers.

A raw database entry has the conceptual form:

```text
raw DB key + DB value
```

The existing key codec maps the raw DB key to one **value root**. It continues
to treat the key content as opaque. In particular, identifier-native graph
sublevels continue to use a node identifier as one encoded key segment:

```text
!r!!values!nodeid123
    |
    +-- rendered value root: r/values/nodeid123
```

Exploding the value MUST NOT parse a node identifier, reconstruct a semantic
`NodeKey`, or interpret `/` inside database key content as path structure.

### 3.2 Value explosion begins below the value root

Only after the raw DB key has been mapped to its value root does the exploded
value codec interpret JSON structure:

```text
raw DB key
  -> encoded value root

DB value
  -> rendered descendants at that value root
  -> one type-schema file at that value root
```

The two codecs therefore use path-segment encoding at different semantic
boundaries:

1. the database-key codec encodes the opaque database key as the final segment
   of the value root; and
2. the exploded-value codec encodes each JSON object key as one descendant
   segment below that root.

Array indices are generated structural segments and are not encoded object
keys.

### 3.3 One logical snapshot, two physical trees

A snapshot root contains two managed sibling trees:

```text
snapshot/
  rendered/
  typesscm/
```

The trees are not independent snapshots and MUST NOT be synchronized as two
unrelated jobs. For each DB entry, they contain one paired value projection:

```text
rendered/<value-root>/...
typesscm/<value-root>
```

The mental model is:

```text
rendered is authoritative for primitive leaf contents
typesscm is authoritative for value shape and primitive types
```

Neither side is sufficient on its own.

### 3.4 Snapshot-format version boundary

Exploded rendering is a **new snapshot format** that replaces the one-file JSON
value representation within a snapshot written in this format. It is not
inferred opportunistically from path shape.

The snapshot container MUST carry an explicit format/version discriminator at
the existing snapshot-format boundary before exploded snapshots are accepted by
production render, scan, synchronization, reset, or migration flows. The exact
field name and version number are left to the implementation plan because the
repository's container-level version negotiation is broader than the value
codec specified here.

Within an exploded-format snapshot:

- every managed DB entry uses the paired `rendered`/`typesscm` representation;
- one-file JSON entries without a matching type-schema file are invalid;
- mixed old and exploded entries are invalid; and
- scanning MUST NOT guess whether a file is an old JSON blob or a new scalar
  leaf.

Automatic migration of an old rendered snapshot is out of scope for this
specification. A separate migration command MAY read the old format and write a
new exploded-format snapshot. The normal exploded scanner MUST reject an old or
mixed snapshot with an error that identifies the unsupported format and the
required migration path.

## 4. Scope

### 4.1 Values covered by the format

The exploded codec is defined for every DB entry selected by a render or scan
operation, including entries in replica sublevels and `_meta` when those entries
are part of the selected snapshot domain. The same projection rules apply to a
value regardless of sublevel.

For example:

```text
raw key: !r!!values!nodeid123
value root: r/values/nodeid123
```

and:

```text
raw key: !_meta!current_replica
value root: _meta/current_replica
```

Both receive a rendered projection and a type-schema file.

A render or scan operation over one top-level sublevel MUST only reconcile the
DB entries and paired filesystem projections in that selected sublevel. It MUST
NOT delete entries in another top-level sublevel.

### 4.2 Supported value domain

The supported value domain is recursive:

```text
JsonValue =
  | string
  | number
  | null
  | { [objectKey: string]: JsonValue }
  | JsonValue[]
```

The following are not values in this format:

- `undefined`;
- booleans;
- functions;
- symbols;
- bigint values;
- non-finite numbers;
- sparse arrays;
- class instances or other objects with non-JSON semantics; and
- cyclic structures.

A renderer MUST reject an unsupported DB value before producing its projection.
A scanner MUST reject a type schema or leaf that attempts to introduce an
unsupported value.

The current graph's broader value contracts must be reconciled with this format
before production adoption if they can persist booleans or another unsupported
kind. That prerequisite is outside this format specification; silently mapping
unsupported kinds to strings or numbers is forbidden.

### 4.3 Numbers

A supported number is a finite JavaScript number representable by JSON. `NaN`,
`Infinity`, and `-Infinity` are invalid.

The canonical rendered text for a number is the result of JSON number
serialization for that number, equivalent to `JSON.stringify(number)` when it
returns a number token. Consequences include:

- `5` renders as `5`;
- `1.5` renders as `1.5`;
- `-3` renders as `-3`;
- `1e+21` may render with exponent notation according to JSON serialization;
- `1e-7` may render with exponent notation according to JSON serialization;
- negative zero canonicalizes to `0`; and
- there is no trailing newline.

A scanned number file MUST contain exactly one JSON number token. Leading or
trailing whitespace and trailing data are invalid. Parsing MUST consume the
whole file and produce a finite number. A valid but noncanonical number token,
such as `1.0` or `1e0`, MAY be accepted; rendering the scanned value writes the
canonical JSON number text (`1`).

## 5. Terminology

### 5.1 Value root

A **value root** is the relative path produced by applying the existing raw DB
key-to-filesystem-path codec to one raw DB key.

Examples:

```text
!r!!values!nodeid123      -> r/values/nodeid123
!r!!global!fingerprint    -> r/global/fingerprint
!_meta!current_replica    -> _meta/current_replica
```

The last segment remains encoded as one segment even if the raw key contains
`/`, `%`, `!`, `.`, `..`, or the empty string.

### 5.2 Rendered value path

A **rendered value path** is a path in `rendered/` at or below a value root.
A scalar occupies the value root itself as a file. A compound value occupies
the value root as a directory and recursively uses descendants.

### 5.3 Type-schema path

The **type-schema path** for a value is exactly the same relative value-root
path in `typesscm/`. It is always one regular file, including when the rendered
value is an object or array directory.

### 5.4 Value projection

A **value projection** is the pair:

```text
{
  rendered entries rooted at rendered/<value-root>,
  type-schema file typesscm/<value-root>
}
```

The projection is the unit of codec validation and DB-value reconstruction.
The flat virtual snapshot used for reconciliation is a flattening of many value
projections, not a weakening of their paired semantics.

### 5.5 Managed domain

The **managed domain** is the set of paths below the `rendered/` and `typesscm/`
roots for the top-level sublevel being rendered or scanned. Reconciliation may
create, replace, or delete any entry in that domain. Paths outside both managed
roots, and paths belonging to unselected top-level sublevels, are not managed by
that operation.

## 6. Type-schema grammar

For every DB value, `typesscm/<value-root>` contains one JSON document matching:

```text
TypeSchema =
  | "string"
  | "number"
  | "null"
  | { [objectKey: string]: TypeSchema }
  | TypeSchema[]
```

Examples:

```json
"string"
```

means a string scalar.

```json
"number"
```

means a number scalar.

```json
"null"
```

means null.

```json
{}
```

means an empty object.

```json
[]
```

means an empty array.

```json
["string", "number", "null"]
```

means a three-element array in that order.

```json
{
  "key1": "number",
  "key2": {
    "key3": "null"
  },
  "items": ["string", "number"]
}
```

means an object with those properties and nested shapes.

The object keys in a type schema are the original, decoded JSON object keys.
They are not filesystem-escaped strings. The type-schema JSON document itself
provides the required JSON escaping.

The strings `"object"`, `"array"`, `"boolean"`, and `"undefined"` are not type
schema tokens. Object and array shape is represented structurally by `{...}`
and `[...]`.

Literal JSON `null`, booleans, and numbers are invalid anywhere in a type
schema.

## 7. Filesystem layout

For this DB entry:

```text
raw key: !r!!values!nodeid123
value:
{
  "key1": 5,
  "key2": {
    "key3": null
  },
  "items": ["hello", 42],
  "emptyObject": {},
  "emptyArray": []
}
```

the paired snapshot is:

```text
snapshot/
  rendered/
    r/
      values/
        nodeid123/
          emptyArray/
          emptyObject/
          items/
            0
            1
          key1
          key2/
            key3
  typesscm/
    r/
      values/
        nodeid123
```

The leaf contents are exactly:

```text
rendered/r/values/nodeid123/key1       = 5
rendered/r/values/nodeid123/key2/key3  = null
rendered/r/values/nodeid123/items/0    = hello
rendered/r/values/nodeid123/items/1    = 42
```

There is no implicit newline in any of these files.

The type-schema file is canonically:

```json
{
  "emptyArray": [],
  "emptyObject": {},
  "items": [
    "string",
    "number"
  ],
  "key1": "number",
  "key2": {
    "key3": "null"
  }
}
```

For metadata:

```text
rendered/_meta/current_replica = r
typesscm/_meta/current_replica = "string"
```

## 8. Rendering rules

### 8.1 General rule

Rendering one value MUST derive its rendered entries and type schema from the
same validated DB value in one codec pass. Implementations MUST NOT independently
infer a schema from one traversal and rendered leaves from another mutable
source.

### 8.2 String

A string renders as:

- a regular file at `rendered/<value-root-or-descendant>` containing the exact
  string code units encoded as the snapshot's UTF-8 text; and
- the schema token `"string"` at the corresponding schema position.

Examples:

```text
value: "hello"
rendered file bytes/text: hello
schema: "string"
```

```text
value: "5"
rendered file bytes/text: 5
schema: "string"
```

```text
value: "null"
rendered file bytes/text: null
schema: "string"
```

```text
value: "  padded  \nnext line"
rendered file text: exactly those characters
schema: "string"
```

Empty strings render as zero-byte regular files. String content is never
trimmed, JSON-quoted, newline-normalized, or parsed.

### 8.3 Number

A number renders as:

- a regular file containing its canonical JSON number text; and
- the schema token `"number"`.

Examples:

```text
5      -> 5
1.5    -> 1.5
0      -> 0
-12    -> -12
-0     -> 0
1e+21  -> 1e+21
```

No whitespace or newline is added.

### 8.4 Null

Null renders as:

- a regular file containing exactly the four characters `null`; and
- the schema token `"null"`.

An empty file is not null. Absence is not null. `null\n` is not canonical and
is invalid during scan.

### 8.5 Object

An object renders as:

- a directory at the corresponding rendered path;
- one child per own JSON property, using the encoded object key as one path
  segment; and
- a schema object whose keys are the original object keys and whose values are
  the child schemas.

The renderer MUST reject non-JSON object semantics rather than traversing a
prototype, symbol properties, accessors with side effects, or class-specific
state.

Object property insertion order does not affect canonical output. Canonical
schema objects sort keys by ascending JavaScript string code-unit order. The
flat virtual entries are also sorted by their canonical relative paths before
being supplied to gentle unification.

### 8.6 Array

An array renders as:

- a directory at the corresponding rendered path;
- one child for each element, named with its canonical unpadded decimal index;
  and
- a schema array with one child schema at each corresponding position.

For an array of length 3, the only child names are:

```text
0
1
2
```

Array order and length come from the schema array. Directory enumeration order
is irrelevant.

Sparse arrays are invalid. Every index from zero through `length - 1` MUST be
present in the source value.

### 8.7 Empty object and empty array

An empty object and empty array both render as an empty directory. Their type
schemas distinguish them:

```text
{} -> rendered empty directory + typesscm {}
[] -> rendered empty directory + typesscm []
```

The empty rendered directory is a meaningful managed entry and MUST exist.
It MUST NOT be optimized away merely because it contains no files.

### 8.8 Scalar roots and compound roots

A scalar DB value makes `rendered/<value-root>` a regular file.
A compound DB value makes `rendered/<value-root>` a directory.
In both cases `typesscm/<value-root>` is a regular file.

Examples:

```text
DB value "hello":
  rendered/r/values/nodeA       regular file: hello
  typesscm/r/values/nodeA       regular file: "string"
```

```text
DB value { "x": 1 }:
  rendered/r/values/nodeA/      directory
  rendered/r/values/nodeA/x     regular file: 1
  typesscm/r/values/nodeA       regular file containing schema object
```

## 9. Path-segment encoding

### 9.1 Object keys use the existing segment codec

Every JSON object key is encoded as exactly one filesystem path segment using
the same bijective segment model used for opaque database keys:

```text
empty string -> %00
.            -> %2E
..           -> %2E%2E
%            -> %25
/            -> %2F
!            -> %21
```

`%` is escaped before the other replacements, so strings that already resemble
escapes remain distinct.

Examples:

| Object key | Canonical segment |
| --- | --- |
| `""` | `%00` |
| `"."` | `%2E` |
| `".."` | `%2E%2E` |
| `"a/b"` | `a%2Fb` |
| `"50%off"` | `50%25off` |
| `"a!b"` | `a%21b` |
| `"%2F"` | `%252F` |
| `"0"` | `0` |
| `"items"` | `items` |
| `"rendered"` | `rendered` |
| `"typesscm"` | `typesscm` |

The names `rendered`, `typesscm`, `_meta`, and `items` have no reserved meaning
inside a rendered object directory.

Newline and other non-separator Unicode characters remain literal path-segment
characters when supported by the host filesystem and existing segment codec.
Portability restrictions beyond the existing snapshot path model are out of
scope. The codec MUST still guarantee that one object key cannot introduce an
additional path segment or traversal component.

### 9.2 Tolerant decoding and canonical encoding

If the existing decoder accepts noncanonical escape casing, such as `%2f`, the
exploded scanner MAY accept it as well. Rendering always emits canonical
uppercase escapes.

Two physical names that decode to the same object key are invalid in one object
directory. For example, canonical and lowercase escape variants MUST NOT be
allowed to produce duplicate decoded keys. The scanner fails rather than
choosing one.

### 9.3 Object keys versus array indices

Interpretation is determined only by the parent schema:

- under a schema object, every child segment is decoded as an object key,
  including `0`, `1`, and `01`;
- under a schema array, every child segment is validated as a canonical array
  index and is never decoded as an object key.

Thus this object:

```json
{
  "0": "zero",
  "01": "leading"
}
```

is valid and renders children named `0` and `01`, while an array directory may
not contain `01`.

## 10. Array indices

A canonical array index segment is either:

```text
0
```

or a nonzero ASCII decimal integer with no leading zero:

```text
1
2
10
123456789
```

The grammar is:

```text
0 | [1-9][0-9]*
```

Invalid examples include:

```text
00
01
-1
+1
1.0
1.5
1e2
x
```

The schema array defines the exact valid index set. For a schema array of length
`N`, the rendered directory MUST contain exactly the child segments `0` through
`N - 1`. An otherwise canonical index at or above `N` is an extra entry and is
invalid.

The scanner MUST address indices numerically from the schema and MUST NOT depend
on lexicographic directory order. In particular, filesystem discovery order
`0`, `1`, `10`, `2` reconstructs the same array as discovery order `10`, `2`,
`1`, `0` when the schema length and all expected children agree.

## 11. Type-schema file format

### 11.1 Canonical JSON

A canonical type-schema file uses:

- valid UTF-8 JSON;
- two-space indentation for compound schemas;
- sorted object keys at every nesting level;
- array order unchanged;
- no trailing newline; and
- the primitive token documents exactly as JSON strings, for example
  `"string"`.

A scanner MAY accept semantically valid schema JSON with different insignificant
JSON whitespace or object member order. A subsequent render canonicalizes it.

### 11.2 Locality and memory

There is one type-schema file per DB value. There is no global
`.render-schema.json` or equivalent whole-snapshot schema document.

An implementation MAY load one value's schema into memory while scanning that
value. It MUST NOT require loading a schema proportional to the whole graph
snapshot merely to reconstruct one value.

### 11.3 Schema validation precedes leaf interpretation

The scanner MUST parse and fully validate a value's type schema before using it
to interpret rendered leaf contents. Invalid schema tokens or shapes fail at
the schema boundary; they are not treated as object keys or strings by
fallback.

## 12. Scanning rules

### 12.1 Pair discovery

Scanning first establishes the set of value roots in both managed trees.
For each value root there MUST be:

- exactly one rendered root entry, file or directory as dictated by schema; and
- exactly one regular type-schema file.

A rendered root without a schema file is invalid. A schema file without a
rendered root is invalid. A directory where the schema file should be is
invalid.

Value-root discovery MUST respect the existing DB key path depth:

- `_meta/<encoded-key>` is a value root for `_meta`; and
- `<replica>/<sublevel>/<encoded-key>` is a value root for replica data.

Descendants below a compound rendered root are JSON structure, not additional
DB keys.

### 12.2 Recursive reconstruction

Given a validated schema node and corresponding rendered path:

- `"string"`: require a regular file and return its exact text;
- `"number"`: require a regular file, parse one complete finite JSON number
  token, and return the number;
- `"null"`: require a regular file containing exactly `null` and return null;
- schema object: require a directory, decode and validate exactly the declared
  child set, recursively scan each child, and return an object;
- schema array: require a directory, validate exactly indices `0..length-1`,
  recursively scan by numeric index, and return an array.

The scanner MUST reject symbolic links or other filesystem entry kinds unless
the repository's filesystem abstraction proves they are equivalent to the
required regular file or directory without escaping the managed root. Treating
symlink policy as a security feature is not required by the non-adversarial
client model, but filesystem shape must remain deterministic and local.

### 12.3 Exact child-set validation

At every compound node, the physical child set MUST exactly match the child set
specified by the schema after canonical path decoding:

- every schema child must exist;
- no undeclared child may exist;
- no two physical names may decode to the same object key;
- arrays may contain no non-index child;
- arrays may contain no padded, negative, fractional, or out-of-range index;
- each child must have the file/directory kind required by its child schema.

Validation is recursive. An extra file deep below a valid parent invalidates the
whole DB value projection.

### 12.4 Parse before DB reconciliation

For one value, the entire projection MUST validate and reconstruct successfully
before that value is written to the DB.

An implementation SHOULD validate and decode all value projections in the
selected source domain before beginning target mutation when feasible without
whole-snapshot value buffering. If it streams values and encounters an invalid
later value after earlier DB mutations, adapter-level partial mutation is
permitted only under the higher-level inactive-replica/cutover assumptions in
Section 17. The invalid value itself MUST never be written partially.

### 12.5 DB replacement semantics

Each value root reconstructs one complete DB value. Reconciliation compares and
replaces complete DB values; it does not patch an object property or array
position directly inside LevelDB.

Consequently:

- changing one leaf reconstructs and replaces the corresponding complete DB
  value if semantically different;
- changing scalar/object/array shape replaces the complete DB value;
- shortening an array replaces the old value with the shorter array; and
- deleting a value-root pair deletes the corresponding DB key.

## 13. Strict mismatch behavior

Scanning fails loudly and does not guess when the two trees disagree.

Invalid examples include:

```text
typesscm says key1 exists, but rendered/key1 is missing
```

```text
rendered has key4, but typesscm does not mention key4
```

```text
typesscm says items is an array of length 2, but rendered/items/2 exists
```

```text
typesscm says a number, but the rendered file contains 5x
```

```text
rendered has a value root without a matching typesscm file
```

```text
typesscm has a value root without a matching rendered file or directory
```

```text
typesscm says object, but rendered path is a file
```

```text
typesscm says string, but rendered path is a directory
```

Errors SHOULD identify:

- the value root;
- the rendered or schema path at fault;
- the expected type or entry kind;
- the observed entry kind or content category; and
- whether the failure arose from malformed schema, missing data, extra data,
  duplicate decoding, invalid scalar content, or file/directory conflict.

The error API SHOULD use specific error kinds and type guards in accordance with
repository conventions. Exact class names are left to the implementation plan.

## 14. Canonicalization and round trips

### 14.1 Value round trip

For every supported value `v`:

```text
scan(render(v)) = v
```

Equality is JSON structural equality, with object member order ignored and
array order preserved. Number equality follows JavaScript/JSON number semantics;
negative zero canonicalizes to zero.

### 14.2 Snapshot canonicalization

For every valid snapshot `s`:

```text
render(scan(s)) = canonicalize(s)
```

Canonicalization includes:

- canonical key/path segment escaping with uppercase escapes;
- canonical unpadded array index names;
- deterministic sorted object traversal;
- canonical type-schema JSON formatting and object-key order;
- exact string bytes/text preserved;
- canonical JSON number text;
- exact `null` text;
- required empty directories retained;
- undeclared or stale managed entries absent; and
- canonical file/directory shape for every schema node.

Manual string edits are preserved exactly if the paired schema says `"string"`.
Manual number edits may be accepted when they are one valid finite JSON number
token, but rendering normalizes their spelling.

### 14.3 Determinism and idempotence

Rendering the same DB state twice produces the same virtual entries and no
semantic target changes on the second reconciliation.

```text
render -> render is idempotent
scan -> render -> scan is stable
```

Source DB iteration order, object insertion order, and target directory listing
order MUST NOT change canonical output.

## 15. Conceptual layering

The implementation SHOULD preserve these layers:

```text
raw DB key
  -> encoded value root

DB value
  -> validated JSON value
  -> value projection
  -> flat virtual snapshot entries
  -> gentle unification
  -> real filesystem
```

and:

```text
real filesystem
  -> flat virtual snapshot entries grouped by value root
  -> validated paired value projection
  -> DB value
  -> raw DB key
  -> gentle unification
  -> target DB sublevel
```

Responsibilities are separated as follows:

1. **Raw key codec**: raw DB key ↔ value-root path. It knows nothing about JSON
   structure.
2. **Exploded value codec**: supported DB value ↔ paired value projection. It
   knows nothing about LevelDB, replica cutover, or physical writes.
3. **Virtual snapshot flattener/grouper**: projection ↔ sorted virtual entries.
   It preserves empty directories as entries and paired-root identity.
4. **Gentle-unification adapter**: lists sorted source/target entries, compares
   them, and applies minimal creates, writes, replacements, and deletions.
5. **Replica/synchronization layer**: supplies failure isolation, durable
   cutover, and snapshot-format negotiation.

JSON recursion, path encoding, physical filesystem mutation, type-schema
parsing, and DB writes SHOULD NOT be combined in one module or traversal.

## 16. Gentle unification and filesystem reconciliation

### 16.1 Flat virtual entries

Although one DB value maps to many physical entries, gentle unification may
continue operating over a sorted flat key space. The source side flattens each
paired value projection into virtual entries under both roots.

The virtual model MUST represent directories explicitly where their existence
is semantically required, especially empty objects and arrays. A files-only
listing is insufficient.

### 16.2 DB-to-filesystem authority

During DB-to-filesystem render, the DB is authoritative for the entire managed
domain. Manual edits, stale files, stale schemas, and partial projections in
that domain are overwritten or deleted to match the DB projection. Existing
invalid target state does not prevent cleanup when the desired DB state is
known.

### 16.3 File/directory replacement

Shape changes are normal reconciliation operations:

- scalar → object/array: delete or replace the scalar file, then create the
  directory and descendants;
- object/array → scalar: delete descendants and the directory, then create the
  scalar file;
- object ↔ array: reconcile the directory's exact child set and update the
  schema, deleting stale children from the old shape;
- schema-path directory → schema file: delete the conflicting directory before
  writing the schema file; and
- schema-path file blocking a required parent directory: replace it with the
  required directory before writing descendants.

The concrete operation ordering may differ, but it MUST deterministically reach
the desired tree when all operations succeed. Sorted-key assumptions alone MUST
NOT be relied upon where a target filesystem requires explicit removal of a
nonempty directory before creating a file at the same path.

### 16.4 Stale entries and empty directories

Every extra entry inside the managed domain is stale and MUST be deleted,
including:

- undeclared rendered leaves;
- stale nested rendered directories;
- rendered roots for deleted DB keys;
- orphan schema files;
- schema directories where files are required; and
- unrelated files placed under the selected managed sublevel.

Directories that become empty because their represented value or ancestor was
deleted MUST be removed when they no longer represent an empty object/array and
are not needed as structural parents. Directories that are the rendered root or
child of an actual empty object/array MUST remain.

Empty structural parent directories above all value roots MAY remain only if the
existing filesystem abstraction cannot remove them without leaving the managed
domain. Canonical tree comparisons SHOULD omit such incidental parents and MUST
require all semantic empty compound directories.

### 16.5 Paths outside the managed domain

A render of replica sublevel `r` may reconcile:

```text
rendered/r/...
typesscm/r/...
```

but MUST NOT modify:

```text
rendered/_meta/...
typesscm/_meta/...
rendered/x/...
typesscm/x/...
```

or arbitrary files outside `rendered/` and `typesscm/`.

A higher-level whole-snapshot render invokes the required sublevel operations
under one snapshot-format workflow. It MUST treat both physical trees as parts
of that one workflow.

### 16.6 Comparison

For filesystem targets, comparison is by canonical virtual entry kind and
content:

- regular-file content must match exactly;
- required directory kind must match;
- type-schema formatting differences are real target differences and are
  canonicalized; and
- string leaf content is compared exactly, including whitespace and newlines.

For DB targets, reconstructed values are compared using the database's semantic
JSON equality. Object insertion order MUST NOT cause a semantic rewrite.

## 17. Failure and replica/cutover assumptions

### 17.1 Adapter-level non-atomicity

Gentle unification is not a transaction across multiple filesystem entries or
multiple DB writes. A failure can leave the target partially reconciled:

- one side of a paired value may have been written before the other;
- some stale entries may have been deleted while others remain; or
- some DB keys may have been updated before a later invalid projection or write
  failure is encountered.

The adapter MUST propagate the failure and MUST NOT report success or switch an
active pointer.

### 17.2 Higher-level safety

Production import, reset, migration, and synchronization flows MUST apply scans
to an inactive replica or otherwise isolated target and cut over only after the
entire operation, required validation, durability step, and snapshot-format
checks succeed.

A failed scan into an inactive replica may leave that inactive replica dirty.
It MUST remain inactive and may be cleared or overwritten by a later attempt.
The active replica remains authoritative.

A rendered worktree may likewise be partially changed if rendering fails. A
higher-level Git/checkpoint operation MUST commit or publish only after the full
paired-tree render succeeds. Failed worktree state is not a valid snapshot.

The exploded codec itself does not promise cross-tree atomicity. Its promise is
that successful output is paired and valid, invalid input is rejected, and
higher-level cutover never treats a failed partial target as active.

## 18. Compatibility behavior

### 18.1 Old one-file JSON entry

Suppose an old snapshot contains:

```text
rendered/r/values/nodeA
```

with content:

```json
{
  "x": 1
}
```

and contains no corresponding:

```text
typesscm/r/values/nodeA
```

An exploded-format scan MUST reject it as an unsupported old-format entry, not
interpret it as a string and not infer its schema from JSON syntax.

### 18.2 Mixed snapshot

A snapshot with exploded pairs for some values and old one-file JSON values for
others is invalid. A scanner MUST reject the snapshot rather than migrate only
the entries it recognizes.

### 18.3 Migration

Migration, if provided, is an explicit whole-snapshot conversion:

```text
old versioned snapshot
  -> old-format scanner
  -> DB values
  -> exploded-format renderer
  -> new versioned snapshot
```

Migration MUST NOT rely on the normal exploded scanner accepting ambiguous old
files. Exact migration command/API design is out of scope.

## 19. Worked examples

### 19.1 Scalar string root

DB entry:

```text
!r!!values!nodeA = "hello"
```

Projection:

```text
rendered/r/values/nodeA   file: hello
typesscm/r/values/nodeA   file: "string"
```

### 19.2 String that resembles JSON

DB entry:

```text
!r!!values!nodeA = "{\"x\":1}"
```

Projection:

```text
rendered/r/values/nodeA   file: {"x":1}
typesscm/r/values/nodeA   file: "string"
```

Scanning returns the string, not an object.

### 19.3 Object with dangerous keys

Value:

```json
{
  "": 0,
  ".": 1,
  "..": 2,
  "a/b": 3,
  "50%off": 4,
  "a!b": 5,
  "%2F": 6,
  "0": 7
}
```

Rendered children:

```text
%00
%2E
%2E%2E
a%2Fb
50%25off
a%21b
%252F
0
```

The schema keeps original keys:

```json
{
  "": "number",
  "%2F": "number",
  ".": "number",
  "..": "number",
  "0": "number",
  "50%off": "number",
  "a!b": "number",
  "a/b": "number"
}
```

### 19.4 Array order beyond nine elements

Schema:

```json
[
  "string",
  "string",
  "string",
  "string",
  "string",
  "string",
  "string",
  "string",
  "string",
  "string",
  "string"
]
```

Rendered children are named `0` through `10`. A directory listing may return
`0, 1, 10, 2, ...`; scanning still reads element 10 as index 10 and element 2
as index 2.

### 19.5 Same text, different type

These pairs have identical rendered text but different schema and therefore
different DB values:

```text
rendered: 5      schema: "string"  -> "5"
rendered: 5      schema: "number"  -> 5
```

```text
rendered: null   schema: "string"  -> "null"
rendered: null   schema: "null"    -> null
```

### 19.6 Empty compound type change

Changing `{}` to `[]` leaves the rendered root as the same empty directory but
changes the schema file from `{}` to `[]`. The schema change is required and is
a semantic snapshot change.

## 20. Conformance test scenarios

The scenarios below are normative behavioral cases. Test helpers may exercise a
pure codec, virtual-entry layer, adapters, or end-to-end render/scan, but the
observable setup and outcome must remain equivalent.

### 20.1 Codec and rendering: positive cases

For each case, render the value, assert the exact rendered file/directory shape,
exact leaf content, exact schema structure, canonical schema formatting, and
successful scan back to the original value.

1. **String scalar**: `"hello"` creates one rendered file containing `hello`
   and schema `"string"`.
2. **Empty string scalar**: `""` creates a zero-byte rendered file and schema
   `"string"`.
3. **Spaces**: `"hello world"` preserves the internal space.
4. **Leading/trailing whitespace**: `"  hello  "` preserves every space.
5. **Newlines**: `"first\nsecond\n"` preserves both newline characters,
   including the final newline as string data.
6. **Number-looking string**: `"5"` renders `5` with schema `"string"`.
7. **Null-looking string**: `"null"` renders `null` with schema `"string"`.
8. **JSON-looking string**: `"{\"x\":1}"` renders `{"x":1}` with schema
   `"string"`.
9. **Number scalar**: `5` renders `5` with schema `"number"`.
10. **Decimal number**: `1.5` renders `1.5`.
11. **Zero**: `0` renders `0`.
12. **Negative number**: `-12` renders `-12`.
13. **Exponent notation**: use a finite number whose canonical JSON spelling
    uses an exponent, assert that spelling, and scan to the same number.
14. **Noncanonical valid number input**: scan `1.0` with schema `"number"`,
    then render and assert canonical `1`.
15. **Negative zero**: render `-0` and assert canonical `0` and scan result
    numerically equal to zero.
16. **Null scalar**: null renders exactly `null` with schema `"null"`.
17. **Flat object**: `{ "a": 1, "b": "two" }` creates two leaves and an
    object schema.
18. **Nested object**: `{ "a": { "b": 1 } }` creates nested directories.
19. **Deep object**: at least ten nested object levels preserve all keys and
    the leaf.
20. **Empty object**: `{}` creates an empty rendered directory and schema `{}`.
21. **Empty array**: `[]` creates an empty rendered directory and schema `[]`.
22. **Array of scalars**: `["a", 2, null]` creates children `0`, `1`, `2`.
23. **Array of objects**: `[{ "x": 1 }, { "x": 2 }]` creates object
    directories at indices `0` and `1`.
24. **Array containing empty object**: `[{}]` retains empty directory `0` and
    schema `[{}]`.
25. **Array containing empty array**: `[[]]` retains empty directory `0` and
    schema `[[]]`.
26. **Nested arrays**: `[[1], [2, 3]]` reconstructs numeric order.
27. **Mixed structure**: an object containing arrays of objects and objects
    containing arrays reconstructs exactly.
28. **Object key `"0"`**: under an object, child `0` is a property, not an
    array index.
29. **Object key `"1"`**: same rule for child `1`.
30. **Slash key**: `"a/b"` renders as `a%2Fb` in one segment.
31. **Percent key**: `"50%off"` renders as `50%25off`.
32. **Bang key**: `"a!b"` renders as `a%21b`.
33. **Dot key**: `"."` renders as `%2E`.
34. **Dot-dot key**: `".."` renders as `%2E%2E`.
35. **Empty key**: `""` renders as `%00`.
36. **Newline key**: if supported by the existing filesystem/path abstraction,
    a key containing newline round-trips as one segment.
37. **Distinct escapes**: keys `/`, `%2F`, `%2f`, and `%252F` produce distinct
    canonical segments and round-trip distinctly.
38. **Escape-looking key**: a key `%2E` remains distinct from key `.`.
39. **Key named `items`**: has no reserved behavior.
40. **Key named `typesscm`**: has no reserved behavior inside the value tree.
41. **Key named `rendered`**: has no reserved behavior inside the value tree.
42. **Object insertion order**: objects built with opposite insertion orders
    produce byte-identical canonical projections.
43. **Large array index**: an array long enough to include index `10` uses
    unpadded `10` and scans correctly despite lexical listing order.
44. **Metadata string**: `_meta/current_replica` uses the same string projection
    and paired schema.

### 20.2 Rendering: unsupported source values

Each case must fail before publishing a valid value projection:

1. `undefined` at the root.
2. `undefined` as an object property.
3. `undefined` as an array element.
4. `true` and `false`.
5. `NaN`.
6. positive or negative infinity.
7. bigint.
8. function.
9. symbol.
10. sparse array.
11. cyclic object or array.
12. non-JSON class instance or other unsupported object semantics.

### 20.3 Codec and scanning: negative cases

Each case must fail with the value root and offending path in the error where
applicable. No guessed value is returned.

1. Schema expects a scalar leaf but the rendered file is missing.
2. Schema object declares a child whose rendered entry is missing.
3. Rendered object directory contains an undeclared extra file.
4. Rendered object directory contains an undeclared extra directory.
5. Rendered value root exists but its type-schema file is missing.
6. Type-schema file exists but the rendered root is missing.
7. A type-schema file exists outside the set of selected rendered roots.
8. A rendered root exists outside the set of selected schema roots.
9. Type schema contains token `"wat"`.
10. Type schema contains literal JSON `null` instead of `"null"`.
11. Type schema contains boolean `true` or `false`.
12. Type schema contains number `1`.
13. Type schema contains unsupported token `"boolean"`.
14. Type schema contains unsupported token `"undefined"`.
15. Type schema contains token `"object"` instead of an object shape.
16. Type schema contains token `"array"` instead of an array shape.
17. Number file contains `abc`.
18. Number file contains `5x`.
19. Number file contains `5 6`.
20. Number file contains leading whitespace: ` 5`.
21. Number file contains trailing whitespace: `5 `.
22. Number file contains trailing newline: `5\n`.
23. Number file contains `NaN`.
24. Number file contains `Infinity`.
25. Number file contains JSON string syntax: `"5"`.
26. Null file contains an empty string.
27. Null file contains `NULL`.
28. Null file contains `null\n`.
29. Null file contains surrounding whitespace.
30. Array child uses padded index `01`.
31. Array child uses negative index `-1`.
32. Array child uses signed index `+1`.
33. Array child uses decimal index `1.5`.
34. Array child uses exponent index `1e1`.
35. Array child uses non-number text `x`.
36. Array schema length is 2 but rendered child `2` exists.
37. Array schema length is 3 but rendered child `2` is missing.
38. Rendered directory uses numeric children but schema says object with a
    different declared child set.
39. Rendered directory exists but schema says scalar.
40. Rendered scalar file exists but schema says object.
41. Rendered scalar file exists but schema says array.
42. Rendered compound path is a file.
43. Rendered scalar path is a directory.
44. A parent path is simultaneously required as a file and directory.
45. Canonical and lowercase escape variants decode to the same object key.
46. Two physical object child names otherwise decode to one key.
47. Malformed JSON in the type-schema file.
48. Type-schema path is a directory.
49. Type-schema path is a symlink or unsupported entry kind.
50. Rendered expected file is a symlink or unsupported entry kind.
51. Rendered expected directory is a symlink or unsupported entry kind.
52. Type schema is valid JSON but has trailing non-whitespace data.
53. Old one-file JSON object exists without a schema.
54. One value is exploded while another value remains old-format JSON.

### 20.4 Pure round-trip cases

For every value below, assert exact structural equality:

```text
scan(render(value)) = value
```

1. scalar string;
2. empty string;
3. whitespace-rich and multiline string;
4. string `"5"`;
5. string `"null"`;
6. string `"{\"x\":1}"`;
7. scalar number;
8. decimal and negative number;
9. exponent-serialized number;
10. scalar null;
11. nested object;
12. deeply nested object;
13. nested array;
14. mixed object/array value;
15. empty object;
16. empty array;
17. object with all escaped-key cases;
18. array of objects whose keys require escaping;
19. object with numeric-looking keys;
20. structure containing empty compounds at several depths.

### 20.5 Canonicalization cases

For every case, scan the valid noncanonical snapshot and render the result;
assert the canonical projection.

1. Type-schema JSON uses unusual spaces and newlines; output uses canonical
   two-space formatting and no trailing newline.
2. Type-schema object members are in reverse order; output sorts them.
3. Nested schema object members are unsorted; output sorts every level.
4. Physical files are discovered in arbitrary order; output virtual entries
   are deterministically sorted.
5. Array children are discovered in order `0`, `1`, `10`, `2`; reconstruction
   follows numeric indices from schema.
6. Array children are discovered in reverse order; result is unchanged.
7. A string leaf contains leading/trailing whitespace; output preserves it
   exactly.
8. A string leaf contains a trailing newline; output preserves it exactly.
9. A valid number file contains `1.0`; output contains `1`.
10. A valid number file contains `1e0`; output contains `1`.
11. A tolerantly accepted lowercase escape is re-rendered uppercase.
12. Object insertion order in the reconstructed value does not affect output.
13. Empty object and array directories remain present after canonicalization.

### 20.6 DB-to-filesystem render reconciliation

Use an authoritative source DB and a pre-existing target snapshot. After render,
assert the exact managed contents of both trees and that unrelated out-of-domain
paths remain untouched.

1. Empty target; one DB value: create rendered root/subtree and matching schema.
2. Same target and DB value: perform no semantic changes and rewrite no
   byte-identical files.
3. One scalar leaf changes: update that rendered leaf; leave identical schema
   content unchanged.
4. Primitive type changes with different text: update leaf and schema.
5. Primitive type changes with same text (`"5"` → `5`): keep rendered text but
   update schema from `"string"` to `"number"`.
6. Reverse same-text change (`5` → `"5"`): update schema only.
7. `"null"` → null: update schema only because rendered text remains `null`.
8. null → `"null"`: update schema only.
9. DB value is unchanged but target schema formatting is noncanonical: rewrite
   schema canonically.
10. DB value deleted: delete rendered root/subtree and matching schema file.
11. New DB value: create both sides.
12. Target has nodeA and nodeB; DB only nodeA: delete both sides for nodeB.
13. Target has nodeA and nodeB; DB adds nodeC: create both sides for nodeC.
14. Deleted node has stale rendered subtree but no schema: remove rendered
    subtree without requiring target validity.
15. Deleted node has stale schema but no rendered root: remove schema.
16. Old rendered shape is object; DB is scalar: replace directory with file and
    update schema.
17. Old rendered shape is array; DB is scalar: replace directory with file and
    update schema.
18. Old rendered shape is scalar; DB is object: replace file with directory and
    update schema.
19. Old rendered shape is scalar; DB is array: replace file with directory and
    update schema.
20. Old array; new object: remove stale numeric children, create encoded object
    children, update schema.
21. Old object; new array: remove stale object-key children, create numeric
    children, update schema.
22. Array length 3 → 2: delete rendered index `2`, update schema.
23. Array length 2 → 3: create index `2`, update schema.
24. Nested path `a/b/c` is removed from DB value: delete stale leaf and any
    nonsemantic empty ancestors.
25. A nested object becomes empty: delete former children but retain its empty
    rendered directory and schema `{}`.
26. Empty object → empty array: retain empty rendered directory, change schema
    `{}` to `[]`.
27. Empty array → empty object: retain empty rendered directory, change schema
    `[]` to `{}`.
28. File/directory conflict from old shape: resolve deterministically to desired
    shape.
29. Manual edit only on rendered side: DB render overwrites it.
30. Manual edit only on schema side: DB render overwrites it.
31. Extra unrelated file below managed rendered sublevel: delete it.
32. Extra unrelated directory below managed rendered sublevel: delete it.
33. Extra unrelated file below managed schema sublevel: delete it.
34. Schema directory exists where desired schema file belongs: replace it.
35. Schema file blocks a required parent directory: replace it with directory
    and write desired descendants.
36. Unrelated file outside both managed roots: do not touch it.
37. File in another top-level sublevel: do not touch it.
38. Render fails after writing some entries: propagate failure, do not publish
    or commit the worktree, and do not claim a valid paired snapshot.
39. Re-run after a partial failure: authoritative DB reconciliation removes or
    replaces partial state and reaches the exact desired snapshot.

### 20.7 Filesystem-to-DB scan reconciliation

Use a paired source snapshot and a pre-existing target DB sublevel.

1. Empty DB target; one snapshot value: create the DB key/value.
2. Same DB and snapshot value: no semantic DB change.
3. One scalar leaf changes: reconstruct and replace only that complete DB value,
   leaving other DB keys unchanged.
4. DB has nodeA; snapshot omits nodeA: delete nodeA.
5. DB lacks nodeA; snapshot contains nodeA: create nodeA.
6. DB has nodeA and nodeB; snapshot only nodeA: delete nodeB.
7. DB has nodeA; snapshot adds nodeB: create nodeB.
8. DB scalar; snapshot object at same root: replace complete value with object.
9. DB object; snapshot scalar: replace complete value with scalar.
10. DB array; snapshot object: replace complete value with object.
11. DB object; snapshot array: replace complete value with array.
12. DB array length 3; snapshot length 2: replace with shorter array, leaving no
    stale third element in the DB value.
13. DB array length 2; snapshot length 3: replace with longer array.
14. Rendered root without schema: fail before writing that value.
15. Schema without rendered root: fail before writing that value.
16. Any recursive rendered/schema mismatch: fail loudly.
17. One valid value and one invalid value: never write the invalid value;
    earlier streamed mutations may exist only in the inactive target replica,
    which must not be cut over.
18. Failure halfway through target writes: propagate failure, do not switch
    replica pointer, and leave active replica unchanged.
19. Scan only replica `y`: do not delete or update keys in replica `x` or
    `_meta`.
20. Scan `_meta`: apply the same scalar/compound codec to selected metadata
    entries and do not touch replica sublevels.
21. Deleting all source values in selected sublevel: delete all target DB keys
    in that sublevel, but no others.
22. Object member order differs but value is semantically equal: no DB rewrite.
23. Type changes with identical rendered text reconstruct the type selected by
    schema and update DB when semantically different.
24. Empty object versus empty array reconstructs the schema-selected type.

### 20.8 Paired-tree consistency

1. Every rendered value root has exactly one schema file.
2. Every schema file corresponds to exactly one rendered value root.
3. Adding a DB value adds both sides.
4. Deleting a DB value deletes both sides.
5. Changing a DB value reconciles both sides from one projection.
6. Changing primitive content while retaining primitive type may leave schema
   byte-identical.
7. Changing `"5"` to `5` updates schema despite identical rendered text.
8. Changing `5` to `"5"` updates schema despite identical rendered text.
9. Changing `"null"` to null updates schema despite identical rendered text.
10. Changing null to `"null"` updates schema despite identical rendered text.
11. Changing `{}` to `[]` updates schema despite identical empty rendered tree.
12. Changing `[]` to `{}` updates schema despite identical empty rendered tree.
13. A render operation derives both sides from the same source value and cannot
    pair leaves from one source read with schema from another.
14. Scanner rejects duplicate schema files or ambiguous roots created through
    noncanonical path decoding.

### 20.9 Path-shape conflicts

1. Old rendered scalar file conflicts with new object directory.
2. Old rendered scalar file conflicts with new array directory.
3. Old rendered object directory conflicts with new scalar file.
4. Old rendered array directory conflicts with new scalar file.
5. Old object child file conflicts with new nested object directory.
6. Old nested object directory conflicts with new child scalar file.
7. Old schema directory exists where schema file is required.
8. Old schema file exists where a parent directory is required.
9. Stale nested rendered files remain after a parent becomes scalar; all are
   removed.
10. Stale nested directories remain after a parent becomes scalar; all are
    removed.
11. Object-key path escapes collide after tolerant decoding; scan rejects them.
12. Object key `0` under object and index `0` under array use the same physical
    name but are interpreted only according to parent schema.
13. Empty-string key `%00` and literal key `%00` remain distinct (`%00` versus
    `%2500`).
14. Dot key and literal `%2E` key remain distinct.

### 20.10 Ordering, determinism, and idempotence

1. Object insertion order does not affect rendered paths or schema bytes.
2. Nested object insertion order does not affect output.
3. Arrays preserve semantic order regardless of directory listing order.
4. Schema formatting is byte-deterministic.
5. Number and null file contents are byte-deterministic.
6. String contents are deterministic and exact.
7. Source DB key listing order does not affect final output.
8. Target filesystem listing order does not affect reconciliation result.
9. Repeated render of the same DB state produces zero semantic changes.
10. `render -> render` is idempotent.
11. `scan -> render -> scan` is stable.
12. A value with at least 11 array elements scans correctly when lexical order
    places `10` before `2`.
13. Canonical virtual entry ordering includes both trees deterministically.
14. Deletion planning is deterministic for stale file/directory trees.

### 20.11 Existing-format interaction

1. Version discriminator says old format: exploded scanner rejects it and names
   the required migration path.
2. Version discriminator says exploded format but a value is an old JSON object
   file without schema: reject as malformed exploded snapshot.
3. Old snapshot has no `typesscm/` tree: reject; do not infer schemas.
4. Mixed old and exploded values: reject the whole selected source domain.
5. Old scalar JSON string file contains `"hello"`: do not reinterpret it as the
   new plain string `"\"hello\""`.
6. Old number file happens to look identical to a new number leaf but has no
   schema: reject; do not infer number.
7. Explicit migration reads old format with the old codec and writes both new
   trees with the exploded codec.
8. Migration output passes all paired-tree and round-trip checks.
9. Render in new format removes obsolete old-format managed files rather than
   retaining a mixed snapshot, when invoked in an isolated migration target.
10. Unsupported format error identifies the encountered version or missing
    version and does not partially scan into the active replica.

### 20.12 Stale-file deletion regression coverage

The existing renderer guarantees deletion of target files that no longer
correspond to source DB keys. Preserve and extend that guarantee:

1. Deleted DB key removes its entire rendered subtree.
2. Deleted DB key removes its schema file.
3. Removed nested object property deletes its leaf/subtree.
4. Shortened array deletes all removed indices.
5. Shape transition deletes every descendant made stale by the old shape.
6. Extra manually created managed file is deleted.
7. Orphan rendered side is deleted during authoritative render.
8. Orphan schema side is deleted during authoritative render.
9. Deleting stale entries leaves no nonsemantic empty directories beneath a
   surviving value projection.
10. Semantic empty object/array directories are never mistaken for stale empty
    directories.

## 21. Out of scope

The following are deliberately not specified here:

- implementation function or class names;
- the exact snapshot container version field and numeric/string version;
- an automatic old-to-new migration command;
- support for booleans, `undefined`, binary values, dates, bigint, or custom
  classes;
- filesystem portability rules beyond the existing path-segment codec;
- authorization, rate limiting, resource caps, or adversarial-client defenses;
- merge semantics for two concurrently edited exploded snapshots;
- making adapter-level filesystem writes or multi-key DB reconciliation atomic;
- optimizing partial DB updates below one complete DB value; and
- changing identifier-native raw DB key design.

Any future extension of the value domain requires a new unambiguous schema token
or structural rule and a snapshot-format compatibility decision. It MUST NOT be
introduced by guessing from leaf text.

## 22. Summary of invariants

A conforming exploded snapshot satisfies all of these invariants:

1. Every selected DB key maps through the existing opaque-key codec to one value
   root.
2. Every value root has one rendered root and one regular local schema file.
3. The rendered root is a file exactly for primitive schemas and a directory
   exactly for compound schemas.
4. Every compound rendered child set exactly matches its schema child set.
5. Object keys use bijective single-segment encoding; arrays use canonical
   unpadded decimal indices.
6. Strings are exact plain text, numbers are complete finite JSON number tokens,
   and null is exactly `null`.
7. Empty objects and arrays have real empty rendered directories and distinct
   schemas.
8. No unsupported value or schema kind is guessed or coerced.
9. The two physical trees form one logical snapshot and are derived from the
   same value projections.
10. Successful render/scan satisfies the value round trip and canonical snapshot
    round trip.
11. Gentle unification deletes stale managed entries and resolves shape
    conflicts deterministically.
12. Adapter-level failures are non-atomic; inactive-replica and publish/cutover
    machinery prevents failed partial targets from becoming authoritative.
13. Old and mixed snapshot formats are rejected unless processed by an explicit
    migration path.
