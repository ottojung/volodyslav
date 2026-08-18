# IncrementalGraph journal

IncrementalGraph persists one replicated journal of immutable, precise semantic events. The detailed normative specification is split into:

* [types and invariants](specs/incremental-graph-journal-types.md);
* [public polling API](specs/incremental-graph-journal-api.md);
* [emission](specs/incremental-graph-journal-emission.md);
* [canonical compaction](specs/incremental-graph-journal-compaction.md);
* [directional synchronization](specs/incremental-graph-journal-sync.md);
* [migration](specs/incremental-graph-journal-migrations.md);
* [graph reconciliation](specs/incremental-graph-synchronization.md); and
* [lifecycle and reset](specs/database-lifecycle.md).

## Model at a glance

```text
journal[(sequence, author)] = JournalEntry
JournalEntryBase = {
  author, sequence, key, nodeName, bindings, time
}
journalCoverage: Map<DatabaseFingerprint,uint64>
PossibleChangeCursor: Map<DatabaseFingerprint,uint64>
```

The address invariant is `key == NodeKey(nodeName,bindings)` under the production identity-preserving serializer. Entries have one exact action: add, edit, delete, invalidate, or validate. Invalidate additionally has internal `mode = soft | hard`; only hard invalidates form causal must-recompute barriers.

Coverage and cursors are per-author prefix claims. Coverage says what the host completely accounts for despite safe deletion of exact events. A cursor says what one consumer has accounted for and is portable across hosts. Missing coordinates are zero, allocator gaps are closed non-events, and physical arrival order has no meaning.

Polling first takes the greatest entry for every `(author,key,public action)`, filters unseen representatives by the cursor and address, orders by `(sequence,author)`, and attaches cumulative vector tokens. It reports exact actions rather than projecting unrelated ones. Physical compaction retains the same maxima plus all logical and reference-closure evidence, so polling is observationally invariant under compaction.

An ordinary receive `R <- S` unions and canonically compacts journals, takes componentwise maximum coverage, raises R's allocator, reconciles without running computors, and authors only genuine receiver decisions. A later `S <- R` imports those exact events and reaches the same settled journal, coverage, and semantic graph when no mutation intervenes.

Existing-live reset does not import source history or coverage as receiver authority. It retains receiver history and authors receiver-local decisions. A surviving receiver presence generation must dominate consumed source presence authority, including equal-value snapshots; once fenced, repeating the reset is silent.

Under bounded key/address/context assumptions, notification representatives occupy `O(nr)`, hard/validation evidence can occupy `O(nr²)`, coverage occupies `O(r)`, and the total durable journal plus coverage is `O(nr²)`. Consumer tokens are `O(r)` application state.
