# Database fingerprint

$id-9051842763146802
title: Current database fingerprints are sufficiently collision-resistant
 date: 2026/09/09
source: @ottojung
kind: accepted-tradeoff

For the current supported Volodyslav deployment scale, the existing `DatabaseFingerprint` generation and format are treated as sufficiently random that accidental collisions between independently-created hosts are negligibly unlikely.

Journal 2 may therefore use the existing `DatabaseFingerprint` directly as its durable `JournalAuthor`. Journal 2 does not require stronger entropy, a longer fingerprint, a separate writer identity, migration of existing fingerprints, or stricter fingerprint validation merely to use the fingerprint as a journal-author namespace.

This is an explicit accepted collision-risk tradeoff rather than a proof that collisions are impossible. If distinct continuing writer histories are actually observed with the same fingerprint, the state is unsupported and must be rejected rather than reconciled as one writer history.

GitHub issue [#1606](https://github.com/ottojung/volodyslav/issues/1606), "Increase database fingerprint entropy", records a possible future strengthening of this tradeoff. That issue is not a prerequisite for Journal 2.

---

$id-6689793911726062
title: Defer database fingerprint entropy changes until owned
date: 2026/09/09
source: @ottojung
kind: constraint

The existing database fingerprint format and generation behavior must not be changed until someone is assigned to GitHub issue [#1606](https://github.com/ottojung/volodyslav/issues/1606), "Increase database fingerprint entropy".

In particular, unrelated work such as Journal 2 must not opportunistically strengthen, lengthen, replace, reinterpret, or otherwise migrate `DatabaseFingerprint`. Until #1606 has an assignee, the current fingerprint behavior remains outside the scope of implementation changes.

Assignment of #1606 is the explicit signal that someone has taken ownership of reconsidering the fingerprint entropy/format design. At that point this intent no longer blocks work on the issue itself; the issue should determine the exact new entropy source, representation, validation, and backwards-compatibility plan.

This constraint deliberately permits the status quo to remain indefinitely if nobody takes ownership of #1606.
