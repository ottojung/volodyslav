# VOLODYSLAV_HOSTNAME

## Purpose

`VOLODYSLAV_HOSTNAME` is an environment variable that identifies the machine on which a Volodyslav instance is running.

Because Volodyslav can be deployed and run on multiple hosts simultaneously, it is important to track *where* data was created. This variable provides that information at the source — both for event log entries and for nodes in the incremental computation graph.

## How It Works

### Event Log Entries

Every event in the event log carries a `creator` structure that records metadata about the Volodyslav instance that created it. With `VOLODYSLAV_HOSTNAME`, this structure now includes a `hostname` field:

```json
{
  "creator": {
    "name": "Volodyslav",
    "uuid": "81c3188c-d2cc-4879-a237-cdd0f1121346",
    "version": "1.2.3",
    "hostname": "my-server.example.com"
  }
}
```

The `hostname` field tells you which machine produced the event entry. This is helpful when you have multiple hosts all writing to the same shared event log repository, and you want to understand the provenance of each entry.

### Incremental Graph Nodes

The incremental computation graph caches computed node values in a database. Each node records `createdAt`, `modifiedAt`, and now also `createdBy` in its stored record. The `createdBy` field holds the hostname of the machine that first computed the node.

Like `createdAt`, the `createdBy` value is **immutable** after first creation: subsequent recomputations on a different host will not change the recorded hostname. This ensures a stable record of where the computation originally took place.

## Configuration

Set `VOLODYSLAV_HOSTNAME` to a string that uniquely identifies the host within your deployment. Examples:

```bash
# A descriptive hostname
export VOLODYSLAV_HOSTNAME="my-laptop"

# A fully qualified domain name
export VOLODYSLAV_HOSTNAME="server01.prod.example.com"
```

`VOLODYSLAV_HOSTNAME` is a **required** environment variable. Volodyslav will refuse to start if it is not set (it is checked by `ensureEnvironmentIsInitialized` at startup).

## Why Not Use `os.hostname()`?

While Node.js exposes the system hostname via `os.hostname()`, relying on the OS hostname has several drawbacks:

- **Not portable across environments**: The OS hostname may change due to infrastructure automation (e.g., cloud instances getting new names on restart).
- **Ambiguity in containers**: Containerized Volodyslav instances may share the same OS-level hostname or have non-descriptive auto-generated names.
- **Explicit is better than implicit**: Requiring the operator to set `VOLODYSLAV_HOSTNAME` forces a conscious choice and makes the deployment more self-documenting.

By requiring an explicit environment variable, you can assign a stable, human-meaningful identifier regardless of the underlying infrastructure.

## Visibility in the REST API

The `createdBy` field is exposed through the graph inspection REST API alongside `createdAt` and `modifiedAt`:

```json
{
  "head": "all_events",
  "args": [],
  "freshness": "up-to-date",
  "createdAt": "2026-03-07T10:18:20.735Z",
  "modifiedAt": "2026-03-07T10:18:20.735Z",
  "createdBy": "my-server.example.com"
}
```

This makes it easy to see, from outside, which host initially computed each graph node.

---

# VOLODYSLAV_ANALYZER_HOSTNAME

## Purpose

`VOLODYSLAV_ANALYZER_HOSTNAME` designates the single host that is responsible
for running the **diary summary pipeline**.

Because the diary summary pipeline calls the AI summarizer and writes results
to the shared graph database, running it concurrently on multiple hosts would
waste API credits and risk clobbering in-progress summaries.  By setting this
variable to exactly one hostname, only that host will execute the pipeline;
all other hosts silently skip it.

## How It Works

The diary summary pipeline is guarded by an owned `ExclusiveProcess` (see
[exclusive_process.md](exclusive_process.md)).  When `invoke` is called:

1. The process reads `VOLODYSLAV_ANALYZER_HOSTNAME` lazily (at call time).
2. If it is set, the current host's `VOLODYSLAV_HOSTNAME` is compared against
   it.
3. If they differ, a `NotProcessOwnerError` is thrown and the pipeline does
   not run.
4. The hourly job (`jobs/all.js`) catches this error and logs it at **debug**
   level — it is not an error condition, just a confirmation that the work
   belongs to another host.

## Configuration

```bash
# On the analyzer host (the one that should run AI summarization):
export VOLODYSLAV_ANALYZER_HOSTNAME="analyzer-01"
export VOLODYSLAV_HOSTNAME="analyzer-01"

# On worker hosts (they will skip the diary summary pipeline):
export VOLODYSLAV_ANALYZER_HOSTNAME="analyzer-01"
export VOLODYSLAV_HOSTNAME="worker-02"
```

`VOLODYSLAV_ANALYZER_HOSTNAME` is a **required** environment variable in
production deployments. Volodyslav will refuse to start if it is not set (it
is checked by `ensureEnvironmentIsInitialized` at startup).

When the variable is absent (for example in tests or single-host development
setups), the diary summary pipeline behaves as if it is **unowned**: any host
may run it. `ensureEnvironmentIsInitialized` ensures this cannot happen in a
running production instance.

The allowed character set is the same as `VOLODYSLAV_HOSTNAME`:
`[0-9A-Za-z_-]+`.
