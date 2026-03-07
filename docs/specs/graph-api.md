# Spec: Incremental Graph Inspection API

A read-only HTTP API for inspecting the incremental graph — its schema definition
and the set of currently materialized node instances — without triggering
recomputation.

---

## 1. Motivation

The incremental graph is a live, LevelDB-backed computation cache.  Diagnosing
staleness bugs, auditing what has been computed, and understanding dependency
structure all currently require attaching a debugger or reading raw LevelDB files.
This spec defines a small REST API that exposes that information through the
existing Express server.

---

## 2. URL Prefix

All endpoints are mounted under the server's base path:

```
{BASE_PATH_PREFIX}/api/graph/
```

In the default (root-path) deployment this is `/api/graph/`.

---

## 3. Endpoints

### 3.1 `GET /api/graph/schemas`

Returns the complete schema — every node family defined in the graph.

**Response `200 OK`:**

```json
[
  {
    "head": "all_events",
    "arity": 0,
    "output": "all_events",
    "inputs": [],
    "isDeterministic": false,
    "hasSideEffects": false
  },
  {
    "head": "meta_events",
    "arity": 0,
    "output": "meta_events",
    "inputs": ["all_events"],
    "isDeterministic": true,
    "hasSideEffects": false
  },
  {
    "head": "event_context",
    "arity": 0,
    "output": "event_context",
    "inputs": ["meta_events"],
    "isDeterministic": true,
    "hasSideEffects": false
  },
  {
    "head": "event",
    "arity": 1,
    "output": "event(x)",
    "inputs": ["all_events"],
    "isDeterministic": true,
    "hasSideEffects": false
  },
  {
    "head": "calories",
    "arity": 1,
    "output": "calories(x)",
    "inputs": ["event(x)"],
    "isDeterministic": true,
    "hasSideEffects": true
  }
]
```

Fields are sourced from `CompiledNode` (from `headIndex` on the graph instance):

| Field | Source | Description |
|---|---|---|
| `head` | `compiledNode.head` | Functor name used in API calls |
| `arity` | `compiledNode.arity` | Number of arguments |
| `output` | `compiledNode.canonicalOutput` | Canonical pattern string |
| `inputs` | `compiledNode.canonicalInputs` | Canonical input pattern strings |
| `isDeterministic` | `compiledNode.source.isDeterministic` | Same inputs → same output |
| `hasSideEffects` | `compiledNode.source.hasSideEffects` | Computor has side effects |

---

### 3.2 `GET /api/graph/schemas/:head`

Returns the schema entry for a single node family.

**Response `200 OK`:** Single object with the same shape as one element from §3.1.

**Response `404 Not Found`:**

```json
{ "error": "Unknown node: \"unknown_head\"" }
```

---

### 3.3 `GET /api/graph/nodes`

Lists all currently materialized node instances with their freshness status.
**Does not trigger recomputation.**

**Response `200 OK`:**

```json
[
  { "head": "all_events", "args": [],              "freshness": "up-to-date" },
  { "head": "meta_events", "args": [],             "freshness": "up-to-date" },
  { "head": "event_context", "args": [],           "freshness": "potentially-outdated" },
  { "head": "event",   "args": ["evt-abc123"],     "freshness": "up-to-date" },
  { "head": "event",   "args": ["evt-def456"],     "freshness": "up-to-date" },
  { "head": "calories","args": ["evt-abc123"],     "freshness": "up-to-date" },
  { "head": "calories","args": ["evt-def456"],     "freshness": "potentially-outdated" }
]
```

`freshness` is one of `"up-to-date"` | `"potentially-outdated"`.

Values are not included in this listing.  Node values can be large (e.g.
`all_events` contains the full event log) and fetching them in bulk would be
expensive.

---

### 3.4 `GET /api/graph/nodes/:head`

**Arity-0 nodes** (singletons like `all_events`, `meta_events`): returns the
single materialized instance including its cached value.
**Does not trigger recomputation.**

**Response `200 OK`:**

```json
{
  "head": "all_events",
  "args": [],
  "freshness": "up-to-date",
  "value": { "type": "all_events", "events": [ { "..." } ] }
}
```

**Arity-N nodes** (parameterized families like `event`, `calories`): returns the
list of all materialized instances for that head, identical in shape to the
filtered result of §3.3 (no values).

**Response `200 OK`:**

```json
[
  { "head": "calories", "args": ["evt-abc123"], "freshness": "up-to-date" },
  { "head": "calories", "args": ["evt-def456"], "freshness": "potentially-outdated" }
]
```

**Response `404 Not Found`** (arity-0 node that has not been materialized yet):

```json
{ "error": "Node not materialized: \"all_events\"" }
```

**Response `404 Not Found`** (unknown head):

```json
{ "error": "Unknown node: \"unknown_head\"" }
```

---

### 3.5 `GET /api/graph/nodes/:head/:arg0[/:arg1[/:arg2…]]`

Returns a single materialized instance for a parameterized node, with its cached
value.  **Does not trigger recomputation.**  Path segments beyond `:head` become
the ordered `args` array; clients must percent-encode any `/` characters within
an argument value.

**Response `200 OK`:**

```json
{
  "head": "calories",
  "args": ["evt-abc123"],
  "freshness": "up-to-date",
  "value": { "type": "calories", "calories": 412 }
}
```

**Response `404 Not Found`** (node not yet materialized):

```json
{ "error": "Node not materialized: \"calories(evt-abc123)\"" }
```

**Response `400 Bad Request`** (wrong number of args for head's arity):

```json
{ "error": "Arity mismatch: \"calories\" expects 1 argument, got 2" }
```

---

## 4. Non-Triggering Guarantee

All endpoints in this API **must never** call `pull()`, `pullWithStatus()`, or
any method that may trigger recomputation.  They may only call:

- `graph.headIndex` — to resolve schema info
- `graph.debugListMaterializedNodes()` — to enumerate instances
- `graph.debugGetFreshness(head, args)` — to get freshness of one node
- A new `graph.debugGetValue(head, args)` method (see §5) — to read a cached
  value without triggering recomputation

This protects against accidentally triggering expensive computors (e.g. OpenAI
API calls for `calories`) merely by browsing the inspection endpoint.

---

## 5. New Graph Method Required

The implementation requires adding one new method to `IncrementalGraphClass`:

```javascript
/**
 * Returns the cached value of a node without triggering recomputation.
 * Returns undefined if the node has not been materialized.
 * @param {NodeName} nodeName
 * @param {Array<ConstValue>} bindings
 * @returns {Promise<ComputedValue | undefined>}
 */
async debugGetValue(nodeName, bindings = []) { … }
```

This reads directly from `this.storage.values.get(concreteKeyString)` inside the
existing graph class, analogous to `debugGetFreshness`.  It does **not** acquire
the graph mutex.

---

## 6. Integration Points

### Route file

New file: `backend/src/routes/graph.js`

The route reads `capabilities.interface.incrementalGraph` directly (the graph is
already initialized by the time any request is served).  It does not need to call
`ensureInitialized()`.

The route must return `503 Service Unavailable` if called before initialization:

```json
{ "error": "Graph not yet initialized" }
```

### Server registration

In `server.js`, mount the graph router alongside the existing API routes:

```javascript
app.use(`${BASE_PATH_PREFIX}/api/graph`, makeGraphRouter(capabilities));
```

### Capabilities type

The route requires only `capabilities.interface` — the existing `Interface`
object already exposed on root capabilities.

---

## 7. Error Response Shape

All error responses use the same envelope:

```json
{ "error": "<human-readable message>" }
```

HTTP status codes used:

| Situation | Status |
|---|---|
| Unknown node head | `404` |
| Node not materialized | `404` |
| Arity mismatch | `400` |
| Graph not yet initialized | `503` |

---

## 8. Invariants and Constraints

- All endpoints are **read-only** (GET only).  No mutations.
- The API is **unauthenticated** at the same level as the rest of the API —
  authentication is handled at the infrastructure level, not per-route.
- Response bodies are always `application/json`.
- The `value` field is always the raw `ComputedValue` object as stored in
  LevelDB — no transformation or filtering.
- The API does not guarantee consistency between calls: a node appearing as
  `up-to-date` in one response may be `potentially-outdated` in the next.
