# Board 92 — independent review of f8121603 "Scope a recorded validity clear to the dependents it observed"

**VERDICT: CHANGES-REQUIRED — the observed-scope rule is unsound: it fixes target #1 by deleting a safety property, and it leaves reachable interleavings in which a dependent keeps a positive proof against a dependency value that the clearing transaction itself has just superseded.**

Front under review: implementation front 92d5. Report read second, after the source, as instructed.
All citations below were opened by me at `f81216036859decd7f11ad66da990420f5868f4f` in
`/workspace/volodyslav-92-review`.

Marks used throughout: **ESTABLISHED** = I checked it at this head. **RELAYED** = the
implementation front's claim, not re-derived by me. **NOT ESTABLISHED** = I could not check it,
with the reason given.

---

## 1. MUST-FIX

### F1 — MUST-FIX — a committed dependent the transaction never observed survives a clear that should have removed it, and it survives as a *false* proof

**Files / lines (all at head):**

- `backend/src/generators/incremental_graph/validity_mutations.js:47-49` and `:52-56`
- `backend/src/generators/incremental_graph/graph_state.js:239-241` (`observedReads` + `clearMutation`) and `:283-291` (`get`)

**Quoted text:**

`validity_mutations.js:52-56`

```js
        if (m.kind === "clear") {
            if (m.observed === undefined) {
                validSet = [];
                continue;
            }
            const observed = m.observed.map(nodeIdentifierToString);
            validSet = validSet.filter(id => !observed.includes(nodeIdentifierToString(id)));
```

`graph_state.js:239-241`

```js
    /** @type {Map<string, NodeIdentifier[]>} */
    const observedReads = new Map();

    /**
     * @param {string} k
     * @returns {ValidClearMutation}
     */
    const clearMutation = (k) => ({ kind: "clear", observed: observedReads.get(k) });
```

**Why it matters — the concrete interleaving.** I reconstructed this against the real code
paths, not abstractly. The window that makes it reachable is the one the commit message itself
names: *the transaction's read of the set* (`recompute.js:111`) and *its commit*
(`appendValidMutationOps`, called from the darkroom finalization). Nothing holds a lock across
that window. ESTABLISHED by reading the lock sources:

- `lock.js:121-126` — `telescopeActivity` is `sleeper.withMutex(TELESCOPE_FUNCTOR.instantiate([nodeKeyStr]), procedure)`.
- `sleeper.js:65-70` — `withMutex` releases in a `finally` when `procedure()` returns.
- `pull.js:182-186` — the telescope wraps only `pullNodeWithTelescopeHeld(graph, nodeKeyStr, operation)`.

So the telescope for node `z` is released when `pull(z)` returns, which is *before* the operation
that pulled `z` does the rest of its work and reaches its darkroom finalization. The recorded
clear is therefore held, unresolved, across an unbounded window. ESTABLISHED.

Interleaving (nodes `z` zero-input; `x`, `y` each with `inputs: ["z"]`):

1. State: `z` is `up-to-date` with value `Z0`; `valid[z] = []` (neither `x` nor `y` has been
   pulled since `z`'s last materialisation).
2. `invalidate("z")`. `invalidate.js:88-93` marks `z` `potentially-outdated`, removes `z`'s
   *incoming* proofs, and preserves outgoing ones — `valid[z]` stays `[]`. Committed.
3. `op1 = pull("x")` and `op2 = pull("y")` start concurrently.
4. `op1` pulls `z`: committed `z` is `potentially-outdated`, so `pull.js:126-129`
   (`readUpToDateCachedValue` returns nothing) re-materialises it. Its computor returns `Z1`.
   `recompute.js:108-113` runs: `removeIncomingValidity`; `const downstream = await
   batch.valid.get(nodeIdentifier)` reads committed `valid[z] = []`, so
   `graph_state.js:285` records `observed[z] = []`; `batch.valid.clear(z)` records
   `{kind:"clear", observed: []}`. `values[z] = Z1` staged, not committed. `telescope(z)` released.
5. `op2` pulls `z`: `telescope(z)` is free. Committed `z` is *still*
   `potentially-outdated` (`op1` has not committed), so `op2` **also** re-materialises `z`,
   computor returns `Z2`. Same reads: `observed[z] = []`, `clear(observed=[])` recorded.
   `op2` then pulls `y`; `y`'s `handleChanged`/`handleUnchanged`
   (`recompute.js:72-76`, `:87`, `:135`) records `remove:y`/`add:y` on `valid[z]`.
   `op2` **commits**: `values[z] = Z2`, `freshness[z] = up-to-date`, `valid[z] = {y}`.
6. `op1` **commits**: `values[z] = Z1` (overwrites `Z2`), `freshness[z] = up-to-date`, and
   `valid[z] = applyValidMutations({y}, [clear(observed=[]), remove:x, add:x])` = `{y, x}` —
   because the `[]`-scoped clear withdraws nothing.

**Result:** `valid[z] = {x, y}` against `values[z] = Z1`, and `y`'s proof was established against
`Z2`, a value that no longer exists anywhere. `y` is `up-to-date`. On the next pull of `y` the
cache predicate at `recompute.js:203-215` is satisfied — spec `Pull Algorithm` step 4 (spec
`:227-230`) checks only `valid[D].has(N)`, never occurrence identity — so `values[y]`, computed
from the superseded `Z2`, is returned. ESTABLISHED by reading `recompute.js:203-216` and spec
`:227-230`.

**Under the base code this interleaving is handled correctly**: an unconditional `validSet = []`
gives `valid[z] = {x}`, `y` has no proof, and `y` recomputes against `Z1`. ESTABLISHED by reading
the parent revision of `appendValidMutationOps` in the commit's own diff (deleted lines
`validity_mutations.js` old `:80-95`).

So this is a **regression relative to base**, not a neutral trade. The safety property the base
had — a changed value empties the outgoing set — is gone, and the front's own two-target
situation (one target green, one red) is a symptom of that: the rule is right when both
transactions happen to observe an empty set (target #1, `tests/incremental_graph_concurrency.test.js:1987`)
and wrong when they both observe a populated set (target #2, same file `:2049`). The root cause
is common to both; the new rule does not address it, it only moves which side of it the code
falls on.

**The Journal angle** (this is issue 92, a Journal issue): step 6 leaves a `ValidateEvent` for `y`
whose validation basis is `{ input: z, value: <ValueId of op2's Z2> }`, while the committed
`z` occurrence is `op1`'s. The emission doc's `:73` "A validation clears its effect only by
causally observing it" and `:53-58` "one canonical-order basis entry per current direct input"
assume the basis names the *current* direct-input `ValueId`. This commit can make a persisted
basis name a superseded one. ESTABLISHED by reading
`docs/specs/incremental-graph-journal-emission.md:51-64`.

**What would falsify F1** (i.e. what I looked for and did not find): any mechanism that
(a) re-reads `values[z]` or `freshness[z]` at the commit seam, (b) re-reads `valid[z]` at
finalization and compares against the occurrence the transaction is publishing, or (c) holds a
lock spanning `recompute.js:111` to `appendValidMutationOps`. I read `appendValidMutationOps`
in full (`validity_mutations.js:66-86`): it reads `activeSchemaStorage.valid.get(depId)` and
nothing else. It does not consult `values`, `freshness`, or any `ValueId`. No such mechanism
exists at this head.

**Direction, offered because a rejection is not a fix.** The rule that is both sound and green on
both targets is *occurrence-scoped* withdrawal, not observation-scoped: a clear of `valid[N]` must
withdraw every dependent whose proof is not against the value occurrence of `N` that this
transaction is committing, and preserve those that are. The blocker is that
`valid[D]` is `NodeIdentifier[]` with no occurrence tag — spec
`incremental-graph-flag-based-inverse-validity.md:413`: "`valid[D]` serializes as an array of
`NodeIdentifier` values in canonical sorted order." Implementing this means a storage-shape
change, so it is out of scope for this front, but it is the honest characterisation of the
residual defect: **the change under review does not fix the bug it targets; it removes the
guarantee that made the bug non-fatal.**

### F2 — MUST-FIX — the commit message and the module JSDoc state an unsound rule as a settled property

**Files / lines:** `validity_mutations.js:33-38`; `graph_state.js:81-85`; `graph_state.js:234-237`; commit message lines 16-19.

**Quoted text:**

`validity_mutations.js:33-38`

```
 * A `clear` withdraws exactly the dependents the transaction observed in the set
 * it clears, and preserves every other committed dependent. Without that
 * restriction a clear resolved against committed state erases edges which other
 * transactions established after this transaction read the set: two transactions
 * which both materialise a shared dependency each record a clear for that
 * dependency's outgoing set, and the second clear would drop the first
 * transaction's dependent. A clear recorded without an observation replaces the
 * set wholesale.
```

commit message: *"Committed dependents the transaction never observed survive the merge."*

**Why it matters.** Both statements are written as invariants of the design. F1 shows the second
one is a defect, not a property: the surviving edge is a proof against a value this transaction
destroys. A future reader (or front) will take "survive the merge" as intended behaviour, which
is how a second front will build on it. Under AGENTS.md's "Replace history with invariants" rule
this is the right *form* — the property asserted is simply false, and no caveat about
`isDeterministic`/`hasSideEffects` appears anywhere in either file. ESTABLISHED: `grep` for
`isDeterministic|hasSideEffects` across `backend/src/generators/incremental_graph/*.js` returns
only `compiled_node_validation.js:223-228` and `types.js:121-122` — the flags are validated and
documented and **read nowhere in the recompute or validity path**.

The flags are the crux: in F1 the harm requires `z`'s computor to yield `Z1 ≠ Z2` on two calls,
i.e. `isDeterministic: false` or `hasSideEffects: true`. The front invokes exactly this fact to
reject candidate B (§4.1 of its report) and does not notice that it convicts the shipped change.

---

## 2. SHOULD-FIX

### F3 — SHOULD-FIX — the batch `get` early return drops the canonical sort, changing what callers see

**File / line:** `graph_state.js:283-291`

**Quoted text:**

```js
        async get(depId) {
            const k = nodeIdentifierToString(depId);
            const muts = validMutations.get(k);
            const result = await db.get(depId) ?? [];
            observedReads.set(k, result);
            if (!muts) {
                return result;
            }
            return applyValidMutations(result, muts);
        },
```

**Why it matters.** The base code sorted unconditionally — the deleted line was
`result.sort(compareNodeIdentifier);` before an unconditional `return result;` (see the diff,
`graph_state.js` old `:103`). Now the no-mutations branch returns the storage array as-is, while
the mutations branch returns a sorted array. Two branches of the same accessor disagree, and the
spec states a storage invariant of sorted order (`incremental-graph-flag-based-inverse-validity.md:413`).
Consumers of the batch accessor that are order-sensitive: `invalidate.js:91`
(`propagatePotentiallyOutdated` walks the array and emits per-dependent records — the emission
doc fixes *canonical* basis order at `incremental-graph-journal-emission.md:55-58`) and
`graph_state.js:539` (`getValid`, part of the public `graph.storage` surface, so user-facing).

In fairness: the base code sorted the array **in place**, so if `db.get` ever hands back a
shared or cached array the base sorted a store-owned array as a side effect. The new code removes
that hazard (in the `muts` branch every operation — `[]`, `filter`, `concat` — allocates before
the final `.sort`, and the early return skips the sort). So this is a defect introduced while
removing a different one. I did not establish whether any committed `valid[D]` array can actually
be unsorted at runtime; `sync_merge_validity.js:403` and `migration_validity.js:178` are write
paths I did not trace. NOT ESTABLISHED whether the ordering difference is observable today.

### F4 — SHOULD-FIX — one function now uses two different scopes, undocumented

**File / line:** `recompute.js:111-113`

```js
    const downstream = await batch.valid.get(nodeIdentifier);
    batch.valid.clear(nodeIdentifier);
    const becameStale = await propagatePotentiallyOutdated(incrementalGraph.storage, batch, downstream);
```

**Why it matters.** `downstream` is the *merged* view (`applyValidMutations(result, muts)`), and
`observed` captured at the same call site is the *raw committed* view (`result`, recorded at
`graph_state.js:285` before the mutations are applied). If the transaction already recorded an
`add` to `valid[N]` before this `get` — possible when `N` was re-validated earlier in the same
operation — then `downstream` contains a dependent that `observed` does not, and
`propagatePotentiallyOutdated` marks it stale while the clear does not withdraw its proof. That
combination is *safe* (a `potentially-outdated` node with intact proofs may cache-revalidate per
spec `:347` and `:192-194`), but it is a third behaviour that neither the commit message nor the
JSDoc mentions, and it means the "scope" the withdrawal uses is not the scope the propagation
used. ESTABLISHED as a code-reading finding; I did not construct an execution that observes it.

### F5 — SHOULD-FIX — a semantic rule changed with no test exercising it

**Evidence.** ESTABLISHED: `git show --name-only f8121603` lists exactly two paths, both under
`backend/src/generators/incremental_graph/`; `git show f8121603 --numstat` gives 29/21 and 43/15
on those two files and nothing else. No test file, no spec file.

The two tests that touch the clear path, ESTABLISHED by reading them, both exercise only the
**wholesale** branch and so are untouched by the new rule:

- `tests/incremental_graph_concurrency.test.js:2347` `"withBatch persists valid.clear mutation"`
  calls `batch.valid.clear(zId)` with no preceding `get` on that key, so `observedReads` has no
  entry, `observed` is `undefined`, and the wholesale branch runs. It asserts
  `expect(persisted).toHaveLength(0)`.
- `:2275` `"withBatch persists valid.add mutations"` does `batch.valid.add` then
  `batch.valid.get`, no clear.

So the observed-scope branch has **zero** direct test coverage at head. The two tests that fail
(the front's targets) reach it only incidentally, and one of them is still red. Whatever the
disposition of F1, a rule that decides whether a node keeps a cache proof needs a test that
constructs the window in F1 directly and asserts the intended outcome.

---

## 3. NOTES

### F6 — NOTE — `put`/`del` now bypass `clear()`, and have no callers

`graph_state.js:293-303`: `put` and `del` each write
`[{ kind: "clear", observed: undefined }]` directly instead of calling `this.clear(depId)`. That
is deliberate (they must stay wholesale) and it is the behaviour the commit message promises.
ESTABLISHED by grep: **no caller of `batch.valid.put` or `batch.valid.del` exists anywhere in
`backend/src`** — the `.put(`/`.del(` hits in `sync_merge_validity.js` and
`sync_merge_transfer.js` are `SchemaStorage.valid.putOp`/`delOp`/sublevel `clear` on the typed
database, a different object. These two methods are contract surface only. If a future caller
arrives expecting `put` to compose with a prior observed `clear`, it will silently get wholesale.
Not a defect today.

### F7 — NOTE — item 6 of my brief: nothing else in the file got worse

ESTABLISHED. The blast radius is one call site. `grep` for `batch.valid.` across `backend/src`
(excluding `database/`) returns exactly seven hits: `graph_state.js:539` (`getValid`),
`invalidate.js:91` (`get`), `recompute.js:55,74,111,112`, `validity.js:22`. **`recompute.js:112`
is the only `clear` call in the codebase.** No batch or transaction path, no migration path, and
no sync-merge path goes through the changed branch. `invalidate.js:91` calls `get` and then
propagates; it never clears, so it is unaffected apart from F3's ordering. Interactions with
`isDeterministic: false` / `hasSideEffects: true`: none in this code — see F2; the flags are
validated and never read on the validity path.

The one thing I could not rule out by reading is whether any *test* asserts the old wholesale
behaviour through `recompute.js:112` in a non-concurrent setting. In a single-threaded run
`observed` always equals the whole committed set, so the resolution is identical — which is
exactly the commit message's claim *"Without a concurrent commit the observed set is the whole
committed set, so the resolved set is exactly what it was before"*, and which I checked against
`applyValidMutations` line by line. ESTABLISHED as an equivalence argument, **not** as a test
result; see item 4.

### F8 — NOTE — the two rejected candidates I was asked about: A and B are correctly rejected, C is correctly rejected and I could settle it statically

All three citations verified verbatim.

**Candidate A** ("do not withdraw proofs across a re-materialisation"). The front cites
`incremental-graph-flag-based-inverse-validity.md:347` and `:192-194`. Line 347 verbatim:
*"Propagated invalidation is freshness-only: it marks downstream nodes stale but preserves all
validity edges. A downstream node reached through propagation retains its incoming proofs and
may cache-revalidate when later pulled."* Lines 192-194 are the same content in the "Stale nodes
may retain outgoing proofs" section. **Citation accurate.** Does the rejection follow? Yes, and I
can make it tighter than the front did: spec `Pull Algorithm` step 4 (`:227-230`) defines cache
revalidation as *membership only* — `for every D in inputEdges(N): valid[D].has(N)` — with no
occurrence comparison anywhere in the pull path. So if a changed `N` does not clear `valid[N]`, a
dependent revalidates its cache across the change, which is precisely what `:347` sanctions and
precisely what the design forbids. **Rejection SOUND.** Note the front's own framing ("sound only
if a stale dependent is *forced* to recompute") is a weaker claim than the spec actually makes;
the spec forbids it unconditionally.

**Candidate B** ("do not clear when the recomputed value equals the stored value"). Cites
`:205-207` and `:287-288`. Verified: `:206-207` *"A changed value clears outgoing validity from
that node, because dependents validated against the old value can no longer trust it."*;
`:287-288` *"When the computor returns a new value, all validity flags involving the old value of
`N` must be removed before new validity facts are recorded."* **Citation accurate** (the front
cites 205-207; the sentence is at 206-207 — immaterial). The first ground holds: the spec
conditions the clear on the computor's `Unchanged` result, not on value equality, so B is a
different rule. **Rejection SOUND on the first ground.**

The second ground is wrong, and I flag it because the report puts it in bold. The front says B
"contradicts the occurrence-based proof model … the proof edge records a `ValueId`, not a value,
so an equal value produced by a new occurrence is still a new occurrence, and keeping the proof
across it is not obviously sound". That reasoning argues the *opposite* of what it is deployed
for: keeping a proof across a new occurrence is precisely what an occurrence-based model
forbids. The correct statement is that B is unsound for the same reason F1 is — a surviving
`valid[D]` edge is a positive assertion, and B manufactures one across an occurrence change. The
rejection is right; the stated reason would, if a later front picked it up, license the unsound
behaviour.

**Candidate C** ("make the per-node telescope span the operation"). This is the one the front
admits it could not settle by execution. **I settled it statically: the deadlock is real for the
literal form of C, and the rejection is SOUND.** The front's cited evidence is
`lock.js:107-110`; the substantive sentence is at **`lock.js:111-113`**, just outside the cited
range:

```
 * Recursive pulls acquire telescopes for each dependency node; different keys
 * never contend, and a self-deadlock would require a dependency cycle (which
 * the graph constructor rejects).
```

That argument is valid only because telescope holds are **non-overlapping in depth**: each nested
pull's telescope is released when that pull returns. `pull.js:182-186` wraps
`pullNodeWithTelescopeHeld` in `telescopeActivity`, and `sleeper.js:65-70` releases in a
`finally`; the front's `pull.js:174-176` citation is the *doc comment* of that function, not the
release site. Under C the wait edges become `(operation, node)` pairs, and the DAG argument in
`lock.js:111-113` no longer applies, because "op1 waits on `w` while holding `z`" is not a
dependency edge of any single node. Concretely: `x` with `inputs: ["z","w"]` and `y` with
`inputs: ["w","z"]`, both `z` and `w` stale — `op1` takes `z` then waits for `w`, `op2` takes `w`
then waits for `z`. The union of the two dependency edge sets is `{x→z, x→w, y→w, y→z}`, which is
acyclic, so the graph constructor's cycle rejection does not fire, and the two operations
deadlock. **Rejection SOUND.** I can strengthen it: `docs/specs/incremental-graph-locking-design.md:206-215`
("Deadlock Discipline") is the paragraph C would have to rewrite — it currently asserts that a
wait edge from `A` to `B` implies a dependency edge, which C invalidates. So the front's
secondary ground (a deferred-release mutex that `sleeper.js` does not have — `withMutex` is
`:47-71`, `finally` at `:67-70`) is also accurate but is the *smaller* part of the objection.

One correction to the report's framing: it says C "is the design the specification already
names… the only candidate that makes test #2 pass for a reason that is already normative."
ESTABLISHED false. `incremental-graph-flag-based-inverse-validity.md` never mentions telescopes
(`grep -n "telescope|serializ"` returns only `:352` and `:413`, both about arrays). The locking
design names a **per-pull** telescope (`:76`, `:131`, `:150`) plus the Deadlock Discipline that C
violates. C is a *change* to the normative locking design, not an implementation of it. The
rejection stands; the justification as stated does not.

### F9 — NOTE — the spec gap is real, and this change makes it more pressing

All four citations verified.

- **No emission-catalogue entry for a bare proof-set mutation.** ESTABLISHED by enumerating the
  section headings of `docs/specs/incremental-graph-journal-emission.md`: Purpose, Emission law,
  Staging and serialized finalization, Contexts are complete semantic observation, Fresh pull
  no-op, First materialization or changed recomputation, `Unchanged` and cache revalidation,
  Explicit invalidation, Propagated persistent staleness, Deletion, Writer state, Publication
  order, Validation basis finalization, Atomicity and allocator safety, No payload-equality
  identity inference, Maintenance boundary. Every entry is keyed to a *node-level* transition
  (materialisation, revalidation, invalidation, deletion). None describes a transition whose only
  persisted effect is to change which dependents hold a proof against an unchanged node — which is
  exactly what the change under review does, and it does it on the recomputation path that the
  "First materialization or changed recomputation" entry (`:51-64`) claims to cover.
- **`withTransaction` / `withBatch` / `graph.storage` absent from the Journal files.** ESTABLISHED:
  `grep -n "withTransaction|withBatch|graph.storage"` over `docs/specs/incremental-graph-journal*.md`
  returns two hits, both incidental prose (`incremental-graph-journal-replay.md:403`
  "Lowering to existing graph storage", `:495` "graph storage contract"). Zero occurrences of
  `withTransaction` or `withBatch` in any Journal spec.
- **`incremental-graph-flag-based-inverse-validity.md:372`** — *"Both `withTransaction()` and
  `withBatch()` use the same validity-mutation finalization path."* **Accurate.**
- **`:387`** — *"Raw `SchemaStorage.valid.putOp` / `SchemaStorage.valid.delOp` are only safe in
  isolated rebuild contexts such as migration or sync merge, not in live graph transactions."*
  **Accurate.** Both are in the spec's "Concurrency safety" list, and both sanction the very
  calling convention the Journal files do not describe.

**Does the change make the gap more or less pressing? More.** The gap is about a proof-set
mutation having no emission entry. This commit makes the proof set's content a function of a
**concurrency-dependent observation** (`observed`) rather than of the graph's semantics alone:
two replicas replaying the same ordered log can now reach different `valid` sets if they observe
different committed states at the same recorded clear. Before the change, a recorded clear had a
single replayable meaning ("empty the set"); after it, it has a meaning indexed by an observation
that no Journal record captures. A replay engine that reconstructs `valid` from records has
nothing to replay `observed` from. I do not know whether replay reconstructs `valid` this way
(I did not trace `incremental-graph-journal-replay.md` into the code) — so I state the gap as
**made more pressing**, and mark the replay-consequence half as **NOT ESTABLISHED**.

---

## 4. Item 1 — self-contained argument

**Question.** Scoping a recorded validity clear to the dependents the transaction observed is
sound only if a dependent the transaction never observed is one it had no standing to withdraw.
Can such a dependent exist, and if it survives, is it stale or correct?

**Answer. It can exist, it survives, and it is STALE. The rule is UNSOUND.** It is sound only under
a stated assumption, and the assumption does not hold in this code.

**The assumption the rule needs**, stated precisely:

> (A) For every transaction `T` and every node `N` whose `valid[N]` `T` clears with a non-`undefined`
> observation `O`: no transaction other than `T` commits an addition to `valid[N]` during the
> interval between `T`'s read that produced `O` and `T`'s resolution of the clear at the commit
> seam.

**What would falsify it.** Any interleaving in which another operation's darkroom finalization
lands inside that interval and pushes an `add` into `valid[N]`. F1 above is such an interleaving,
built from the real call sites, and it falsifies (A) directly.

**Why (A) is not merely unstated but actively violated by the locking design.** The interval spans
from `recompute.js:111` (`await batch.valid.get(nodeIdentifier)`) to the call of
`appendValidMutationOps` in the darkroom finalization. Between those two points:

- the telescope for `N` is **released** — `lock.js:121-126` hands `pullNodeWithTelescopeHeld` to
  `sleeper.withMutex`, whose `finally` at `sleeper.js:65-70` releases when the nested pull
  returns, long before the operation commits;
- the remainder of the operation (its other pulls, its computor, its Journal staging) runs
  unlocked;
- `appendValidMutationOps` then takes the per-replica darkroom lock
  (`validity_mutations.js:66-86`), which is a *different* lock from any telescope and does not
  exclude other operations' finalizations — it serialises them, it does not prevent them.

So (A) reduces to "no other operation commits while this one runs", i.e. "operations do not
overlap". That is the exact property the mutation log exists to make unnecessary: the module
header of `validity_mutations.js:3-6` states its purpose is that "two transactions which touch
overlapping validity sets cannot lose each other's updates" and that mutations are "resolved
against the latest committed state, under the lock which serialises publication". The new rule
takes that guarantee away for the clear case.

**Why the survivor is stale, not correct.** The survivor is a dependent `D` such that
`valid[N] = {…, D, …}` while the committed `values[N]` is the value the *clearing* transaction
`T` just wrote. `D`'s edge was established by some other operation `U`, against whatever
`values[N]` was committed at `U`'s read. `T` is overwriting `values[N]`. Therefore `D`'s edge is a
claim about a value that no longer exists in the store, and `D` is `up-to-date`. The pull path
cannot detect this: spec `Pull Algorithm` step 4 (`:227-230`) and `recompute.js:203-215` test
`valid[D].has(N)` and nothing else — there is no occurrence comparison in the cache predicate, in
`validity.js`, in `propagation.js`, or anywhere in `graph_state.js`. So `D` returns a value
computed from the superseded occurrence. Correctness of the survivor is decided by whether `U`'s
read of `values[N]` preceded or followed `T`'s commit — a fact the resolution never consults,
because `applyValidMutations` is handed only `valid[D]` and the mutation list, and never sees
`values` or `freshness` at all.

**Why the base behaviour was the right default and its loss was the lesser evil.** An
unconditional clear is *conservative*: it can only produce a missing proof, and a missing proof
costs a recomputation. The observed-scope rule is *optimistic*: it can produce a present-but-false
proof, and a present-but-false proof costs a wrong answer. The mutation log was introduced to stop
losing *concurrent additions*, and it did so by ordering adds after the clear at resolution
(`validity_mutations.js:57-63` applies `add` after `clear`), which is why concurrent adds already
survived a wholesale clear whenever the adding transaction's clear resolved *first*. The defect
the front diagnosed is real — two transactions that both clear, resolved in either order, do
destroy each other's frontier (that is target #2, `tests/incremental_graph_concurrency.test.js:2049`,
and it is red at head) — but the front's fix does not address it. It only converts the
conservative failure into the optimistic one for the case where the two transactions' observations
differ. A fix that turns a redundant-recompute bug into a wrong-answer bug, in exchange for
turning a lost-add bug into a no-op, is not a net improvement to the property the module exists to
guarantee.

---

## 5. Item 4 — the regression tally

**NOT ESTABLISHED. I ran no test and produced no name sets.**

Exact reason, stated so it can be checked:

```
$ ls node_modules
ls: cannot access 'node_modules': No such file or directory
$ ls backend/node_modules
ls: cannot access 'backend/node_modules': No such file or directory
$ command -v jest
(no output; exit 1)
```

This worktree has no `node_modules` at the root or in the `backend` workspace, and no `jest`
binary is on `PATH`. The command I would have run is
`npx jest backend/tests/incremental_graph_concurrency.test.js --silent` (or
`--testNamePattern="concurrent validity"` for the two targets), but `npx` with no local install
would resolve from the network, which is outside what I was permitted to do, and I was explicitly
warned that a silently-resolved cache jest from a shared tree would produce numbers from the wrong
jest. There is a `/workspace/volodyslav-shared` tree on this host; I did **not** link it, did not
install anything, and did not execute `npx` at all. Per the instruction, item 4 is left
**NOT ESTABLISHED rather than fabricated**.

**RELAYED** (the implementation front's numbers, not re-derived by me): 48 failed / 2847 passed /
2895 total at base `5e029cef`; 47 failed / 2848 passed / 2895 total at head `f8121603`; the
deduplicated failure-name set shrank by exactly the one target and grew by none. I have **no
independent confirmation** of any of these figures, of the deduplicated-name claim, or of the
direction of the set difference. The count arithmetic is at least internally consistent (48−1=47,
2847+1=2848, total constant at 2895, consistent with no test being added, removed or skipped —
which I did confirm statically, see item 3), but a count is not a name set and this board has a
documented history of a count standing in for coverage.

**What I did establish statically about the affected tests** (this is the part that survives):

- The commit touches no test (`git show --name-only f8121603` → two production files; see item 3
  and F5). So the test corpus is byte-identical at base and head, and any base-vs-head difference
  is attributable to the two production files alone.
- `tests/incremental_graph_concurrency.test.js:1987`
  `"concurrent pulls of nodes sharing a dependency preserve both validity edges"` — target #1.
  Both `x` and `y` pull a **fresh** `z` concurrently, so each `handleChanged(z)` reads
  `valid[z] = []` and records `clear(observed=[])`. At resolution neither clear withdraws
  anything, both `add`s survive, `valid[z] = {x, y}`, and the trailing
  `invalidate("z")` (`:2094-2096`) reaches both. This is the case the change repairs. ESTABLISHED
  by reading the test and `applyValidMutations`.
- `tests/incremental_graph_concurrency.test.js:2049`
  `"concurrent validity additions are preserved during recomputation"` — target #2. Reads the
  report's transcript at face value for the mechanism and independently confirmed it against
  `recompute.js` (the `remove:x`/`add:x` pair on key `z` is `x`'s own incoming-edge bookkeeping
  from `removeIncomingValidity`/`addIncomingValidity`, which is why each transaction's list is
  `[clear(obs), remove:own, add:own]`). Both transactions observe `{x, y}`, so each withdraws the
  other's `add`; the survivor set is `{x}` or `{y}`. Unaffected by the change, and still red.
- `tests/incremental_graph_concurrency.test.js:2275`, `:2309`, `:2347` — the `withBatch`
  mutation tests. Read in full: `:2347` exercises only the wholesale branch (no prior `get` on
  the key), `:2275` and `:2309` never clear after a `get`. All three are behaviourally unaffected
  by the change. ESTABLISHED.
- `tests/incremental_graph_concurrency.test.js:2184`
  `"deterministic barrier proves concurrent valid[D] additions merge when both transactions
  overlap before commit"` — a fourth test whose name asserts exactly the merge property under
  review. I did **not** read its body. NOT ESTABLISHED whether it asserts a set, a count, or an
  order, and therefore whether it is sensitive to the observed-scope rule. It is the first test a
  human with a working `node_modules` should look at.
- `tests/incremental_graph_validity.test.js` and `tests/incremental_graph_spec.test.js` — not
  read. NOT ESTABLISHED.

---

## 6. Item 3 — is the fix in the implementation rather than in a test

**ESTABLISHED, and I checked the converse, which is the part that matters.**

Every file the commit touches, from `git show --name-only f8121603 --format=`:

```
backend/src/generators/incremental_graph/graph_state.js
backend/src/generators/incremental_graph/validity_mutations.js
```

`git show f8121603 --numstat`: `29 21` and `43 15`, total 72 insertions / 36 deletions, matching
the brief. Neither path is a test, a spec, a config, or a lockfile. `git show f8121603 --name-only
--format= | grep -E "test|spec|docs"` returns nothing.

**The converse — did the change alter an expected value, weaken an assertion, or add a skip?** No.
The diff is 205 lines and I read all of it. Every added line in `validity_mutations.js` is inside
the new `applyValidMutations` function or its JSDoc; every added line in `graph_state.js` is the
`observedReads` map, the `clearMutation` helper, the new `ValidClearMutation.observed` typedef
property, the rewritten `get`/`put`/`del` bodies, and JSDoc. There is no assertion, no
expectation, no `skip`, no `only`, no `todo`, no `xit`, no `it.each` change, and no deletion of a
test anywhere in the commit. The only deleted lines are the two inlined mutation-application loops
(`validity_mutations.js` old `:80-95`, `graph_state.js` old `:251-273`) and their doc comments.

So the fix is genuinely in the implementation, and no test was bent to accommodate it. That is
the strongest thing I can say for the commit, and I say it as checked.

---

## 7. Item 2 — the premise of "not fixable by scoping further"

**The premise is CORRECT. I tried to break it and could not, and I am recording that as a point in
the front's favour rather than manufacturing a disagreement.**

I traced what the observation actually reads and when. ESTABLISHED from the code:

- The observation is captured at `graph_state.js:285`, `observedReads.set(k, result)`, where
  `result` is the **raw committed** value returned by `db.get(depId)` — not the
  mutation-merged view. It is captured at every `get`, so it is overwritten by the most recent
  read of that key, and it is snapshotted into the mutation at the moment `clear()` is called
  (`clearMutation(k)` is evaluated inside `clear`, `graph_state.js:288`). So the value is
  accurate as of the last read, and no later read can retroactively change it.
- It is read under no lock beyond whatever the caller holds; in the target-#2 path the read
  happens inside the telescope for `z`, which by then is *already released* relative to the
  commit.

So the question is whether the two transactions' observations were of the same committed state or
whether one was stale when taken. In the report's transcript:

```
MUT 2-testconfingerprint ["clear:observed=[\"1-testconfingerprint\",\"3-testconfingerprint\"]","remove:1-testconfingerprint","add:1-testconfingerprint"]
MUT 2-testconfingerprint ["clear:observed=[\"1-testconfingerprint\",\"3-testconfingerprint\"]","remove:3-testconfingerprint","add:3-testconfingerprint"]
```

Both observed `{1, 3}`. I checked what the committed state of `valid[z]` was at each read against
the test at `tests/incremental_graph_concurrency.test.js:2049`: the test pulls `x` and `y`
**sequentially** at `:2093-2094`, so `valid[z] = {x, y}` is committed before the barrier is armed,
and neither concurrent pull's commit can land before the other's read, because the barrier at
`:2074-2080` holds both computors until both are ready and neither operation reaches its darkroom
finalization until after the barrier. The transcript's own earlier lines corroborate this: the
first four `MUT` entries show `clear:observed=[]` for `z`, i.e. the two sequential pulls
established the edges *after* those reads.

**Conclusion:** both observations are of the *same* committed state `{1, 3}`, and both were
accurate at the instant they were taken. Neither was stale when taken. The premise holds: the
scope is already accurate, and no further scoping can help, because each transaction's loss is
caused by its withdrawing a dependent it genuinely did observe. The front's reasoning is sound and
I could not falsify it. The front's *conclusion* — that this residual needs a design change rather
than a narrower clear — is also correct, and F8's resolution of candidate C supports it.

Where I do part company with the report is not the premise but the implication drawn from it. From
"the scope is accurate and the loss is real" the front concludes the shipped change is a fix. My
F1 shows the same reasoning applied one step further defeats the rule: in F1 the observation is
*also* accurate, the loss is *also* real, and the survivor is a dependent the transaction had no
standing to leave behind. The front correctly observed that a correct scope is necessary and not
sufficient; it did not observe that an accurate scope is also not sufficient, and shipped the
scope.

---

## 8. Static integrity: dangling references, arity, and whether the module imports cleanly

**ESTABLISHED clean at the source level, with one caveat I could not close.**

- `graph_state.js:47` now requires `{ appendValidMutationOps, applyValidMutations }` from
  `'./validity_mutations'`; `validity_mutations.js:89-92` exports exactly those two names.
  ESTABLISHED, both read at head.
- `applyValidMutations` uses `nodeIdentifierToString` and `compareNodeIdentifier`, both imported
  at `validity_mutations.js:22` from `'./database'`. `nodeIdentifierFromString` (`:79`) likewise.
  ESTABLISHED.
- No import cycle: `validity_mutations.js` requires only `'./database'` and type-only
  `import(...)` typedefs; `graph_state.js` requires `validity_mutations.js`, not the reverse.
  ESTABLISHED.
- Every identifier referenced by the changed code exists: `ValidClearMutation` is exported as a
  typedef from `graph_state.js` and imported as a type by `validity_mutations.js:19`; the new
  `observed` property is declared on the typedef at `graph_state.js:81-85`; the
  `observedReads` map's declared type `Map<string, NodeIdentifier[]>` matches its only two uses
  (`get(k)` → `NodeIdentifier[] | undefined`, matching the typedef's
  `NodeIdentifier[] | undefined`). ESTABLISHED.
- **Module arity:** `applyValidMutations(committed, mutations)` is declared with two `@param`s and
  called with two arguments at both sites (`graph_state.js:290`,
  `validity_mutations.js:80`). `makeValidBatchOps(db, validMutations)` is unchanged in arity and
  is called from `createBatch` (`graph_state.js:305`) as before. ESTABLISHED.
- **Not executed, therefore not established:** the module has never been loaded by a JS runtime
  in this review. There is no `node_modules` in this worktree, so I could not `require` it, and I
  was forbidden from running the build, the typecheck, the linter, or any test chain. So
  "imports cleanly" is established **by source reading only**. ESTABLISHED-as-reading, NOT
  ESTABLISHED-as-execution.
- The front's own static-analysis results (`npx tsc` clean, `npx eslint` clean on the two files,
  26 `import-x/no-unresolved` errors all in `frontend/`) are **RELAYED**. I did not re-run any of
  them. I note that a clean `tsc` on this change is *weak* evidence for it: the new
  `observed` field is a `@property` on a JSDoc typedef, and `applyValidMutations`'s branch on
  `m.observed === undefined` is a narrowing the checker accepts precisely because the property is
  declared optional. A type checker cannot tell you that the optionality encodes a wrong rule.
  That is the whole of F1 as far as the type system is concerned.

---

## 9. What I tried to break, and what held

Things I attacked and that held (ESTABLISHED):

- Could the commit have bent a test to fit? No — item 3, full diff read.
- Could the wholesale semantics promised for `put`/`del`/direct `clear` be broken by the
  rewrite? No — `graph_state.js:293-303` and `:288` all produce `observed: undefined`, and
  `tests/incremental_graph_concurrency.test.js:2347` exercises exactly that path.
- Does the narrowed withdrawal break a caller that relied on wholesale behaviour? No — there is
  exactly one `clear` call site in the codebase (F7).
- Does the observation get captured too late or too early? No — `clearMutation(k)` is evaluated
  inside `clear()`, and `observedReads` is refreshed on every `get`, so the snapshot is the last
  read before the clear. The *window* is the problem (F1), not the snapshotting.
- Does the new code mutate a store-owned array in place? No — I traced every branch of
  `applyValidMutations`: `[]`, `filter`, and `concat` all allocate before the terminal `.sort`,
  and the no-mutations branch returns before sorting. This is a genuine improvement over the base
  (which sorted the storage-returned array in place at `graph_state.js` old `:103`).
- Is the front's transcript premise in item 2 falsifiable? No — item 7, I tried and could not.
- Are the three candidate rejections wrong, leaving a real defect in place? A and B: sound (with a
  reasoning correction, F8). C: sound, and I settled statically what the front could not (F8).

Things I broke: F1 (the surviving edge is a false proof), F2 (the documentation asserts it as an
invariant), F3 (a branch of `get` no longer sorts), F4 (two scopes in one function), F5 (the new
rule has no test).

Things I could not check, and why: item 4 in full (no `node_modules`, no `jest`, no `npx` run);
whether any committed `valid[D]` array is actually unsorted today (F3's observable impact);
whether replay reconstructs `valid` from Journal records (F9's replay half); the bodies of
`tests/incremental_graph_concurrency.test.js:2184` and the whole of
`tests/incremental_graph_validity.test.js` and `tests/incremental_graph_spec.test.js`; and any
runtime execution whatsoever, including a single `require` of the changed module.

**Recommended disposition.** CHANGES-REQUIRED. The minimum bar to clear: revert the
observed-scope rule in `applyValidMutations` (restoring the unconditional clear for a `clear`
produced by `handleChanged`) and record the residual defect — two concurrent re-materialisations
of one node each withdraw the other's frontier — as the named open item, with candidate C
rejected on the settled deadlock ground in F8 and occurrence-scoped withdrawal identified as the
only rule that is both sound and sufficient. Do not spend the next front on a fourth candidate
for the clear's scope; the scope is not the defect. If the observed-scope rule is kept for any
reason, then F1, F2 and F5 are all blocking, and the rule must at minimum be qualified in-code
for computors declared `isDeterministic: false` or `hasSideEffects: true`.

---

Reviewing front: independent review of board 92 front 92d5's `f8121603`.
Wrote nothing under `incremental_graph/` or any other production file. One markdown review commit
on `review/92-concurrency-fix`. No tags, no merges, no pull request, no other refs written.
@ottojung — this one took the telescope apart to see whether the dome would fall down on it.
