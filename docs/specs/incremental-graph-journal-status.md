# Journal 1 implementation status

The journal documents are one normative target design. Production currently
implements the foundational persistence invariants used by that design:
canonical DatabaseFingerprint validation, persistence-safe ConstValue values,
production enforcement of persistence-safe ComputedValue values at computor,
open, synchronization, reset, and migration boundaries, and order-sensitive
NodeKey identity. The Python verifier is an executable
reference model for journal causality, reset, compaction, synchronization, and
iterator laws.

Journal event persistence, authoring, compaction, reset-anchor archives, and
consumable iterators remain model/specification work unless their production
module is explicitly linked from this status document. Specifications describe
the target architecture and do not assert that those journal runtime stages are
already available through the production IncrementalGraph API.
