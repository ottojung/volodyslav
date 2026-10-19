# Date and time abstractions

$id-2720820428831416
title: DateTime must not assume UTC
date: 2026/10/19
source: @ottojung
kind: requirement

The `backend/src/datetime` module MUST NOT assume that an arbitrary date-time
value is in UTC. The module must preserve the distinction between an instant,
its represented zone/offset, and any caller-requested conversion rather than
silently normalizing date-times to UTC or asserting that UTC is the only
possible zone.

In particular, generic serialization such as `DateTime.toISOString()` must
not force a value into UTC. Callers that need UTC must request UTC conversion
explicitly at the appropriate boundary. Do not change the shared `DateTime`
representation/behavior incidentally as part of Journal 3 or another feature.
The Journal 3 changes to `backend/src/datetime/structure.js` are outside
scope and must be reverted to the `master` behavior.
