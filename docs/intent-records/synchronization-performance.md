# Synchronization performance

$id-3572255392439745
title: Treat linear-time synchronization as optimal until owned
date: 2026/09/10
source: @ottojung
kind: accepted-tradeoff

Until someone is assigned to GitHub issue [#1607](https://github.com/ottojung/volodyslav/issues/1607), "Make incremental synchronization cost depend on changes, not graph size", `O(N)` synchronization time in the total represented graph size `N` is to be treated as an optimal complexity target for design and review purposes.

Issue #1607 records the possible stronger direction: regular valid-cursor incremental synchronization should ideally scale with the amount of synchronization-relevant change and affected dependent closure rather than with unrelated graph state. The exact change-sensitive bound, and whether the implementation should be required to satisfy it, remain outside the currently assumed performance model until that issue has an assignee.

This intent does not prescribe whether optimization work should or should not be undertaken. It only defines the complexity assumption under which current Journal and synchronization design is evaluated. Once #1607 is assigned, this intent should be reconsidered or superseded so that the active performance assumption reflects the outcome of that work.
