# Development branches

$id-8266025568617874
title: Living specifications on work-in-progress branches
date: 2026/09/07
source: @ottojung
kind: requirement

Work-in-progress branches may intentionally contain normative specification documents for implementation that is still being developed as part of the same living in-progress work.

Documentation/code consistency is required before a branch is treated as release-ready or promoted into a release-ready branch. During active work, a normative specification may lead the implementation when both belong to the same living in-progress design. This exception is specifically for specification documents; it does not relax the requirement that comments, JSDoc, and tests describe or exercise implementation which actually exists on the branch. It also does not permit documentation of discarded designs, superseded implementations, development-process narration, or unrelated future ideas.

An explicitly work-in-progress branch is therefore allowed to temporarily contain normative specifications whose implementation has not landed yet, provided the branch belongs to active work intended to become implementation-consistent before release.

---

$id-3741067944204779
title: Opaque numeric intent IDs and human-readable titles
date: 2026/09/07
source: @ottojung
kind: requirement

Every Intent Record must have a stable opaque ID consisting of `$id-` followed by 16 random decimal digits. The digits must be generated randomly rather than chosen to encode a mnemonic, date, sequence, category, or other meaning.

Every Intent Record must also contain a concise human-readable `title:` field. The title is the readable name or shortcut for the intent; the numeric ID remains its canonical stable identity and cross-reference. A title may be improved without changing the ID while the record continues to identify the same intent.
