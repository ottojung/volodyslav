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
