# IncrementalGraph last node index

## Purpose

`last_node_index` is a durable monotonic allocation watermark that tracks
the largest local node allocation index durably committed for the active
replica. It is not a count of existing nodes.

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

## Concurrency

- Concurrent transactions must not allocate the same local index.
- JavaScript's single-threaded execution model makes atomic counter
  increment possible without additional synchronization primitives:
  the volatile `_nextNodeIndex` counter is incremented synchronously
  inside `_allocateKeyIdentifier`.
- The persisted `last_node_index` is written in the same durable batch
  as the new `identifiers_keys_map` and node records.

## Disk-before-memory invariant

- Transactions write `last_node_index` to disk alongside the
  `identifiers_keys_map` batch.
- In-memory `_computed.lastNodeIndex` is updated only after the disk
  batch succeeds.
- This maintains the existing disk-before-memory ordering.

## Replica switch

- `setCurrentReplicaPointer` reloads `lastNodeIndex` from the newly
  active replica's global sublevel.
- The volatile `_nextNodeIndex` counter is reset to
  `lastNodeIndex + 1` on every replica switch.

## Sync merge behavior

During host merge, the merged value is:

```
merged_last_node_index = max(target_last_node_index, host_last_node_index)
```

The merged value is written when committing the changed merge. This
handles the case where the target replica was a copy of the active
replica (which may have a different last_node_index than the host's).

## Render and scan

- `rendered/r/global/last_node_index` is included in rendered filesystem
  snapshots alongside `identifiers_keys_map`.
- `scanFromFilesystem` imports the value into the target replica's
  global sublevel.

## Not a node count

`last_node_index` is strictly a monotonic allocation watermark:
- Deleted nodes do not decrement it.
- It is always `>=` the largest committed local index value.
- Gaps caused by failed or interleaved allocations are acceptable.
