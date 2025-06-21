# Entries – Holistic System Overview

This document provides a broad, high-level view of how "entries" (user events) flow through the entire backend architecture—from ingestion via CLI or HTTP, through validation and processing, to durable storage, retrieval, and integrations with scheduling, notifications, and versioning.

## 1. System Entry Points

- **Command-Line Interface** (`backend/src/index.js`)
  - `start` command boots the HTTP server
  - `--version` flag prints the current service version

- **HTTP API** (`backend/src/routes/entries.js`)
  - `POST /api/entries` for creating entries (with optional file uploads)
  - `GET /api/entries` for listing entries with pagination

- **Automated Processes**
  - **Scheduled Tasks** (`backend/src/schedule/`) may periodically read or manipulate entries
  - **Webhooks/AI** pipelines (e.g., transcription, analysis) can record or augment entry data

## 2. Shared Capabilities & Initialization

- A central **Capabilities** object (built in `capabilities/root.js`) provides:
  - **Environment** (configuration, file paths, ports)
  - **Logger** (structured logging, HTTP request logs)
  - **Filesystem** interfaces (reader, writer, appender, checker, deleter, copier)
  - **Random/seeding** utilities for IDs (`request_identifier`, `event/id`)
  - **Subprocess & Git** support (`command`, `gitstore` for versioned commits)
  - **Scheduler** for periodic jobs
  - **Notifier** for external alerts
  - **AI transcription** for media attachments
  - **Datetime** helper for consistent timestamping

- **Server Startup** (`backend/src/server.js`)
  - Constructs Express app, mounts all feature routers, ensures environment, Git, notifier, and working repository are ready, and then schedules periodic tasks.

## 3. Ingestion & Parsing Workflow

1. **Raw Input**
   - CLI passes free-form text.
   - HTTP clients send `rawInput` and optional `date` in JSON.
2. **Middleware**
   - JSON and URL-encoded body parsing in Express.
   - Multer handles file uploads, mapping to `filesystem.checker` objects.
3. **User Input Processing**
   - `processUserInput` applies domain-specific parsing rules to extract:
     - `type` (note, todo, diary, etc.)
     - `description` (main text)
     - `modifiers` (tags, key=value pairs)
   - Parsing errors (`InputParseError`) result in `400 Bad Request` responses.

## 4. Entry Creation Core

- **Entry Data Structure**
  ```ts
  interface EntryData {
    date?: string;
    original: string;
    input: string;
    type: string;
    description: string;
    modifiers?: Record<string, string>;
  }
  ```

- **createEntry** (`backend/src/entry.js`)
  - Generates a unique `id` via `eventId.make`.
  - Resolves `date` (from input or current time).
  - Validates `description` and `modifiers`.
  - Constructs an `Event` with `creator`, `assets`, and all fields.
  - Wraps writes in `transaction` on **event log storage**:
    - `storage.addEntry(event, assets)` appends to log
    - Optionally commits via Git for immutable history
  - Logs success with `logger.logInfo`.

## 5. File Attachments & Asset Linking

- Uploaded files are converted into `ExistingFile` instances.
- `event/asset.make(event, file)` generates metadata linking each file to its event.
- Assets persist alongside event records in the storage backend.

## 6. Storage Backend & Transactions

- **event_log_storage** abstraction supports:
  - **Atomic Writes**: all-or-nothing via transactions
  - **Pluggable Backends**: JSON streams, file-based logs, Git-backed stores
  - **Consistent Reads**: safe retrieval during concurrent operations

## 7. Retrieval & Pagination

- **getEntries** (`backend/src/entry.js`)
  - Validates `page` and `limit` parameters.
  - Reads full event list inside a transaction.
  - Slices results for the requested page.
  - Returns `{ results, total, hasMore, page, limit }`.

- **HTTP GET /api/entries**
  - Maps `getEntries` result to JSON with `results` (serialized) and `next` URL.

## 8. Cross-Cutting Integrations

- **Version Control**: every change to the log can be committed via `gitstore`, enabling history, rollbacks, and diff-driven workflows.
- **Scheduler Hooks**: periodic jobs may consume entries to trigger reminders, cleanups, or summaries.
- **Notifications**: new entries can trigger alerts (email, push, etc.) via the `Notifier` interface.
- **AI/Transcription**: media attachments may be transcribed and linked to entries.

## 9. Testing & Quality

- Unit tests cover parsing, storage, route handlers, and end-to-end flows (`backend/src/tests`).
- Error scenarios tested: invalid dates, missing fields, storage faults.
- CI scripts (`run-tests`, `Makefile`) integrate coverage checks.

## 10. Extension Points

- To support new types (e.g., `reminder`, `bookmark`): extend `processUserInput` and adjust downstream handlers.
- Swap or augment storage by implementing custom `event_log_storage` modules.
- Add hooks in `transaction` callbacks for auditing, replication, or real-time streaming.

---

This overview captures all major touchpoints for entries in the backend, from ingestion to persistence and integration with auxiliary systems.
