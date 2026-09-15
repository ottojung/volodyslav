# Volodyslav Periodic Jobs

## Scope

This specification defines the application-level periodic jobs registered with the declarative scheduler. It does not change the scheduler's generic cron semantics.

## Hourly job

Volodyslav registers the existing `every-hour` periodic job with the POSIX cron schedule:

```text
0 * * * *
```

Each execution of that hourly job performs the application's hourly maintenance responsibilities, including:

- processing pending diary audio work;
- synchronizing configured Volodyslav state;
- attempting canonical Journal 2 compaction for the local IncrementalGraph database;
- running the analyzer-host diary summary work when this host is the configured analyzer.

Journal 2 compaction is attempted once per execution of the hourly job. A missed scheduler occurrence does not create one compaction obligation per missed hour; the scheduler's ordinary no-make-up execution policy applies. A later hourly execution may compact all raw historical journal state which has accumulated since the previous successful compaction.

A failed compaction attempt is recorded as its own hourly-responsibility failure and MUST NOT fail the `every-hour` scheduler task, trigger scheduler retry of the other hourly responsibilities, or create a separate make-up compaction obligation. Successfully committed compaction batches remain valid; the next ordinary hourly execution simply attempts to compact whatever eligible raw history remains or has accumulated since the last successful batches.

The hourly cadence is an operational Volodyslav policy, not part of Journal 2 semantic identity, synchronization, conflict authority, or convergence. Journal 2 correctness must remain independent of the exact instant at which an hourly compaction attempt actually runs.

See `$id-2399748558090155`.

## Daily job

Volodyslav also registers the existing `daily-2am` periodic job with the POSIX cron schedule:

```text
0 2 * * *
```

Each execution runs the application's daily-tasks responsibility through the existing daily task runner. This job has no Journal 2 compaction responsibility; canonical Journal 2 compaction remains part of `every-hour` only.

The daily registration uses the declarative scheduler's ordinary cron, retry, and missed-run semantics. This section documents the existing application registration and does not change those generic scheduler rules.
