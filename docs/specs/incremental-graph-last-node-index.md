# IncrementalGraph last node index

## Purpose

`last_node_index` is the greatest local allocation index durably retired
from future use. It is a monotonic allocation watermark — not a count of
existing nodes and not a count of committed materialized nodes.

## Storage location

```
rendered/r/global/last_node_index
```

In the LevelDB live database, this lives at the active replica's global
sublevel under the key `"last_node_index"`.

## Initial value

A fresh replica starts with `last_node_index = 0`. The first allocated
node identifier uses index `1`.

## Format

The value is a non-negative JSON integer.

## Allocation behavior

When allocating new node identifiers, the next available index is
derived from the current `last_node_index` watermark:

```
const nextIndex = reserveNextNodeIndex();  // increments atomic volatile counter
const id = `${nextIndex.toString(36)}-${fingerprint}`;
```

The index prefix is base36 without padding or alignment:

```
1-abcdefghi
2-abcdefghi
z-abcdefghi
10-abcdefghi
```

## Gaps

Gaps are acceptable and expected:

- If a transaction fails before durable commit, its uncommitted allocation
  does not leak into the persisted lookup or volatile committed state.
- Failed transactions consume an index value, creating a gap.
- Concurrent transactions that allocate indices and commit out of order
  can create gaps.
- `last_node_index` is the watermark of the largest index known to be
  retired; indices below it may not correspond to any materialized node.

## Sync merge semantics

When merging a host's staged snapshot into the local database, the merged
`last_node_index` is computed as:

```
mergedLastNodeIndex = max(targetLastNodeIndex, hostLastNodeIndex)
```

This is safe even though identifiers are fingerprint-namespaced:

- Taking the max may skip local index values. Gaps in the index sequence are
  acceptable and expected (see "Gaps" above). The value is a watermark of
  retired future local allocation indices, not a count of materialized nodes.
- The local fingerprint is preserved (host fingerprint is never adopted), so
  local allocations after the merge use the local fingerprint. The merged
  index watermark simply ensures the next local allocation does not reuse an
  index value that was already retired on the host side.
- The merged `last_node_index` is written durably as part of the merge commit
  and becomes the basis for subsequent local allocations.

### Metadata-only merge

When graph records are identical but `last_node_index` differs (e.g., the
host has a higher watermark), the merge commits the metadata change even
when no graph nodes were modified. This ensures the watermark propagates
and future local allocations do not collide with host-allocated indices.

## Concurrency

- Concurrent transactions must not allocate the same local index.
- JavaScript's single-threaded execution model makes atomic counter
  increment possible without additional synchronization primitives:
  the volatile `_nextNodeIndex` counter is incremented synchronously
  inside `_allocateKeyIdentifier`.
- The persisted `last_node_index` is written in the same durable batch
  as the new `identifiers_keys_map` and node records.

## Disk-before-memory invariant

- The commit watermark is captured once before disk write:
  `commitLastNodeIndex = rootDatabase.getCurrentAllocationWatermark()`.
- The disk batch writes `last_node_index` to the `commitLastNodeIndex` value.
- After the batch succeeds, in-memory `_computed.lastNodeIndex` is set to
  `max(_computed.lastNodeIndex, commitLastNodeIndex)`.
- This prevents `_computed.lastNodeIndex` from advancing past what was
  actually written while another concurrent transaction allocates ahead.
