# Database fingerprint

$id-6689793911726062
title: Defer database fingerprint entropy changes until owned
date: 2026/09/09
source: @ottojung
kind: constraint

The existing database fingerprint format and generation behavior must not be changed until someone is assigned to GitHub issue [#1606](https://github.com/ottojung/volodyslav/issues/1606), "Increase database fingerprint entropy".

In particular, unrelated work such as Journal 2 must not opportunistically strengthen, lengthen, replace, reinterpret, or otherwise migrate `DatabaseFingerprint`. Until #1606 has an assignee, the current fingerprint behavior remains outside the scope of implementation changes.

Assignment of #1606 is the explicit signal that someone has taken ownership of reconsidering the fingerprint entropy/format design. At that point this intent no longer blocks work on the issue itself; the issue should determine the exact new entropy source, representation, validation, and backwards-compatibility plan.

This constraint deliberately permits the status quo to remain indefinitely if nobody takes ownership of #1606.
