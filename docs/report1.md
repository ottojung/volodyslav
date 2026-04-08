# Report 1 — Issue Understanding (IncrementalGraph Boot Sequence Failure)

## Executive summary

The startup path currently allows **incorrect initialization ordering** when the live IncrementalGraph LevelDB is missing. Instead of deterministically recovering from remote state first, startup can create/open a fresh local database directly and only later rely on manual sync behavior. This makes migration and format checks happen against the wrong initial source of truth.

## Problem statement (reframed)

The issue requests a strict startup contract:

1. If on-disk DB is missing:
   - attempt `reset-to-hostname` for current host (`$VOLODYSLAV_HOSTNAME`),
   - if that host branch does not exist remotely, initialize from empty and do normal sync (merge flow).
2. If on-disk DB exists:
   - validate database format and crash on mismatch.
3. If version mismatches:
   - run migration.

## Why this is currently brittle

### 1) Missing-DB branch was not treated as a first-class startup mode
Startup initialization centered around `ensureInitialized()` and opening local DB. Synchronization existed as a separate action path. That separation is safe only if local DB presence is guaranteed; it is unsafe when boot must seed from remote first.

### 2) Host-branch-missing was not represented explicitly
Reset-to-hostname failures were generic git/sync failures, making it impossible to distinguish:
- expected first-host boot condition (branch absent), from
- actual infrastructure failures.

Without that distinction, no reliable fallback policy exists.

### 3) Migration trigger depends on which local state was opened
Migration logic is robust once correct local state is present. But if startup opened the wrong empty state first, migration could be skipped or misapplied relative to intended remote lineage.

## Concrete risk scenarios

1. **Upgrade on host with deleted local LevelDB but existing remote host branch**
   - expected: reset to host branch, then migrate if needed
   - broken behavior risk: open empty local DB first, migration path not aligned with remote data

2. **Brand-new host with no `<hostname>-main` branch**
   - expected: fallback to empty+merge sync
   - broken behavior risk: generic failure or undefined behavior depending on command path

3. **Legacy layout (e.g. `xy-v1`) on disk**
   - expected: immediate crash
   - required because migration is for schema/version, not incompatible root format layouts

## Conclusion

The issue is fundamentally a **boot orchestration bug**, not a migration algorithm bug. The fix must enforce ordering and explicit branch-absence semantics at startup, before graph initialization.
