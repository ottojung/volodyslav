# IncrementalGraph journal migration

Migration atomically transforms graph, the one journal, coverage, lazy allocator, fingerprint, schema, identifiers, and metadata. It validates the supported-state boundary.

Newly materializing an absent NodeKey allocates a fresh NodeIdentifier and authors:

```text
fresh:               generation(publicAction=add) + validate
stale reusable:      generation(publicAction=add) + soft invalidate
must recompute:      generation(publicAction=add) + hard invalidate
```

A present unequal-value result uses exact public edit (scoped edit unless a new authority generation is required; then generation(publicAction=edit)) and every new generation receives one initial freshness assertion. An internal authority boundary without presence/value change uses generation(publicAction=null), never fake add. Removal emits delete and retires the NodeIdentifier.

Later soft propagation, unrepresented hardening, and revalidation follow ordinary causal rules. Existing uncovered hard authority is carried silently. Coverage never regresses; import alone does not raise the local clock. Local authoring lazily raises above all observed sequence history and atomically closes the local coverage coordinate.

Absent-state self-restoration restores this host's exact graph, journal, coverage, local clock, fingerprint, and identifier state; rollback under the same fingerprint is unsupported.
