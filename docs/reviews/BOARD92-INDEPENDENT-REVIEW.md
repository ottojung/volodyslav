# Board 92 — INDEPENDENT REVIEW of 4f249032 (record layer, third fix stack)

Reviewed: commit `4f249032515e9e22124193105b41fdf02b32913e`, live tip of `refs/heads/issue/92-journal-record-layer`.
Reviewer front: independent. I did not write any of this code. Worktree `/workspace/volodyslav-92-review-a`, nothing outside it was written, nothing was committed, pushed or merged. No spec file was modified.

---

## VERDICT (read this first)

**Technically correct on the six findings it set out to fix, and its own regressions go red when those fixes are reverted. But it is NOT end-to-end Journal 3, and it carries one real correctness defect plus one documentation claim that is provably false.**

- The six fixes are real. I re-ran each author's mutation myself; all go red, with the counts they claimed.
- **BLOCKER 1 (correctness).** `ComputedValue` discrimination on `type` alone accepts persisted records the specification requires rejecting, and **nothing anywhere in the repository catches them**. See "Question 1".
- **BLOCKER 2 (correctness + false documentation).** `validateCurrentShapeBasis` and `isEligibleCertificate` **diverge on concrete inputs, in both directions**, and the two divergence-causing mutations both leave the whole 143-test journal suite **green**. The module comment at `reference_rules.js:203-204` claims replay "applies it per certificate when it decides which candidate is eligible". That is false, and the divergence is a real bug in the newly exported function. See "Question 2".
- **BLOCKER 3 (scope).** The issue asks for END-TO-END Journal 3. This commit is a record layer plus a replay oracle. Emission, storage/persistence, publication finalization/locking, lifecycle and absent restore, bootstrap, sync, reset, migration integration and the whole documentation cutover (checklist §7–§16a) do not exist in this tree. See "The end-to-end gap".
- "Technically correct but should not land as *end-to-end*" is the honest headline. It may well land as the record-layer milestone it actually is, if the blockers above are recorded.

---

## Question 1 — Does discrimination of `ComputedValue` on `type` alone match the specification?

### Answer: NO. It accepts malformed records, and they are caught nowhere at all. This is the headline finding.

**Where the check lives:** `backend/src/generators/incremental_graph/journal/record_fields.js:83-89` (`isComputedValue`), applied at `backend/src/generators/incremental_graph/journal/records.js:370-374` (the `makeValueEvent` constructor) and, through the constructor, at the persisted-text boundary `backend/src/generators/incremental_graph/journal/codec_read.js:317-330`.

The predicate reads the discriminant and nothing else:

```js
// record_fields.js:83-89
function isComputedValue(value) {
    if (!isPlainRecord(value)) { return false; }
    const tag = value["type"];
    return typeof tag === "string" && COMPUTED_VALUE_TYPE_TAGS.has(tag);
}
```

**What the specification requires.** `docs/specs/incremental-graph-journal-well-formedness.md:38` is the normative owner (README ownership map: "well-formedness, context/reference legality, and **record/basis validity**"). It says, for a `ValueEvent`:

```
- payload is valid current-version `ComputedValue`;
```

`ComputedValue` is a **closed disjoint union** of eighteen object typedefs, each with its own declared member names and member types, at `backend/src/generators/incremental_graph/database/types.js:251-406` (union itself at `:406`, tag set at `:418-437`). `EventsCountEntry` declares `@property {number} count` at `:363-365`. Therefore `{type:"events_count", count:"not a number"}` **is not a valid current-version `ComputedValue`** and the specification requires rejecting it. So is `{type:"events_count", count:3, injected:true}` — `injected` is a member of no union member, which is the same "unknown member" class the commit itself rejects everywhere else in the record body.

**Is it caught anywhere later? No.** I searched the whole tree: `isComputedValue` has exactly three references, all inside the journal folder (`record_fields.js`, `records.js:370`). No graph-scheme boundary, computor, wrapper, `pull`, `typed_database` or `domain_queries` validates the inner members of a `ComputedValue`; the only checks I found on a payload are `x.type !== "..."` tag comparisons (`backend/src/generators/interface/domain_queries.js:219, 265, 240`), which a wrong-inner-shape payload passes. I also checked the author's specific hedge ("whether the graph scheme's own boundary rejects the bad member is a question for that layer and I did not go and check it", report §3). **I went and checked. It does not.** Demonstration, feeding an accepted record's payload straight into the real computor:

```
$ node /tmp/probe4.js
record layer accepted payload: {"type":"all_events","events":"nope"}
computor returned {"type":"events_count","count":4}
```

`"nope".length === 4`. A persisted payload that is not a `ComputedValue` at all is accepted by the record layer, survives the canonical codec, and is then consumed as a real value, producing a *silently wrong number*. That is a persisted-history corruption path, not a type nit.

**Reproduction (all cases, end-to-end: `makeValueEvent` → `encodeJournalRecord` → `currentFormatValidateRecord`):**

```
$ node /tmp/probe1.js
garbage                                REJECTED: ... payload is not a valid current-version computed value
no type                                REJECTED: ... payload is not a valid current-version computed value
declared type, wrong inner type        ACCEPTED end-to-end; persisted payload on disk = {"type":"events_count","count":"not a number"}
declared type, missing inner member    ACCEPTED end-to-end; persisted payload on disk = {"type":"events_count"}
declared type, extra member            ACCEPTED end-to-end; persisted payload on disk = {"type":"events_count","count":3,"injected":true}
ontology whose ontology is a string    ACCEPTED end-to-end; persisted payload on disk = {"type":"ontology","ontology":"a string"}
calories value is an object            ACCEPTED end-to-end; persisted payload on disk = {"type":"calories","value":{}}
config member wrong type               ACCEPTED end-to-end; persisted payload on disk = {"type":"config","config":7}
entry_description not a string         ACCEPTED end-to-end; persisted payload on disk = {"type":"entry_description","description":42}
all_events events not an array         ACCEPTED end-to-end; persisted payload on disk = {"type":"all_events","events":"nope"}
```

**How bad is this relative to the rest of the same commit?** The commit's own stated principle, applied consistently everywhere else in the record body, is "the record's canonical meaning must not depend on the reader":

- `codec_read.js:99-114` rejects *any* node-key text that is merely parseable (whitespace, reordered members, unknown members at both levels, trailing space);
- `codec_read.js:143-168` rejects a context that is not byte-exactly what the encoder would write;
- `codec_read.js:181-197` rejects a textual `physical`, a numeric coordinate, and an unknown `authorityTime` member;
- `codec_read.js:214`, `:245`, `:249`, `:294` reject an unknown member in a basis entry, a scope, and the record body.

The payload is the **single** place where that discipline was dropped, in the same commit, in the same file family. That is a self-inconsistency, not a considered layering decision.

**The author's stated limit is not supportable as written.** The comment at `record_fields.js:68-82` says the inner members "belong to the graph scheme that authored the value" and are "the graph scheme's own contract, not this layer's". But (a) the union and all eighteen member typedefs are defined *in this repository*, in the file the layer already imports the tag set from (`database/types.js:251-437`), and (b) the spec's normative owner for record validity is the well-formedness document, which does not delegate the payload to anybody. I do not think this is the author mis-stating the rule; I think it is a real gap with a plausible-sounding rationalisation attached. **It must be recorded as a blocker, not waved through as "the graph scheme's contract".**

**Related, and the author's report is honest about it but understates it.** Report §4 admits there is no test which fails if a nineteenth variant is added to the union without a tag. I verified the drift is fully uncaught in **both** directions:

```
# add a tag with no union member behind it
'  a_nineteenth_variant_with_no_typedef_member_check',   ->  143 passed / 143 total, EXIT=0
# remove a real tag from the set ('calories')
                                                     ->   44 passed / 44 total, EXIT=0
```

Removing a genuine union member's tag from the set makes the record layer reject a valid `ComputedValue` and no test notices. That is the same false-gate problem as Blocker 2.

---

## Question 2 — Does `validateCurrentShapeBasis` belong in replay eligibility, or is it already covered by `isEligibleCertificate`?

### Answer: they **diverge**, concretely, in both directions. "Already covered" is false. And no test in the suite can tell the difference.

- `validateCurrentShapeBasis`: `backend/src/generators/incremental_graph/journal/reference_rules.js:209-233`
- `isEligibleCertificate`: `backend/src/generators/incremental_graph/journal/oracle/certificates.js:161-188` (current-input block at `:170-182`)
- Spec: `docs/specs/incremental-graph-journal-replay.md:205-212` (§ current-shape-compatible) and `:237-249` (§ eligible certificate)

`validateCurrentShapeBasis` is exported (`journal/index.js:145`, `:246`) and has **no production caller at all** — the only reference in the tree outside its own module is one test (`journal_record_layer_regressions.test.js:461`).

### Divergence A — baseline-reason certificates with a retired input set

`validateCurrentShapeBasis` returns `undefined` (accept) for `bootstrap` / `reset` / `migration` **before it ever looks at the input set** (`reference_rules.js:211-213`). `isEligibleCertificate` has no such exemption: it applies the input-set equality to every reason (`certificates.js:170-182`). Concrete input, same replica, same schema, one certificate:

```
$ node /tmp/probe7.js
reason=compute          basis=9   currentShape: REJECT  eligible: false  whole-history: accepted
reason=unchanged        basis=9   currentShape: REJECT  eligible: false  whole-history: accepted
reason=cache-revalidate basis=9   currentShape: REJECT  eligible: false  whole-history: accepted
reason=bootstrap        basis=9   currentShape: ACCEPT  eligible: false  whole-history: accepted
reason=reset            basis=9   currentShape: ACCEPT  eligible: false  whole-history: accepted
reason=migration        basis=9   currentShape: ACCEPT  eligible: false  whole-history: accepted
```

(schema says `K`'s only current input is `D{id:2}`; every certificate names `D{id:9}`.)

**Which side is right?** `isEligibleCertificate`. The replay spec defines current-shape-compatible with no reason exemption (`replay.md:205-212`: "A validation is current-shape-compatible iff `certificateInputs(C) == currentInputs(K)`"), and `eligibleCertificate` is defined as `C in Validations(K) and current-shape-compatible(C,K) and not uncoveredNodeInvalidation(K,C)` (`replay.md:242-245`). The well-formedness spec's reason carve-out is only about `"unknown"` basis entries (`well-formedness.md`, validation basis rules item 6), which is a different rule and is correctly still enforced by `validateOrdinaryBasisReasons`.

So the split was done wrong: when `validateOrdinaryBasis` was divided, the `isBaselineValidationReason` early return — which belongs to the **reason rule** — was carried into **both** halves, and in `validateCurrentShapeBasis` it makes the current-shape predicate weaker than the specification's.

**Consequence.** This is a latent bug, not a theoretical one. The author states the new export exists "for replay eligibility and for the authoring transition which writes a new certificate" (report §3, Finding 3). As it stands, an authoring transition which calls it would be told a `reset`/`bootstrap`/`migration` certificate naming a retired input set is fine to write — and replay would then never select that certificate, so the node would sit permanently un-fresh with no error anywhere. If replay is later rewired to call this export (which is the stated plan), replay becomes **more permissive than the specification**, admitting stale-shape baseline certificates as current proof. That is the exact defect the review that produced finding 3 was about, reintroduced through the fix.

### Divergence B — a node family the current schema has removed

`validateCurrentShapeBasis` rejects with "node ... is not part of the current schema" when the schema accessor returns `undefined` (`reference_rules.js:215-221`). `isEligibleCertificate` deliberately maps `undefined` to the **empty** current-input set (`certificates.js:104-107`), so a zero-basis certificate on a removed family passes the current-shape check, and its own comment at `certificates.js:95-99` says that is intentional. Concrete input:

```
$ node /tmp/probe6.js
compute     currentShape: ok  eligible: true
bootstrap   currentShape: ok  eligible: true
reset       currentShape: ok  eligible: true
migration   currentShape: ok  eligible: true
removed+empty currentShape: err  eligible: true
zero-input  currentShape: ok  eligible: true
```

And end to end through the projection (`/tmp/probe8.js`): a retained value + zero-basis certificate for a node the current schema has removed is accepted by whole-history validation, is selected as an **eligible** certificate, and is projected as `fresh: true`, `selfProofReadyNodes: 1`, `occurrences: 1`. Whether replay *should* project a removed family at all is a separate design question I am not adjudicating here; what is in scope is that the two current-shape predicates give opposite verdicts on the same input.

**Which side is right?** `isEligibleCertificate` again, on the letter of `replay.md:205-212` (`currentInputs(K) = set(currentInputEdges(K))`, which is empty for a node the schema does not contain). `validateCurrentShapeBasis` adds a schema-membership rule that the replay spec does not put into current-shape compatibility. Note this is a *second* rule the split moved across the boundary.

### The mutation the brief asked for: is the divergence observable by the suite? No.

Both divergence-causing mutations leave the suite **fully green**:

```
# Mutation 1: make isEligibleCertificate skip the current-shape check for baseline reasons
    (add the isBaselineValidationReason exemption to certificates.js:161)
  -> 4 suites passed, 143 passed / 143 total, EXIT=0

# Mutation 2: make isEligibleCertificate reject a node the current schema does not contain
    (add `if (currentInputKeysOfNode(nodeKeyString) === undefined) return false;` to certificates.js:161)
  -> 4 suites passed, 143 passed / 143 total, EXIT=0

# Mutation 3 (the decisive one): DELETE isEligibleCertificate's own current-shape block
    (certificates.js:170-182) and replace it with a call to validateCurrentShapeBasis
  -> 4 suites passed, 143 passed / 143 total, EXIT=0
```

Mutation 3 is the sharpest statement of the problem: **swapping one implementation of the rule for the other — a real semantic change, since they disagree — changes nothing the suite can see.** A reviewer who wires replay to the new export would get a green run.

```
# And the divergence is invisible from the other side too: delete the baseline-reason
# early return from validateCurrentShapeBasis (reference_rules.js:211-213)
  -> 4 suites passed, 143 passed / 143 total, EXIT=0
```

So: `validateCurrentShapeBasis` does **not** belong in replay eligibility as it currently stands, `isEligibleCertificate` does **not** already cover it, and the author's own hedge ("I did not check whether the two agree on every input") is exactly right — the answer is that they do not, and it was checkable in ten minutes.

**Recommended direction (not applied — I changed no source):** make `isEligibleCertificate` call the exported rule, after fixing the exported rule to drop the baseline-reason early return and to treat a node absent from the current schema as having no current inputs, so that the two become one function. Then Mutation 3 above stops being behaviour-neutral and the suite has something to hold.

---

## The end-to-end gap — the finding this issue most needs

The issue title is "implement Journal 3 replay-log journal **end-to-end**". What is in this tree is checklist items 1, 2 and 6 (record vocabulary, causal/reference validation, a reference replay oracle), plus the *documented* framing of the rest. Concretely absent, verified by reading the tree, not inferred:

- **No emission.** `incremental_graph/journal/` contains only: `basis, codec, codec_read, context_closure, errors, immutable, index, oracle, ordering, record_fields, records, reference_rules, replica, types, well_formedness`. There is no emission module (checklist §5).
- **No persistence / no `global/version` selector / no ordered per-writer range iteration on disk** (checklist §1, §15 in the storage spec). The codec encodes a single record to text; nothing writes or reads a journal.
- **No `JournalSnapshot`** (checklist §3).
- **No publication finalization / locking / atomic graph+Journal cutover** (checklist §4, the locking spec).
- **No lifecycle, absent-installation restore, bootstrap, sync, reset or migration integration** (checklist §7–§12).
- **No caller.** `grep -rl "incremental_graph/journal"` outside the journal folder returns **nothing** in `backend/src` or `frontend/src`. The record layer and the oracle are dead code from the application's point of view; nothing in the product routes through them.
- **No documentation cutover** (checklist §16a) — `docs/incremental-graph-synchronization.md`, `docs/database-lifecycle.md`, `docs/database-boot-sequence.md`, `docs/release-safety.md` and the temporary target-design banners are all still in place.

That is not a criticism of this commit; it is a criticism of the **issue's framing as currently shaped**, and it is the single most important thing the orchestrator needs to record. "Six review findings fixed" and "Journal 3 end-to-end" are separated by roughly the entire checklist. The end-to-end completion condition (`persistedGraph == project(retainedJournal)` across ordinary operations, startup/absent restore, bootstrap/migration, sync, reset, restart/open and rebuild) is not reachable from this commit, and the layer it does provide is not yet wired to anything that could reach it.

---

## The other required checks

### `currentInputsOfK` at head — the fix is real and complete

`backend/tests/journal_record_layer_regressions.test.js:305-318` at `4f249032`:

```js
function currentInputsOfK(nodeKeyString) {
    if (nodeKeyString !== nodeKeyToCanonicalString(NODE_K)) {
        return undefined;
    }
    return [nodeKeyToCanonicalString(NODE_D));
}
```

It uses its argument, and it returns `undefined` for a node the schema does not mention — which is what makes the removed-family case distinguishable from the changed-input-set case. **The fix is real.** I also audited the other schema accessors in the journal tests for the same class of defect and found none: `backend/tests/interleaving_space.js:98-106` and `backend/tests/journal_project_oracle.test.js:89-102` both branch on the argument. I confirmed the fix is load-bearing: restoring the schema argument to whole-history validation makes the removed-family test red (see mutation below), which it did not before `31203b4a`.

### `4f249032` — naming only, no behaviour change

`git show 4f249032 --stat` touches exactly one file, `backend/tests/journal_record_layer_regressions.test.js` (+34/−6). No file under `backend/src` is in the diff. The renamed test now exercises `makeJournalFrontier` with two keys for one writer and asserts the rejection is a `JournalRecordValidationError`, plus a new test asserting the duplicate-writer rejection arrives as a Journal error rather than a thrown `Error`. **No behaviour changed, and no throw was converted into a silent path.** The `replicaFrontier` throw at `replica.js:278-280` is still there and still throws.

`332a8507` likewise touches only the test file (+5).

One observation, not a defect: `replicaFrontier` is declared `@returns {JournalFrontier}` and throws a plain `Error` on the unreachable path (`replica.js:266-282`). The comment now states it is a defect report for the module's own literals and is unreachable from a `JournalReplica` because `makeJournalReplica` rejects the duplicate (`replica.js:141-146`). Having verified the constructor does reject duplicates by writer name, and that `get`/`has`/`streamOf` all resolve by name, I accept that claim. The throw is dead but harmless, and it is a real `Error`-out-of-a-validator shape that a future change could revive. I would rather see it return an error value; I am not calling it a blocker.

### `joinReplicaRecords` change is correct and in scope

`well_formedness.js:150-195` now keys the author union by name (`Map<string, JournalAuthor>` at `:157-166`) rather than by object identity. This is the same defect at the same boundary as finding 6, it surfaced as a real failing existing test, and fixing it rather than routing around it was the right call. Verified by reading; the `makeJournalReplica` result it returns enforces the new invariant.

---

## Three-way classification of the author's "did not" list (report §5–§10 in the brief's numbering; the report numbers them 1–10)

| # | Item | Class | Why |
|---|---|---|---|
| 1 | Did not re-verify the review's line numbers | **(a) out of scope** | Line numbers move when code moves. Nothing to fix. |
| 2 | NodeKey sub-item reproduced in a different form than the brief worded it | **(a) out of scope** | The class of defect was covered; wording of a review is not a deliverable. |
| 3 | Did not deep-validate `ComputedValue` members | **(c) should have done, and did not** | This is my Blocker 1. The spec's normative owner requires "payload is valid current-version `ComputedValue`"; a closed union's members are in this repo; nothing downstream validates them; a real computor consumes a bad payload and returns a wrong number. Must be fixed (or the spec-owner question escalated to the orchestrator) before this can be called end-to-end. |
| 4 | No test fails if a nineteenth variant is added without a tag | **(c) should have done, and did not** | Verified worse than stated: drift in *both* directions is uncaught, including **deleting a real variant's tag**, which makes the layer reject a valid value with a green suite. Cheap to fix (a test that enumerates the union's tags and the set against each other, plus per-tag shape assertions). |
| 5 | Did not implement/verify the current-shape check's consumption in replay eligibility | **(b) real gap, and the author's framing of it is wrong** | This is my Blocker 2. Not only was the agreement not checked — the two **do not agree**, and the module comment asserting that replay applies this rule is false. Must be resolved before the rule is consumed anywhere. |
| 6 | No `A:1..A:n` composition test past twelve records | **(c) should have done, and did not — but it is cheap and I ran it** | I built and validated a 150-record single-writer stream: `accepted`. So the composition is fine; what is missing is the test. Recommend adding it — it is the composition that finding 1 was about, and the current coverage stops at exactly the width where the old digit-local bug was invisible. |
| 7 | No concurrency or fuzz harness on the journal suites | **(a) out of scope for this commit** | The interleaving suite is an exhaustive bounded argument; extending its bounds is a separate piece of work. Recorded as a known limit, not a blocker. |
| 8 | No line-by-line conformance audit of the whole record layer against the whole spec set | **(a) out of scope, with a caveat** | Fair for a six-finding fix stack. The caveat: two of the three blockers above are exactly the kind of gap only a conformance pass finds, so this limit is load-bearing for the "end-to-end" claim. |
| 9 | Did not push/merge/touch other worktrees | **(a) verified** | `git diff --name-only a0d37f15 4f249032` shows 19 files, **0 under `docs/specs`**. No spec was edited, weakened or reinterpreted. The strict rule was honoured. |
| 10 | Did not run `npm run build` | **(a) out of scope** | No frontend or docs source touched; backend has no build step. I ran `npm run static-analysis` (exit 0) and the full `npx jest` (exit 0) instead, which are the gates that matter for this change. |

Summary: **1 out-of-scope-but-verified, 4 genuinely out of scope, 3 (a) — and 2 that are (c) the author should have done, plus 1 that is (b) a real blocker.** Plus the separate end-to-end gap above, which is not on the author's list at all because it is not this commit's job — and is precisely why this commit cannot close issue 92.

---

## Tests I ran, with real output and real exit codes

Environment gate: `/sys/fs/cgroup/memory.stat` `anon` line was 5.47–6.42 GB throughout (cap 30 GiB), so I ran the **full** suite rather than a narrow one. `memory.current` was not used, per the brief.

```
$ npm install
  (succeeded; only the repository's own install warnings about esbuild/protobufjs/unrs-resolver postinstall)

$ npx jest backend/tests/journal_well_formedness.test.js backend/tests/journal_project_oracle.test.js \
             backend/tests/journal_interleaving.test.js backend/tests/journal_record_layer_regressions.test.js
  Test Suites: 4 passed, 4 total
  Tests:       143 passed, 143 total
  Time:        18.501 s
  EXIT=0

$ npx jest --silent -w 2            # whole repo, both projects
  Test Suites: 251 passed, 251 total
  Tests:       3218 passed, 3218 total
  Time:        102.062 s
  EXIT=0
  (stdout contained unrelated pre-existing log noise from backend/src/notifications.js about
   `termux-notification` being unavailable on this host; it did not fail anything)

$ npm run static-analysis           # tsc && eslint . --max-warnings 0
  no output
  EXIT=0
```

Per-suite counts at `4f249032` match the author's table exactly: `journal_well_formedness` 51, `journal_project_oracle` 28, `journal_interleaving` 20, `journal_record_layer_regressions` 44.

### Mutations — what went red, with real output

**M1. Revert finding 4's payload fix** — `isComputedValue` returns `true` for any plain object (`record_fields.js:88`):

```
  ● finding 4: the current-format boundary rejects what it does not define
    › an arbitrary object is not a current-version ComputedValue
    expect(received).toBe(expected)
    Expected: true
    Received: false
      at tests/journal_record_layer_regressions.test.js:497:83
  Test Suites: 1 failed, 1 passed, 2 total
  Tests:       1 failed, 94 passed, 95 total
  EXIT=1
```

**M2. Revert finding 3's split** — restore the schema argument to `validateJournalReplica` and the current-shape check to `validateRecordReferences`:

```
  ● finding 3 › whole-history validation does not take a current schema at all
    expect(validateJournalReplica.length).toBe(1)   Expected: 1  Received: 2
  ● finding 3 › whole-history validation accepts a certificate on a node family
    the current schema has removed
    Received: [JournalRecordValidationError: Invalid Journal record (aaaaaaaaa:3):
      node {"head":"retiredHead","args":[{"id":7}]} is not part of the current schema]
  Test Suites: 1 failed, 1 passed, 2 total
  Tests:       2 failed, 93 passed, 95 total
  EXIT=1
```

Both halves red — which independently confirms that the `currentInputsOfK` fixture fix in `31203b4a` is load-bearing and complete.

All mutations were reverted; `git status --short` is clean and `git diff --stat` is empty at the time of writing.

### The three mutations that did NOT go red (the false-gate evidence)

```
M3. isEligibleCertificate: skip the current-shape check for baseline reasons
    -> Test Suites: 4 passed / Tests: 143 passed / EXIT=0
M4. isEligibleCertificate: reject a node the current schema does not contain
    -> Test Suites: 4 passed / Tests: 143 passed / EXIT=0
M5. isEligibleCertificate: delete its current-shape block, call validateCurrentShapeBasis instead
    -> Test Suites: 4 passed / Tests: 143 passed / EXIT=0
M6. validateCurrentShapeBasis: delete the baseline-reason early return
    -> Test Suites: 4 passed / Tests: 143 passed / EXIT=0
M7. COMPUTED_VALUE_TYPE_TAGS: add a tag with no union member behind it
    -> Test Suites: 4 passed / Tests: 143 passed / EXIT=0
M8. COMPUTED_VALUE_TYPE_TAGS: remove a real tag ('calories')
    -> Test Suites: 1 passed / Tests: 44 passed / EXIT=0
```

**These are the serious result of this review.** The suite is a real gate for the six fixes it was written against (M1, M2 are decisive), and it is a **false gate** at exactly the three seams the author promoted rather than resolved: the payload's inner shape, the current-shape/eligibility agreement, and the tag-set/union correspondence. M5 is the sharpest: a genuine semantic change to the replay eligibility rule, in a direction the specification does not sanction, is invisible to all 143 journal tests.

These are **not** tolerance-loosening mutations. None of them touches a timing threshold, a tolerance, or a `toBeCloseTo`. M5 in particular removes a real check and substitutes a differently-behaving one; the tests it fails to notice are the whole point. To be explicit about the distinction the brief asked for: M1 and M2 remove genuinely load-bearing assertions and go red correctly; M3–M8 remove or alter real behaviour and go green incorrectly.

---

## Blunt statement of what I could not verify

- **I could not establish what the "right" payload validation is.** I can prove the current behaviour accepts records `well-formedness.md:38` requires rejecting, and I can prove nothing downstream catches them. Whether the fix is eighteen per-variant shape predicates, a scheme-supplied validator, or a scope decision recorded elsewhere is a design call for the author and the orchestrator, and I did not make it. I did not modify the spec.
- **I did not decide whether replay should project a node family the current schema has removed** (Divergence B). I proved the two predicates disagree and showed what the projection currently does with it; the specification answer requires reading `replay.md` §Freshness and §Lowering against a removed family, which I did not complete.
- **I did not run the whole conformance audit** the author also did not run. My three blockers were found by targeted probing of the seams the brief named, not by an exhaustive spec-to-code sweep. **There may be more of the same class that I did not look for**, and given that the two places I did look both produced blockers, I would not treat "three findings" as an upper bound.
- **I did not audit the whole `e1813a72` diff line by line.** I read the journal folder's `basis, codec, codec_read, immutable, record_fields, records, reference_rules, replica, types, well_formedness` and the oracle's `certificates, heads, invalidations, project, projection, record_source`, and the two type files it touched. `context_closure.js`, `ordering.js`, `scan.js` and the error taxonomy in `errors.js` I read only where a finding led me there.
- **I did not verify the author's mutation evidence for findings 1, 2, 5 and 6** beyond re-running my own M1/M2 and reading the code. Their reported red counts for those four I did not reproduce independently.
- **I could not check whether the divergence in Question 2 was already known to the author.** The report's §5 hedge is the only evidence, and the module comment at `reference_rules.js:203-204` states the opposite of what I found.
- **I did not attempt a build.** `npm run build` builds the frontend workspace, which this commit does not touch; the author declined it for the same reason. I ran `npm run static-analysis` and the full suite instead, both exit 0.

---

## Bottom line for the orchestrator

The fix work is honest, well-reasoned, and its own regressions are real. Land it as the record-layer milestone it is. Do **not** treat issue 92 as end-to-end, and do not let the following three items disappear:

1. `ComputedValue` inner shape is unvalidated and uncatchable downstream, against `well-formedness.md:38`. Demonstrated end-to-end, including a real computor consuming a bad payload and returning a wrong number.
2. `validateCurrentShapeBasis` and `isEligibleCertificate` disagree in both directions, and `reference_rules.js:203-204` documents the disagreement away. The suite cannot detect either, including a straight swap of one for the other.
3. The tag set and the union can drift in both directions with a green suite, including losing a real variant.

And the framing point, which is larger than all three: the tree contains a record layer and a reference oracle and nothing else. Checklist §1/§2/§6 are in; §3, §4, §5, §7–§12, §15 and the §16a documentation cutover are not. The layer has no caller outside its own folder. Until the issue is re-scoped or the remaining milestones are scheduled, "end-to-end" is a claim this repository does not support.

---

## Progress record (2026-10-08)

All three blockers from the original review have been resolved, and the implementation has been carried through the full checklist. Current state on `land/92-gate-repair-onto-release`:

### Blocker resolutions

1. **ComputedValue inner shape** — `isComputedValue` in `record_fields.js:85-87` now delegates to `computedValueViolation`, which validates every union member's declared members and types. The payload is no longer accepted on tag alone.

2. **Current-shape/eligibility divergence** — `validateCurrentShapeBasis` in `reference_rules.js:218-233` now applies the same rule as `isEligibleCertificate`: no baseline-reason exemption, and a node absent from the current schema has an empty current-input set. The module comment at `reference_rules.js:203-204` now states that `isEligibleCertificate` is the one consumer and the two are the same predicate.

3. **Tag-set/union drift** — `journal_record_layer_regressions.test.js` now enumerates the union's tags and asserts the set matches in both directions.

### End-to-end completion

The implementation now covers the full checklist:

- **Emission** (`journal/emission.js`, `graph_state.js`): graph operations stage journal intents, finalize them under the darkroom lock, and write them atomically with graph mutations.
- **Persistence** (`journal_store/`): durable record store with one file per record, ordered per-writer range iteration, canonical codec.
- **Publication** (`journal_publish/`): atomic graph+journal cutover for sync and reset, with the projection lowered into existing graph sublevels.
- **Lifecycle** (`journal_bootstrap_gate.js`, `journal_bootstrap_startup.js`, `journal_bootstrap_install.js`): routine open, absent restore, canonical bootstrap gate.
- **Bootstrap** (`journal/bootstrap/`): canonical artifact creation, creator resume, join, cohort arbitration.
- **Synchronization** (`journal_sync/`): suffix import, normalization, convergence, hostname-free staging.
- **Reset** (`journal_reset/`): three-pass controlled rebaseline with proof barriers and freshness markers.
- **Migration** (`migration_journal.js`, `migration_runner.js`): journal-aware migration with codec-based rewrite.
- **Documentation cutover** (checklist §16a): `database-lifecycle.md` folded into the canonical lifecycle spec, `incremental-graph-synchronization.md` rewritten for Journal 3, `database-boot-sequence.md` updated, `release-safety.md` rewritten for forward-only recovery.

### Verification

- Full test suite: 3666 tests pass (285 suites)
- Static analysis: `tsc && eslint` clean
- Build: `npm run build` succeeds
- The oracle (`projectRetainedJournal`) is used in production by `migration_verification.js`, `creator_resume.js`, and `join_bootstrap.js`
- The end-to-end path `graph update -> journal record -> replay -> graph state` is verified by `journal_emission_end_to_end.test.js`, `journal_production_wiring.test.js`, `journal_sync_convergence.test.js`, and `journal_reset_target_equivalence.test.js`

### Remaining work

No code gaps remain. The implementation satisfies the completion condition: `persistedGraph == project(retainedJournal)` across ordinary operations, startup/absent restore, bootstrap/migration, synchronization, reset, restart/open, and rebuild.

### Independent verification (2026-10-08, workspace `volodyslav-92-accept3` at `4eb3a43d`)

Re-verified the completion claims against the tree at `land/92-gate-repair-onto-release` (`4eb3a43d`), independently of the implementation's own report:

- **Gates**: `npm run static-analysis` (tsc + eslint) clean; full Jest suite 286 suites / 3669 tests pass; `npm run build` succeeds.
- **Blocker 1**: `isComputedValue` (`journal/record_fields.js:85-87`) delegates to `computedValueViolation` (`database/computed_value.js:310`), which validates every union member's declared members and types. Pinned by `journal_blocker1_2_regressions.test.js` (18 canonical payloads, both drift directions, 14 malformed-payload cases).
- **Blocker 2**: `validateCurrentShapeBasis` (`journal/reference_rules.js:218-233`) applies the same rule as `isEligibleCertificate` — no baseline-reason exemption, removed node family maps to empty current-input set. Pinned by a cross-product agreement test over 3 schemas x 2 subjects x 4 bases x 6 reasons.
- **Blocker 3**: tag-set/union correspondence pinned in both directions (`journal_blocker1_2_regressions.test.js:289-297`).
- **Checklist spot-checks**: §9 hostname-keyed staging deleted (`hostname_storage.js` gone, `sync_staging` sublevel in place); §12 legacy `override` surface deleted (no `OverrideDecision`/`OverrideConflictError` in `backend/src`); §13 routine-open O(1+G) bound pinned by `journal_routine_open_history_independence.test.js`; §16a documentation cutover complete (`database-lifecycle.md` folded into specs, `incremental-graph-synchronization.md` removed, `release-safety.md` forward-only, `database-boot-sequence.md` and `migration_testing.md` follow the Journal 3 lifecycle gate); review item 6 addressed (`journal_well_formedness.test.js:722`, 150-record single-writer stream).
- **Blockers**: none found.
