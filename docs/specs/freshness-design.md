# Design: How to Think About Freshness

## The Distinction: Mechanism vs. State

To resolve the ambiguity between "implementation freedom" and "normative interfaces", we must distinguish between the **Freshness Mechanism** and the **Freshness State**.

### 1. Freshness Mechanism (Implementation Detail)
This is *how* the graph decides if a node needs recomputation.
*   **Examples:** Dirty bits, monotonic version numbers, content hashes, timestamps.
*   **Status:** Completely implementation-defined.
*   **Observability:** Hidden. The spec does not care if you use versions or flags, as long as the logic holds.

### 2. Freshness State (Normative Contract)
This is the **conceptual result** of the mechanism at any point in time.
*   **Values:** `up-to-date` | `potentially-outdated`.
*   **Status:** Normative. The system must be able to answer "Is this node consistent?"
*   **Observability:** Exposed. The `Database` interface requires this state to be queryable.

## The Database Interface as a Projection

The `Database` interface in the specification serves as the **boundary of observability** for conformance.

*   **`getFreshness(key)`**: This method is a request for the **Conceptual Freshness State**.
    *   It does *not* ask "what is the raw bit stored here?".
    *   It asks "does the graph consider this node up-to-date?".
    *   For a simple implementation, this maps 1:1 to a stored string.
    *   For a complex implementation (e.g., using versions), the implementation must ensure that the stored data allows `getFreshness` to return the correct conceptual state (e.g., by storing the state explicitly alongside the version, or by ensuring the storage adapter can derive it).

## Implication for Implementations

Implementations are free to use any *mechanism* (like versioning) to optimize their internal logic (e.g., to support "Unchanged Propagation"). However, they must **persist the Conceptual State** in a way that satisfies the `Database` contract.

*   **Scenario:** An implementation uses Versioning.
    *   It maintains `currentVersion` and `lastComputedVersion`.
    *   When `set()` happens, it updates versions.
    *   **Constraint:** It must *also* ensure that `getFreshness` returns `potentially-outdated` for dependents.
    *   **Strategy:** It likely stores the `potentially-outdated` flag explicitly in the DB (satisfying the interface) *and* stores the version metadata (perhaps in a separate key or as part of the node value) for its internal optimization.

## Summary

We are not prescribing *how* freshness is calculated, but we are prescribing that the **result** of that calculation (the Conceptual State) must be visible via the standard `Database` interface. This ensures that tests can verify the correctness of the propagation logic without knowing the internal mechanics.
