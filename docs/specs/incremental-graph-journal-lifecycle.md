---
title: Journal 3 Lifecycle
---

# Journal 3 Database Lifecycle

This file is a routing table, not a specification. The Journal 3 lifecycle is specified by
[`database-lifecycle.md`](./database-lifecycle.md) Part II, which is the single canonical
lifecycle document for Volodyslav's synchronized incremental database under Journal 3.

Section numbers are preserved here because production source and tests cite this file's
section numbers directly, for example
`backend/src/generators/incremental_graph/journal_bootstrap_gate.js` cites "§8.1" and "§8.2" and
`backend/src/generators/interface/lifecycle.js` cites "§8.2". Each row below names the section
that now owns the rule.

| section here | subject | owner |
| --- | --- | --- |
| §1 | overview and the central law | `database-lifecycle.md` §16 |
| §2 | lifecycle states and transitions | `database-lifecycle.md` §17 |
| §3 | startup flow | `database-lifecycle.md` §18 |
| §4 | absent-state decision, including §4.1 the recovery-source query, §4.2 receiver-less restore, and §4.3 fresh creation | `database-lifecycle.md` §19, §19.1, §19.2, §19.3, and the implementation gap in §19.4 |
| §5 | existing local state never uses rollback recovery | `database-lifecycle.md` §20 |
| §6 | opening current Journal state | `database-lifecycle.md` §21 |
| §7 | ordinary evolution | `database-lifecycle.md` §22 |
| §8 | migration and bootstrap gate, including §8.1 the gate decision, §8.2 pre-Journal multi-host bootstrap, §8.3 Journal-aware migration | `database-lifecycle.md` §23, §23.1, §23.2, and §23.6 |
| §9 | synchronization | `database-lifecycle.md` §24 |
| §10 | controlled reset | `database-lifecycle.md` §25 |
| §11 | projection rebuild | `database-lifecycle.md` §26 |
| §12 | user and API expectations | `database-lifecycle.md` §27 |
| §13 | trust and storage-fault model | `database-lifecycle.md` §28 |
| §14 | unsupported operations and states | `database-lifecycle.md` §29 |
| §15 | corruption versus incompatibility | `database-lifecycle.md` §30 |

Two sections gained content in the fold and are cited by source code that predates it:

- **§8.2** is split across `database-lifecycle.md` §23.2 (arbitration consequences), §23.3
  (the gate, its four outcomes, and fail-closed behavior), §23.4 (creator resume), and §23.5
  (join).
- **§6/§7 creator resume and join** are cited by
  `backend/src/generators/incremental_graph/journal_bootstrap_startup.js`; they are §23.4 and
  §23.5 respectively.

The `resetToHostname` bootstrap steps that older revisions of this document described for a
completely absent local database are now documented, together with the
`InstallationRecoverySource` requirement they must eventually be replaced by, in
[`docs/database-boot-sequence.md`](../database-boot-sequence.md) §7.1 and §7.1.1.
