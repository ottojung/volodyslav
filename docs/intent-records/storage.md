# Persisted format lifecycle

$id-6029400544354023
title: Exactly one supported live persisted format
date: 2026/10/04
source: @ottojung
kind: requirement

Volodyslav supports exactly one live persisted database format at a time: the format of the current default branch.

Ordinary runtime code must not accept, decode, preserve, merge, replay, synchronize, or otherwise treat historical persisted database formats as valid alternative inputs. A historical database or historical-format value reaching ordinary runtime is a correctness bug, not a backwards-compatibility case.

When the persisted format changes, compatibility is provided by an explicitly scoped one-way migration, not by making the runtime understand multiple formats. Migration code may read the immediately preceding deployed format only for the purpose of transforming it into the current format before ordinary runtime begins. Historical representations must remain confined to that migration boundary and must not leak into current-domain types, validators, journal records, synchronization, or other permanent runtime code.

Do not build permanent decoder ladders, unions of historical storage formats, alternate historical identifier forms, or runtime fallbacks for old database versions. Temporary migration or cutover machinery should be removed once it is no longer needed for the coordinated transition.

---

$id-0838075076046245
title: Journal 3 initializes from current master only
date: 2026/10/04
source: @ottojung
kind: requirement

Journal 3 targets the current master database format and must initialize only from that format. Its initialization/cutover is not a compatibility layer for arbitrary older Volodyslav databases.

At the Journal 3 cutover, persisted values such as NodeIdentifier already satisfy the single current master representation. Journal 3 must not broaden its domain to accept obsolete pre-master identifier formats or other historical persisted representations.

The Journal 3 initialization/bootstrap path is temporary transition machinery. Once the coordinated deployment no longer needs a pre-Journal-to-Journal cutover, that machinery should be deleted rather than retained as historical compatibility support.
