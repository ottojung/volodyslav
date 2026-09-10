# Database fingerprint

$id-9051842763146802
title: Database fingerprints are sufficiently collision-resistant
date: 2026/09/09
source: @ottojung
kind: accepted-tradeoff

`DatabaseFingerprint` is treated as sufficiently collision-resistant for use wherever the database design requires independently-created hosts to have distinct fingerprints.

The design may rely on accidental fingerprint collision being negligibly unlikely. It does not require a stronger entropy source, a longer fingerprint, a separate writer identity, migration of existing fingerprints, or stricter fingerprint validation solely to strengthen collision resistance.

This is an explicit accepted collision-risk tradeoff rather than a proof that collisions are impossible. If distinct continuing histories are actually observed with the same fingerprint, the state is unsupported and must be rejected rather than reconciled as one identity.

GitHub issue [#1606](https://github.com/ottojung/volodyslav/issues/1606), "Increase database fingerprint entropy", records a possible future change to this tradeoff. The existence of that issue does not weaken this intent.

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
