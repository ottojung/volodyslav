# Persisted format lifecycle

$id-6029400544354023
title: Exactly one supported live persisted format
date: 2026/10/04
source: @ottojung
kind: requirement

Volodyslav supports exactly one live persisted database format at a time: the format of the current default branch.

Ordinary runtime code must not accept, decode, preserve, or otherwise treat historical persisted database formats as valid alternative inputs. A historical database or historical-format value reaching ordinary runtime is a serious correctness bug, not a backwards-compatibility case.

When the persisted format changes, the transition must happen through an explicitly scoped one-way migration, not by making ordinary runtime understand multiple formats. Migration code may read the immediately preceding deployed format only for the purpose of transforming it into the current format before ordinary runtime begins.

Historical representations must remain confined to the migration boundary. They must not leak into current-domain types, validators, APIs, persisted outputs, or permanent runtime code.

Do not build permanent decoder ladders, unions of historical storage formats, alternate historical representations, or runtime fallbacks for old database versions. Transitional migration machinery should be removed once it is no longer needed for the coordinated transition.


---

$id-7139531086125123
title: Persisted database key lengths are bounded independently of NodeKey size
date: 2026/10/19
source: @ottojung
kind: requirement

Every persisted database key MUST have length O(H). No persisted database key
may contain a `NodeKey` (including its canonical serialization), regardless of
the size of that node key. This applies to all sublevels and intermediate
persisted staging/state namespaces, not only the new Journal sublevel.

Here H is the retained-history-size parameter already used by the Journal 3
complexity model (with constant metadata overhead at empty history). The length
of a user-supplied or schema-derived NodeKey must not determine the length of
any physical database key. NodeKeys may still appear as values/payloads or in
in-memory lookup structures; the prohibition concerns persisted *keys*.

Indexes that need to address a semantic node must use compact bounded
identities with sound lookup/collision handling instead. Journal 3 must not
introduce `journal/occurrence|<canonical node key>` entries, or any equivalent
NodeKey-containing physical keys.
