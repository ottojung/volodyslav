# PR #1335 Review 1: Detailed Problem Statement

## Problem statement
The current PR state exhibits a mismatch between intended locking architecture and actual runtime behavior:

- The design spec requires pull concurrency to be fine-grained (same node serialized, different nodes concurrent).
- The implementation currently serializes top-level transactional pull bodies through computed-state mutexing.

This causes different-node pulls to queue behind each other, creating avoidable latency and reducing graph throughput.

## Behavioral symptoms

1. Two independent source nodes pulled concurrently do not both enter computation immediately.
2. Comments/tests describe this as expected due to computed-state mutex serialization.
3. This directly contradicts locking-design expectations for different-node pull independence.

## Root cause decomposition

### 1) Global transaction mutex scope is too broad
`withTransaction` wraps full transaction execution in `withComputedStateMutex`, coupling:
- value/freshness/revdeps batch writes,
- and identifier allocation synchronization.

Only the latter fundamentally requires strict cross-transaction serialization.

### 2) Missing explicit per-node pull mutex
Spec expects per-node lock key (`PULL_NODE_KEY`) for pull bodies.
Current implementation relies on broad serialization and in-transaction in-flight dedupe.

### 3) Safety concern driving over-serialization
The conservative design avoids lost updates in identifier lookup persistence by serializing all transactions. This is safe, but too coarse.

## Impact

- Throughput drop under concurrent pull workloads.
- Increased tail latency for unrelated pulls.
- Spec divergence increases maintenance and reasoning burden.

## Acceptance criteria for remediation

1. Preserve observe/pull incompatibility semantics.
2. Preserve invalidate/read compatibility.
3. Restore concurrency of different-node pulls.
4. Preserve correctness of identifier allocation and persistence ordering.
5. Keep deadlock model simple and documented.
