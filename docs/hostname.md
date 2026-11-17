# VOLODYSLAV_HOSTNAME

## Purpose

`VOLODYSLAV_HOSTNAME` is an environment variable that identifies the machine on which a Volodyslav instance is running.

Because Volodyslav can be deployed and run on multiple hosts simultaneously, the hostname is useful for event-log provenance and deployment/transport coordination. It is not persisted as per-node IncrementalGraph provenance.

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

### IncrementalGraph state

`VOLODYSLAV_HOSTNAME` is not stored as a `createdBy` field on IncrementalGraph node records, and graph inspection does not expose per-node hostname provenance.

Hostnames are deployment/transport context rather than semantic IncrementalGraph identity. Journal 3 makes that boundary explicit: implementation-owned persistent graph/Journal state must not store hostnames or other transport locators; see `docs/intent-records/journal.md` `$id-4373538486707762`.

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

---

# VOLODYSLAV_ANALYZER_HOSTNAME

## Purpose

`VOLODYSLAV_ANALYZER_HOSTNAME` designates which host is responsible for running the diary summary pipeline. Only the host whose `VOLODYSLAV_HOSTNAME` matches `VOLODYSLAV_ANALYZER_HOSTNAME` will execute the AI-powered diary summarization.

## Behavior

- **Hourly scheduled job**: If the current host is not the analyzer, the diary summary step is skipped and an info-level log entry is written instead.
- **Manual trigger (frontend)**: If the current host is not the analyzer, the POST `/diary-summary/run` endpoint returns a 503 response with `{ "error": "not_analyzer", "currentHostname": "...", "analyzerHostname": "..." }`. The frontend displays an error toast with the analyzer hostname.

## Configuration

Set `VOLODYSLAV_ANALYZER_HOSTNAME` to the hostname of the machine that should run diary summaries:

```bash
export VOLODYSLAV_ANALYZER_HOSTNAME="analyzer-host"
```

`VOLODYSLAV_ANALYZER_HOSTNAME` is a **required** environment variable. Volodyslav will refuse to start if it is not set (it is checked by `ensureEnvironmentIsInitialized` at startup).
