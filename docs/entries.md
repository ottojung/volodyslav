# Entries – Comprehensive System Overview

This document provides a concept-level map of how "entries" (user events) interact with and traverse the backend system—covering ingestion, processing, storage, retrieval, cross-cutting services, and lifecycle concerns.

## 1. System Entry Points

Entries can originate from multiple interfaces:

- **Command-Line Interface** (`backend/src/index.js`)  
  - `start` command boots the HTTP server
  - `--version` flag prints the current service version
  - Lightweight CLI for local workflows

- **HTTP API** (`backend/src/routes/entries.js`)  
  - `POST /api/entries` for creating entries (with optional file uploads)
  - `GET /api/entries` for listing entries with pagination
  - File uploads and raw text requests flow through common parsing and storage logic

- **Automated & Batch Processes**  
  - **Scheduled Tasks** (`backend/src/schedule/`) may periodically read or manipulate entries
  - **Webhooks/AI** pipelines (e.g., transcription, analysis) can record or augment entry data asynchronously

## 2. Shared Capabilities & Initialization

A unified **Capabilities** object (built in `capabilities/root.js`) binds together:

- **Environment** (configuration, file paths, ports, feature flags)  
- **Logger** (structured logging, HTTP request logs, entry events, errors, metrics)  
- **Filesystem** interfaces (reader, writer, appender, checker, deleter, copier)  
- **Random/seeding** utilities for IDs (`request_identifier`, `event/id`)  
- **Subprocess & Git** support (`command`, `gitstore` for versioned commits and audit)  
- **Scheduler** for periodic jobs & **Notifier** Service for external alerts  
- **AI transcription** for media attachments (transcription, analysis)  
- **Datetime** helper for consistent timestamping

**Server Startup** (`backend/src/server.js`) ensures all systems (env, storage backends, notifier, scheduler, Git repo) are primed before handling entry traffic. Constructs Express app, mounts all feature routers, ensures environment, Git, notifier, and working repository are ready, and then schedules periodic tasks.

## 3. Ingestion & Validation Workflow

1. **Raw Input**
   - CLI passes free-form text
   - HTTP clients send `rawInput` and optional `date` in JSON
   - Multipart uploads funnel through common middleware

2. **Middleware**
   - JSON and URL-encoded body parsing in Express
   - Multer handles file uploads, mapping to `filesystem.checker` objects

3. **User Input Processing**
   - `processUserInput` applies domain-specific parsing rules to extract:
     - `type` (note, todo, diary, etc.)
     - `description` (main text)
     - `modifiers` (tags, key=value pairs)
   - Parsing errors (`InputParseError`) result in `400 Bad Request` responses
   - Early rejection of malformed data (missing description, invalid date, bad modifiers) with clear client errors

## 4. Core Domain Logic & Specialized Flows

**Entry Data Structure**
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

**createEntry** (`backend/src/entry.js`)
- Generates a unique `id` via `eventId.make`
- Resolves `date` (from input or current time)
- Validates `description` and `modifiers`
- Constructs an `Event` with `creator`, `assets`, and all fields
- Wraps writes in `transaction` on **event log storage**:
  - `storage.addEntry(event, assets)` appends to log
  - Optionally commits via Git for immutable history
- Logs success with `logger.logInfo`

**Specialized Handlers**  
- Diary entries (`diary.js`) may invoke audio transcription tasks
- Task or reminder types might schedule follow-up jobs  
- Custom types can plug into this factory to extend behavior

**Asset Linking**  
- Uploaded files are converted into `ExistingFile` instances
- `event/asset.make(event, file)` generates metadata linking each file to its event
- Associates uploaded or referenced files with entries, producing immutable asset descriptors

## 5. Durability & Pluggable Storage

**event_log_storage** abstraction supports:
- **Atomic Writes**: all entry writes (and linked assets) occur within atomic transactions, ensuring consistency or rollback
- **Pluggable Backends**: JSON streams, file-based logs, Git-backed stores for audit, history, and diff-driven workflows
- **Consistent Reads**: safe retrieval during concurrent operations

**Retrieval Interface**  
- **getEntries** (`backend/src/entry.js`) validates `page` and `limit` parameters, reads full event list inside a transaction, slices results for the requested page, and returns `{ results, total, hasMore, page, limit }`
- **HTTP GET /api/entries** maps `getEntries` result to JSON with `results` (serialized) and `next` URL
- Unified query layer provides pagination, filtering, and cursor-based navigation for large datasets

## 6. Asset Lifecycle Management

- **Creation**  upon entry ingestion.  
- **Retention & Cleanup**  policies determine when assets become orphaned or are archived.  
- **Deletion**  cascades or manual pruning remove assets from storage and log.

## 7. Cross-Cutting Integrations

- **Version Control**: every change to the log can be committed via `gitstore`, enabling history, rollbacks, and diff-driven workflows
- **Scheduler Hooks**: periodic jobs may consume entries to trigger reminders, cleanups, or summaries and may update entry state
- **Notifications & Alerts**: new entries can trigger alerts (email, push, etc.) via the `Notifier` interface or escalate via external channels
- **AI/Transcription Pipelines**: media attachments may be transcribed and linked to entries; can feed AI services to auto-generate transcripts or enrich metadata
- **Logging & Observability**: entry lifecycle emits structured logs and metrics, enabling tracing and health monitoring
- **Error Handling**: centralized error middleware differentiates client faults (validation) from system failures (storage, dependencies), with structured alerts

## 8. Security & Access Control

- **Authentication & Authorization**  
  Gate entry creation and retrieval based on user roles and scopes.
- **Input Sanitization**  
  Prevent injection attacks by validating and escaping entry content and file metadata.
- **File Validation**  
  Enforce upload size, type restrictions, and virus scanning for attachments.

## 9. Performance & Scalability

- **Pagination Strategies**  
  Avoid large in-memory scans by employing cursors or indexed queries.
- **Storage Sharding**  
  Distribute event logs across partitions or services for high throughput.
- **Caching**  
  Layer results or metadata to reduce repeated storage reads.

## 10. Testing & Quality Assurance

- **Unit Tests**: cover parsing rules, core factory logic, storage interactions, route handlers, and end-to-end flows (`backend/src/tests`)
- **Integration Tests**: validate end-to-end flows through API, storage, and auxiliary services (scheduler, notifier)  
- **Mock Repositories**: simulate versioned storage to test transactional guarantees
- **Fault Injection**: verify resilience by simulating errors in dependencies (filesystem, Git, AI services)
- **Error Scenarios**: tested invalid dates, missing fields, storage faults
- **CI Integration**: scripts (`run-tests`, `Makefile`) integrate coverage checks

## 11. Configuration & Environment

- **Feature Flags**  
  Toggle new entry types or pipelines without redeploying code.  
- **Storage Settings**  
  Configure backend type, retention policies, and path locations.  
- **Security Settings**  
  Define authentication providers, rate limits, and access control rules.

## 12. Lifecycle & Cleanup

- **Entry Deletion**  
  Soft or hard delete semantics, with optional archival for compliance.  
- **Audit Trails**  
  Maintain immutable logs of create/update/delete actions for governance.  
- **Data Retention**  
  Automated purge based on age or policy, impacting both entries and assets.

## 13. Extension & Customization

- **Parser Plugins**: add or override parsing rules for new entry types and modifiers; extend `processUserInput` and adjust downstream handlers
- **Storage Adapters**: implement custom backends (NoSQL, distributed logs) by conforming to the transaction API; swap or augment storage by implementing custom `event_log_storage` modules
- **Lifecycle Hooks**: insert custom logic at key points (pre-create, post-retrieve, on-delete) for auditing or replication; add hooks in `transaction` callbacks for auditing, replication, or real-time streaming

---

*This overview integrates all entry-related touchpoints—from concrete implementation details to high-level architectural concerns—guiding developers and architects through the complete entry ecosystem.*
