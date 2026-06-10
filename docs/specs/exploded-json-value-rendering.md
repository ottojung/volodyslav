---
title: Exploded JSON Value Rendering
---

# Exploded JSON Value Rendering

## 1. Status and normative language

This document specifies the rendered-database snapshot format for exploded JSON
values. It defines the filesystem representation, its inverse scan operation,
canonicalization, validation, reconciliation, and failure boundaries.

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

Exploded value rendering maps:

- compound shape to a local type-schema document;
- primitive descendants of objects and arrays to filesystem paths; and
- strings, numbers, booleans, and null to plain files.

Physical directories under `rendered/` are only parents for primitive leaf
files. Empty or otherwise primitive-free compounds are represented by schema
only.

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

### 3.4 Format definition and database version value

This specification does not introduce a snapshot-format discriminator. The
rendered database format is defined by the code and this specification. Format
evolution is outside the scope of this document; the existing
`rendered/r/global/version` database value remains the only version-like
database marker.

The `version` entry is projected by the same value codec as every other selected
DB value.

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

### 4.2 Supported rendered value domain

The exploded-renderable value domain is recursive:

```text
RenderedValue =
  | string
  | number
  | boolean
  | null
  | { [objectKey: string]: RenderedValue }
  | RenderedValue[]
```

The following are not values in this domain:

- `undefined`;
- functions;
- symbols;
- bigint values;
- `NaN`, `Infinity`, and `-Infinity`;
- sparse arrays;
- custom class instances or other objects with non-plain-data semantics;
- cyclic structures;
- binary values; and
- dates.

A renderer MUST reject an unsupported DB value before producing its projection.
A scanner MUST reject a type schema or leaf that attempts to introduce an
unsupported value. It MUST NOT silently omit `undefined` properties, coerce
unsupported values, or infer another type from their text.

Before enabling this format for production snapshots, all persisted
`DatabaseStoredValue` variants MUST be audited or normalized into this supported
rendered value domain. Stored values MUST NOT contain `undefined` properties or
other unsupported values.

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

### 5.2 Rendered leaf path

A **rendered leaf path** is the path of one primitive value in `rendered/`.
A scalar occupies the value-root path itself as a file. A primitive descendant
of a compound occupies a descendant path. Compound nodes do not themselves
require physical entries.

### 5.3 Type-schema path

The **type-schema path** for a value is exactly the relative value-root path in
`typesscm/`. It is always one regular file, including when the value has no
rendered primitive leaves.

### 5.4 Value projection

A **value projection** is the pair:

```text
{
  zero or more primitive leaf files below rendered/<value-root>,
  one type-schema file typesscm/<value-root>
}
```

The projection is the unit of codec validation and DB-value reconstruction.
The flat virtual snapshot used for reconciliation is a flattening of these
files, not a weakening of their paired semantics.

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
  | "boolean"
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
"boolean"
```

means a boolean scalar.

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
["string", "number", "boolean", "null"]
```

means a four-element array in that order.

```json
{
  "enabled": "boolean",
  "key1": "number",
  "key2": {
    "key3": "null"
  },
  "items": ["string", "number", "boolean"]
}
```

means an object with those properties and nested shapes.

The object keys in a type schema are the original, decoded object keys. They are
not filesystem-escaped strings. The type-schema JSON document itself provides
the required JSON escaping.

The strings `"object"`, `"array"`, and `"undefined"` are not type-schema
tokens. Object and array shape is represented structurally by `{...}` and
`[...]`.

Literal JSON `null`, booleans, and numbers are invalid anywhere a `TypeSchema`
is expected. In particular, the schema for a boolean is the JSON string
`"boolean"`, not the literal JSON value `true` or `false`.

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
  "enabled": true,
  "items": ["hello", 42, false],
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
          enabled
          items/
            0
            1
            2
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
rendered/r/values/nodeid123/enabled     = true
rendered/r/values/nodeid123/items/0     = hello
rendered/r/values/nodeid123/items/1     = 42
rendered/r/values/nodeid123/items/2     = false
rendered/r/values/nodeid123/key1        = 5
rendered/r/values/nodeid123/key2/key3   = null
```

There is no implicit newline in any of these files. There are no rendered paths
for `emptyObject` or `emptyArray`.

The type-schema file is canonically:

```json
{
  "emptyArray": [],
  "emptyObject": {},
  "enabled": "boolean",
  "items": [
    "string",
    "number",
    "boolean"
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

The existing database version entry is rendered in the same way:

```text
rendered/r/global/version = <plain string value>
typesscm/r/global/version = "string"
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
  string through the repository's existing UTF-8 text file abstraction; and
- the schema token `"string"` at the corresponding schema position.

Examples:

```text
value: "hello"
rendered file text: hello
schema: "string"
```

```text
value: "true"
rendered file text: true
schema: "string"
```

```text
value: "5"
rendered file text: 5
schema: "string"
```

```text
value: a string containing two leading spaces, two trailing spaces, a newline,
       and the text "next line"
rendered file text: exactly those characters
schema: "string"
```

Empty strings render as zero-byte regular files. String content is never
trimmed, JSON-quoted, newline-normalized, or parsed. Portability and
invalid-Unicode edge cases beyond the existing UTF-8 text abstraction are out
of scope.

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

### 8.4 Boolean

A boolean renders as:

- a regular file containing exactly `true` or exactly `false`; and
- the schema token `"boolean"`.

Examples:

```text
true  -> rendered file: true  + schema: "boolean"
false -> rendered file: false + schema: "boolean"
```

No whitespace or newline is added.

### 8.5 Null

Null renders as:

- a regular file containing exactly the four characters `null`; and
- the schema token `"null"`.

An empty file is not null. Absence is not null. `null
` is invalid during scan.

### 8.6 Object

An object contributes:

- one rendered primitive leaf file for each primitive descendant;
- parent directories required to reach those primitive leaves; and
- a schema object whose keys are the original object keys and whose values are
  the child schemas.

Compound structure belongs to the schema. A property whose entire subtree has
no primitive leaves contributes no rendered path.

The renderer MUST reject non-plain-data object semantics rather than traversing
a prototype, symbol properties, accessors with side effects, or class-specific
state.

Object property insertion order does not affect canonical output. Canonical
schema objects sort keys by ascending JavaScript string code-unit order. The
flat virtual leaf entries are also sorted by canonical relative path before
being supplied to gentle unification.

### 8.7 Array

An array contributes:

- one rendered primitive leaf file for each primitive descendant, below the
  canonical unpadded decimal index for its element;
- parent directories required to reach those primitive leaves; and
- a schema array with one child schema at each position.

For `["a", 2, false]`, the rendered children are `0`, `1`, and `2`. For
`[{}, []]`, neither `0` nor `1` has a rendered path because neither element has
a primitive descendant.

Array order and length come from the schema array. Directory enumeration order
is irrelevant. Sparse arrays are invalid. Every source index from zero through
`length - 1` MUST be present.

### 8.8 Empty and primitive-free compounds

Empty objects and arrays are schema-only:

```text
{} -> typesscm {} + no rendered path
[] -> typesscm [] + no rendered path
```

This rule applies recursively. Any compound subtree with no primitive leaves
may have no physical rendered subtree at all.

Examples:

```json
{
  "emptyObject": {},
  "emptyArray": [],
  "nonempty": {
    "x": 1
  }
}
```

renders only:

```text
rendered/<value-root>/nonempty/x = 1
```

The paths `rendered/<value-root>/emptyObject` and
`rendered/<value-root>/emptyArray` MUST be absent.

A root `{}` or root `[]` has a type-schema file and no corresponding rendered
value-root path. Physical directories under `rendered/` are only parents for
primitive leaf files; they are not semantic entries.

### 8.9 Scalar roots and compound roots

A scalar DB value makes `rendered/<value-root>` a regular file. A compound DB
value contributes rendered files only when it contains primitive descendants.
In every case, `typesscm/<value-root>` is one regular file.

Examples:

```text
DB value true:
  rendered/r/values/nodeA       regular file: true
  typesscm/r/values/nodeA       regular file: "boolean"
```

```text
DB value { "x": 1 }:
  rendered/r/values/nodeA/x     regular file: 1
  typesscm/r/values/nodeA       regular file containing schema object
```

```text
DB value {}:
  rendered/r/values/nodeA       absent
  typesscm/r/values/nodeA       regular file: {}
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

The schema array defines the exact valid index set. A primitive leaf below an
array element MUST begin with that element's canonical index. Indices at or
above the schema length are extra and invalid. An element with no primitive
descendants contributes no rendered index path.

The scanner MUST address indices numerically from the schema and MUST NOT depend
on lexicographic directory order. In particular, filesystem discovery order
`0`, `1`, `10`, `2` reconstructs the same primitive leaves as discovery order
`10`, `2`, `1`, `0` when all schema-required files agree.

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

### 12.1 Schema-led value-root discovery

`typesscm` is the source of DB value roots. Scanning the selected domain MUST:

1. enumerate type-schema files for that domain;
2. map each schema path to one raw DB key using the existing key codec;
3. parse and fully validate each schema;
4. read exactly the rendered primitive leaf files required by that schema;
5. reject every rendered file not claimed by exactly one schema leaf; and
6. reconstruct one complete DB value per schema file.

A schema file always defines a DB value. Its rendered root may be absent when
the schema contains no primitive leaves. A rendered file without a schema value
root and primitive schema leaf claiming it is invalid. A directory where a
schema file should be is invalid.

Value-root discovery MUST respect the existing DB key path depth:

- `_meta/<encoded-key>` is a value root for `_meta`; and
- `<replica>/<sublevel>/<encoded-key>` is a value root for replica data.

Directories below `rendered/` are traversal structure only. They do not define
DB keys or values.

### 12.2 Recursive reconstruction

Given a validated schema node and its corresponding logical rendered path:

- `"string"`: require a regular file and return its exact text;
- `"number"`: require a regular file, parse one complete finite JSON number
  token, and return the number;
- `"boolean"`: require a regular file containing exactly `true` or exactly
  `false`, and return the corresponding boolean;
- `"null"`: require a regular file containing exactly `null` and return null;
- empty schema object or array: require no rendered path and return the empty
  compound;
- non-empty schema object: recursively scan every child schema and return an
  object; and
- non-empty schema array: recursively scan each child schema by numeric index
  and return an array.

A compound node needs no physical directory when none of its descendants is a
primitive leaf. When primitive descendants exist, their parent directories must
permit those exact files to be read. Directory enumeration order does not carry
shape or ordering information.

The scanner MUST reject symbolic links or other filesystem entry kinds unless
the repository's filesystem abstraction proves they are equivalent to the
required regular file or traversal directory without escaping the managed root.

### 12.3 Exact rendered-file validation

For each schema, the scanner derives the exact set of required primitive leaf
paths. The managed rendered file set MUST equal the union of those required
sets:

- every primitive schema leaf must have one regular rendered file;
- no extra rendered file may exist;
- no rendered file may be claimed by more than one decoded path;
- arrays may contain no padded, negative, fractional, or out-of-range index
  path;
- object path segments must decode bijectively; and
- a path needed as a traversal directory must not be a regular file.

Any rendered entry at or below an empty or otherwise primitive-free schema
subtree is extra and invalid, including an empty directory at that logical path.
Physical directories are not evidence of values. Canonical output never
requires an empty-compound directory.

### 12.4 Scalar parsing

A number file MUST contain exactly one finite JSON number token. Leading or
trailing whitespace and trailing data are invalid. A valid but noncanonical
number token, such as `1.0` or `1e0`, MAY be accepted and is canonicalized on
render.

A boolean file MUST contain exactly `true` or exactly `false`. `TRUE`, `False`,
`1`, `0`, `true
`, and whitespace-padded variants are invalid.

A null file MUST contain exactly `null`. A string file is not parsed and may
contain any text accepted by the repository's UTF-8 text abstraction.

### 12.5 Parse before DB reconciliation

For one value, the schema and all required rendered leaves MUST validate and
reconstruct successfully before that value is written to the DB.

An implementation SHOULD validate and decode all value projections in the
selected source domain before beginning target mutation when feasible without
whole-snapshot value buffering. If it streams values and encounters an invalid
later value after earlier DB mutations, adapter-level partial mutation is
permitted only under the higher-level inactive-replica/cutover assumptions in
Section 17. The invalid value itself MUST never be written partially.

### 12.6 DB replacement semantics

Each schema file reconstructs one complete DB value. Reconciliation compares
and replaces complete DB values; it does not patch an object property or array
position directly inside LevelDB.

Consequently:

- changing one primitive leaf reconstructs and replaces the corresponding
  complete DB value if semantically different;
- changing scalar/object/array shape replaces the complete DB value;
- shortening an array replaces the old value with the shorter array; and
- deleting a schema file deletes the corresponding DB key.

## 13. Strict mismatch behavior

Scanning fails loudly and does not guess when the two trees disagree.

Invalid examples include:

```text
typesscm says key1 is a number, but rendered/key1 is missing
```

```text
rendered has key4, but no typesscm leaf claims key4
```

```text
typesscm says items is an array of length 2, but rendered/items/2 exists
```

```text
typesscm says a number, but the rendered file contains 5x
```

```text
typesscm says a boolean, but the rendered file contains TRUE
```

```text
rendered has files below a value root with no typesscm file
```

```text
typesscm says empty object, but a rendered file exists below that path
```

A type-schema root with no rendered root is valid when its schema has no
primitive leaves. It is invalid when any primitive schema leaf lacks its
required rendered file.

Errors SHOULD identify:

- the value root;
- the rendered or schema path at fault;
- the expected primitive type or entry kind;
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
- exact string text preserved;
- canonical JSON number text;
- exact boolean text;
- exact `null` text;
- primitive leaf files present exactly where required by schemas;
- no rendered path required for empty or primitive-free compounds;
- undeclared or stale managed files absent; and
- canonical file/directory shape along paths to primitive leaves.

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
  -> validated rendered value
  -> value projection
  -> flat virtual snapshot files
  -> gentle unification
  -> real filesystem
```

and:

```text
real filesystem
  -> schema-led grouping of flat rendered files
  -> validated paired value projection
  -> DB value
  -> raw DB key
  -> gentle unification
  -> target DB sublevel
```

Responsibilities are separated as follows:

1. **Raw key codec**: raw DB key ↔ value-root path. It knows nothing about value
   structure.
2. **Exploded value codec**: supported DB value ↔ local schema plus primitive
   leaf files. It knows nothing about LevelDB, replica cutover, or physical
   writes.
3. **Virtual snapshot flattener/grouper**: projection ↔ sorted schema files and
   rendered primitive leaf files. Physical directories are incidental parents.
4. **Gentle-unification adapter**: lists sorted source/target files, compares
   them, and applies minimal creates, writes, replacements, and deletions.
5. **Replica/synchronization layer**: supplies failure isolation, durability,
   and cutover.

Value recursion, path encoding, physical filesystem mutation, type-schema
parsing, and DB writes SHOULD NOT be combined in one module or traversal.

## 16. Gentle unification and filesystem reconciliation

### 16.1 Flat virtual files

One DB value may map to many files. Gentle unification may continue operating
over a sorted flat key space containing:

- one `typesscm/<value-root>` file for every DB value; and
- zero or more `rendered/...` primitive leaf files for that value.

Directories are not semantic virtual entries. They are created as needed to
write files and may be removed after their last managed descendant is deleted.
A files-only virtual listing is sufficient because all compound shape is stored
in `typesscm`.

### 16.2 DB-to-filesystem authority

During DB-to-filesystem render, the DB is authoritative for the entire managed
domain. Manual edits, stale files, stale schemas, and partial projections in
that domain are overwritten or deleted to match the DB projection. Existing
invalid target state does not prevent cleanup when the desired DB state is
known.

### 16.3 File/directory replacement

Shape changes are normal reconciliation operations:

- scalar → compound with primitive descendants: replace the scalar file with
  parent directories and desired primitive files;
- scalar → primitive-free compound: delete the scalar file and write only the
  schema;
- compound → scalar: delete descendant files and conflicting directories, then
  create the scalar file;
- compound with leaves → primitive-free compound: delete all rendered leaves
  and write the new schema;
- object ↔ array: reconcile the exact primitive leaf set and update the schema;
- schema-path directory → schema file: delete the conflicting directory before
  writing the schema file; and
- schema-path file blocking a required parent directory: replace it with the
  required directory before writing descendants.

The concrete operation ordering may differ, but it MUST deterministically reach
the desired file set when all operations succeed.

### 16.4 Stale files and incidental directories

Every extra file inside the managed domain is stale and MUST be deleted,
including:

- undeclared rendered leaves;
- rendered leaves below empty or primitive-free schema subtrees;
- rendered leaves for deleted DB keys;
- orphan schema files; and
- unrelated files placed under the selected managed sublevel.

When `{ "x": 1 }` becomes `{}`, render deletes `rendered/<root>/x`, writes the
schema `{}`, and requires no rendered root. When `[1, 2]` becomes `[]`, render
deletes indices `0` and `1`, writes the schema `[]`, and requires no rendered
root.

Directories left empty after file deletion have no semantic meaning. The
renderer SHOULD remove now-unused managed directories when the filesystem
abstraction supports or requires that cleanup. Canonical output MUST NOT require
empty directories for empty compounds. A canonical comparison MAY ignore
incidental empty parent directories left by the abstraction, but MUST reject
any stale rendered file within them.

Deleting a DB value deletes its schema file and all rendered primitive leaves
under its value root, including stale leaves not justified by the previous
schema.

### 16.5 Paths outside the managed domain

A render of replica sublevel `r` may reconcile:

```text
rendered/r/...
typesscm/r/...
```

but MUST NOT modify another top-level sublevel or arbitrary paths outside the
`rendered/` and `typesscm/` roots.

A higher-level whole-snapshot render invokes the required sublevel operations as
one rendered-database workflow and treats both physical trees as parts of that
workflow.

### 16.6 Comparison

For filesystem targets, comparison is by canonical virtual file path and
content:

- regular-file content must match exactly;
- type-schema formatting differences are real target differences and are
  canonicalized;
- string leaf content is compared exactly, including whitespace and newlines;
- boolean and null files are compared exactly; and
- incidental empty directories do not constitute value content.

For DB targets, reconstructed values are compared using the database's semantic
value equality. Object insertion order MUST NOT cause a semantic rewrite.

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

Production import, reset, synchronization, and database-migration flows MUST
apply scans to an inactive replica or otherwise isolated target and cut over
only after the entire operation, required validation, and durability step
succeed.

A failed scan into an inactive replica may leave that inactive replica dirty.
It MUST remain inactive and may be cleared or overwritten by a later attempt.
The active replica remains authoritative.

A rendered worktree may likewise be partially changed if rendering fails. A
higher-level Git/checkpoint operation MUST commit or publish only after the full
paired-tree render succeeds. Failed worktree state is not a valid snapshot.

The exploded codec itself does not promise cross-tree atomicity. Its promise is
that successful output is paired and valid, invalid input is rejected, and
higher-level cutover never treats a failed partial target as active.



## 18. Worked examples

### 18.1 Scalar roots

```text
DB value true:
  rendered/r/values/nodeA = true
  typesscm/r/values/nodeA = "boolean"
```

```text
DB value false:
  rendered/r/values/nodeA = false
  typesscm/r/values/nodeA = "boolean"
```

```text
DB value "true":
  rendered/r/values/nodeA = true
  typesscm/r/values/nodeA = "string"
```

The schema disambiguates identical rendered text.

### 18.2 Empty root compounds

Root empty object:

```text
rendered/r/values/nodeA   absent
typesscm/r/values/nodeA   file: {}
```

Root empty array:

```text
rendered/r/values/nodeA   absent
typesscm/r/values/nodeA   file: []
```

### 18.3 Primitive-free nested compounds

Value:

```json
{
  "object": {
    "nestedArray": [[], {}]
  },
  "array": [{}, [[]]]
}
```

The schema contains the complete structure:

```json
{
  "array": [
    {},
    [
      []
    ]
  ],
  "object": {
    "nestedArray": [
      [],
      {}
    ]
  }
}
```

There are no rendered files and no rendered value-root path required.

### 18.4 Object with dangerous keys

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

Rendered leaf names:

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

The schema keeps the original keys.

### 18.5 Array order beyond nine elements

For an array with indices `0` through `10`, a directory listing may return
`0, 1, 10, 2, ...`. Scanning still reads each primitive file by the numeric
index specified by the schema.

### 18.6 Empty compound type change

Changing `{}` to `[]` changes the schema file from `{}` to `[]`. Both states
have no rendered value-root path, so the schema file is the only changed file.

## 19. Conformance test scenarios

The scenarios below are normative behavioral cases. Test helpers may exercise a
pure codec, virtual-file layer, adapters, or end-to-end render/scan, but the
observable setup and outcome must remain equivalent.

### 19.1 Codec and rendering: positive cases

For each case, assert exact rendered files, exact leaf contents, exact schema,
and successful scan back to the source value.

1. String scalar `"hello"` renders plain `hello` with schema `"string"`.
2. Empty string creates a zero-byte file.
3. Spaces and leading/trailing whitespace are preserved.
4. Multiline string, including a final newline, is preserved exactly.
5. Strings `"5"`, `"null"`, `"true"`, `"false"`, and `"{"x":1}"`
   remain strings according to schema.
6. Numbers cover integer, decimal, zero, negative, exponent serialization, and
   negative-zero canonicalization.
7. Root `true` renders exact `true` with schema `"boolean"`.
8. Root `false` renders exact `false` with schema `"boolean"`.
9. Boolean object properties render as primitive leaf files.
10. Boolean array elements render at their numeric index paths.
11. Null renders exact `null` with schema `"null"`.
12. Flat, nested, deeply nested, and mixed object/array structures round-trip.
13. Root `{}` has one schema file and no rendered root.
14. Root `[]` has one schema file and no rendered root.
15. Empty object property has no rendered child path.
16. Empty array property has no rendered child path.
17. Empty object array element has no rendered index path.
18. Empty array array element has no rendered index path.
19. Object containing only empty objects/arrays has schema but no rendered
    subtree.
20. Array containing only empty objects/arrays has schema but no rendered
    subtree.
21. Deeply nested empty compounds with no primitive leaves have schema but no
    rendered files.
22. A compound with both primitive and primitive-free children renders only the
    primitive descendants.
23. Object keys `"0"` and `"1"` remain object properties.
24. Keys containing `/`, `%`, `!`, `.`, `..`, empty string, and newline where
    supported round-trip through one segment.
25. Escape-looking keys remain distinct from decoded keys.
26. Keys named `items`, `rendered`, and `typesscm` have no reserved behavior.
27. Opposite object insertion orders produce byte-identical canonical output.
28. Arrays with index `10` scan correctly regardless of lexical listing order.
29. `_meta/current_replica` and `r/global/version` use the same value projection
    rules as other DB entries.

### 19.2 Rendering: unsupported source values

Each case fails before publishing a valid value projection:

1. `undefined` at the root, in an object property, or in an array element.
2. `NaN`, positive infinity, or negative infinity.
3. bigint, function, or symbol.
4. sparse array.
5. cyclic object or array.
6. custom class instance or other non-plain-data object.
7. binary value.
8. date.

### 19.3 Codec and scanning: negative cases

Cases 1 through 20 fail with the value root and offending path where
applicable. Case 21 is the acceptance control for schema-only empty compounds.

1. Primitive schema leaf is missing its rendered file.
2. Schema `"boolean"` is missing its rendered file.
3. Boolean file contains `TRUE`, `False`, `1`, `0`, a trailing-newline variant
   of `true`, or a whitespace-padded variant of `true`.
4. Number file contains non-number text, trailing garbage, multiple tokens,
   whitespace padding, `NaN`, infinity, or JSON string syntax.
5. Null file is empty or contains `NULL`, whitespace, or a trailing newline.
6. Type schema contains unknown token or unsupported token `"undefined"`.
7. Type schema uses `"object"` or `"array"` instead of structural shape.
8. Type schema contains literal JSON `null`, number, `true`, or `false` where a
   schema is expected.
9. Type-schema JSON is malformed or has trailing data.
10. Type-schema path is a directory or unsupported entry kind.
11. Rendered primitive path is a directory or unsupported entry kind.
12. A required traversal parent is a file.
13. Array path uses `01`, `-1`, `+1`, `1.5`, `1e1`, or non-number text.
14. Array path is missing or lies outside the schema length.
15. Object path has duplicate decoded keys or colliding escape variants.
16. Rendered path exists for an empty object schema.
17. Rendered path exists for an empty array schema.
18. Rendered file exists below any schema subtree with no primitive leaves.
19. Rendered file exists without any type-schema root claiming it.
20. Rendered file is extra relative to a non-empty schema.
21. Schema-only empty-compound root without a rendered root is accepted, not
    rejected.

### 19.4 Round-trip and canonicalization cases

1. Assert `scan(render(value)) = value` for every primitive, nested object,
   nested array, mixed structure, escaped-key object, and primitive-free
   compound example.
2. Assert boolean/string disambiguation for rendered text `true` and `false`.
3. Canonicalize unusual schema whitespace and unsorted schema object members.
4. Preserve exact manually edited string text.
5. Normalize valid noncanonical number text such as `1.0` and `1e0`.
6. Canonicalize accepted lowercase path escapes to uppercase.
7. Ignore filesystem discovery order for object leaves and array indices.
8. Keep schema-only empty roots schema-only after scan and render.
9. Remove unclaimed rendered files during authoritative DB render.
10. Assert `render -> render` idempotence and `scan -> render -> scan` stability.

### 19.5 DB-to-filesystem reconciliation

1. Empty target and one DB value create one schema and all primitive leaves.
2. Same target and DB state produce no semantic changes.
3. Scalar content change updates the leaf; unchanged schema need not be written.
4. `true` → `false` updates rendered content and leaves schema unchanged.
5. `true` → `"true"` keeps rendered text and changes schema from `"boolean"`
   to `"string"`.
6. `"false"` → `false` keeps rendered text and changes schema from `"string"`
   to `"boolean"`.
7. `"5"` ↔ `5` and `"null"` ↔ null update schema despite identical text.
8. Noncanonical schema formatting is rewritten canonically.
9. Added DB value creates schema and required primitive leaves.
10. Deleted DB value deletes schema and every rendered leaf under its root.
11. Deleting a schema-only empty value still deletes its schema file.
12. Deleting a value with stale rendered files deletes those stale files too.
13. Removing nodeB while retaining nodeA deletes both managed sides for nodeB.
14. Scalar → object/array with leaves replaces file with descendant files.
15. Object/array with leaves → scalar removes stale descendants and writes file.
16. Object with child → `{}` deletes child leaves, writes `{}`, and requires no
    rendered path.
17. Array with elements → `[]` deletes index leaves, writes `[]`, and requires
    no rendered path.
18. `{}` → object with child creates the child file and updates schema.
19. `[]` → array with child creates the index file and updates schema.
20. `{}` → `[]` and `[]` → `{}` update schema only while rendered side remains
    absent.
21. Object containing only empty compounds → object with primitive leaf creates
    the rendered leaf path.
22. Object with primitive leaf → object containing only empty compounds deletes
    the leaf and requires no rendered subtree.
23. Array length shrink deletes removed indices; growth creates new indices.
24. Object ↔ array removes stale old-shape leaves and creates desired leaves.
25. Nested removed property deletes stale leaf and now-unused incidental parents.
26. Manual rendered or schema edits are overwritten by authoritative DB state.
27. Extra managed rendered or schema files are deleted.
28. Stale empty directories from partial runs are not required and SHOULD be
    removed when supported; stale files within them are always deleted.
29. File/directory conflicts are resolved deterministically.
30. Paths outside the selected managed domain remain untouched.
31. Mid-render failure is propagated and the worktree is not published.
32. Re-running after partial failure converges to the exact desired virtual file
    set.

### 19.6 Filesystem-to-DB reconciliation

1. Empty DB target and one snapshot value create the DB value.
2. Same semantic value causes no DB change.
3. Changed primitive leaf replaces only its complete containing DB value.
4. Missing schema root deletes the corresponding target DB key.
5. Added schema root creates the corresponding target DB key.
6. Source omission deletes nodeB without affecting nodeA or another sublevel.
7. Scalar/object/array transitions replace the complete DB value.
8. Array shrink and growth replace the complete array value.
9. Schema-only root `{}` scans to empty object without a rendered root.
10. Schema-only root `[]` scans to empty array without a rendered root.
11. Nested primitive-free compounds reconstruct correctly without rendered
    files.
12. Rendered extra below empty object or empty array schema fails.
13. Boolean leaves scan to booleans.
14. Identical rendered text `true` or `false` scans as boolean or string solely
    according to schema.
15. Missing primitive leaf, extra rendered file, malformed schema, or invalid
    scalar content fails loudly.
16. One valid and one invalid value never writes the invalid value; any earlier
    streamed mutation remains confined to the inactive target replica.
17. Mid-scan failure propagates and does not switch the replica pointer.
18. Scanning one top-level sublevel does not delete another sublevel.
19. `_meta` entries use the same projection rules when `_meta` is selected.
20. Object member order differences alone do not cause a semantic DB rewrite.

### 19.7 Paired-tree consistency

1. Every type-schema file defines exactly one DB value.
2. Every selected DB value has exactly one type-schema file.
3. Rendered files are exactly the primitive leaves required by their schemas.
4. A schema-only value with no primitive leaves is valid.
5. Every rendered file is claimed by exactly one type-schema root and primitive
   schema leaf.
6. A rendered file without a claiming schema is invalid.
7. Adding or deleting a DB value adds or deletes its schema and all required
   primitive files.
8. Primitive content changes may leave schema identical.
9. Primitive type changes with identical text update schema.
10. Empty object/array type changes may update schema only while rendered side
    remains absent.
11. Leaves and schema are derived from the same source value projection.
12. Duplicate physical names that decode to one schema path are rejected.

### 19.8 Path-shape conflicts

1. Scalar file conflicts with new object or array descendants.
2. Object or array descendants conflict with a new scalar file.
3. Child scalar file conflicts with a new nested compound path.
4. Nested compound path conflicts with a new child scalar file.
5. Schema directory exists where schema file is required.
6. Schema file blocks a required parent directory.
7. Stale descendants remain after a parent becomes scalar or primitive-free.
8. Escape variants collide after tolerant decoding.
9. Empty-string and dot sentinels remain distinct from literal escape-looking
   keys.
10. Numeric object key and array index use the same physical spelling but are
    interpreted by parent schema only.

### 19.9 Ordering, determinism, and idempotence

1. Object insertion order and DB key listing order do not affect output.
2. Target file listing order does not affect reconciliation.
3. Arrays preserve semantic order regardless of directory order.
4. Type-schema formatting and primitive file contents are deterministic.
5. Repeated render produces no semantic changes.
6. `render -> render` is idempotent.
7. `scan -> render -> scan` is stable.
8. Array index `10` is reconstructed numerically despite lexical order.
9. Canonical virtual file ordering includes both trees deterministically.
10. Deletion planning is deterministic for stale file/directory conflicts.

### 19.10 Stale-deletion regression coverage

1. Deleted DB key removes its schema and every rendered primitive leaf.
2. Removed object property deletes its leaf or descendant leaves.
3. Shortened array deletes removed primitive indices and descendants.
4. Shape transition deletes every leaf made stale by the previous shape.
5. Empty compounds are represented only in `typesscm`.
6. Files below an empty or primitive-free schema subtree are deleted.
7. Orphan rendered files and orphan schema files are deleted during
   authoritative DB render.
8. Stale rendered empty directories from partial runs are not canonical output
   and SHOULD be removed when supported.
9. Canonical comparison MAY ignore incidental empty parent directories left by
   the filesystem abstraction but never ignores stale files.
10. Empty `{}` and `[]` never require a rendered directory.

## 20. Out of scope

The following are deliberately not specified here:

- implementation function or class names;
- format evolution;
- support for `undefined`, binary values, dates, bigint, custom classes, or
  other values outside the supported rendered value domain;
- filesystem portability rules beyond the existing path-segment and UTF-8 text
  abstractions;
- authorization, rate limiting, resource caps, or adversarial-client defenses;
- merge semantics for two concurrently edited rendered databases;
- making adapter-level filesystem writes or multi-key DB reconciliation atomic;
- optimizing partial DB updates below one complete DB value; and
- changing identifier-native raw DB key design.

Any future extension of the value domain requires an unambiguous schema token or
structural rule. It MUST NOT be introduced by guessing from leaf text.

## 21. Summary of invariants

A conforming rendered database satisfies all of these invariants:

1. Every selected DB key maps through the existing opaque-key codec to one value
   root.
2. Every selected DB value has exactly one local type-schema file.
3. Rendered files exist exactly for primitive schema leaves: string, number,
   boolean, and null.
4. A type-schema value root may have no rendered root when its schema has no
   primitive leaves.
5. Every rendered file is claimed by exactly one type-schema root and primitive
   schema leaf.
6. Object keys use bijective single-segment encoding; arrays use canonical
   unpadded decimal indices.
7. Strings are exact plain text, numbers are complete finite JSON number tokens,
   booleans are exactly `true` or `false`, and null is exactly `null`.
8. Empty and primitive-free compounds are represented by schema only; rendered
   directories carry no semantic meaning.
9. No unsupported value or schema kind is guessed, omitted, or coerced.
10. The two physical trees form one logical snapshot and are derived from the
    same value projections.
11. Successful render/scan satisfies the value round trip and canonical snapshot
    round trip.
12. Gentle unification deletes stale managed files and resolves shape conflicts
    deterministically.
13. Adapter-level failures are non-atomic; inactive-replica and publish/cutover
    machinery prevents failed partial targets from becoming authoritative.
14. This specification introduces no format discriminator; the existing
    `rendered/r/global/version` database value remains the only version-like
    marker in this area.
