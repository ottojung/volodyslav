# Incremental Graph Synchronization

This document is retired as a specification. Journal synchronization has one
canonical normative owner:

- `incremental-graph-journal-sync.md` — suffix replication, normalization,
  convergence, and the host-count settling construction.

That ownership is declared by the Journal 3 reading order
(`incremental-graph-journal-README.md`, §Normative ownership: "Each semantic
rule has one normative owner").

This file previously restated the same synchronization contract in parallel.
Two competing full specifications violated the one-owner rule above and the
documentation-cutover requirement in
`incremental-graph-journal-checklist.md` §16a ("There must be one obvious
canonical shipped specification for synchronization"). The file is retained
only as a pointer so existing references resolve; it is not a competing
definition of any synchronization rule. This discharges §16a's instruction to
replace or rewrite `incremental-graph-synchronization.md` so the canonical
synchronization specification describes shipped Journal 3 behavior: the owner
above now carries that contract, and this file is only a redirect to it.

No normative requirement was dropped in the consolidation. The obligations that
appeared only in the retired text — "Synchronization MUST NOT invoke computors"
and the scope/non-goals statements — are restated in
`incremental-graph-journal-sync.md` §Scope and non-goals. The bounded-memory
iteration contract remains owned by `$id-4924739474925738`.

See `incremental-graph-journal-README.md` for the Journal 3 reading order.
