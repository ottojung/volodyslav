# Diary Processing in Volodyslav

## Audience and Scope

This document is a deep architectural and implementation-level guide to how **diary data** flows through Volodyslav.

It covers all major diary-related paths currently implemented:

1. **Manual text diary entry** (`POST /api/entries`).
2. **Interactive audio diary recording** (frontend recorder + chunk/session backend).
3. **Live diary questioning** during recording (`POST /api/diary/live/push-audio`).
4. **Background diary-audio ingestion** from a watched filesystem directory (`processDiaryAudios`).
5. **Diary enrichment** through computed additional properties (transcription, calories, context).

A short end-user overview is included, but the primary goal is technical clarity for contributors.

---

## End-User Overview (Short)

From a user perspective, diary processing supports two practical workflows:

- **Write directly**: type an entry in the main entry form and submit.
- **Record audio**: record in the Audio Diary page, optionally get live reflective prompts, stop recording, and submit as a diary entry with an attached audio file.

After entries are saved, the app can show **derived properties** such as transcription, calories (when meaningful), and context.

---

## High-Level Architecture

Volodyslav uses a capability-injected backend and a React frontend. Diary processing is intentionally split into composable subsystems:

- **Entry ingestion and storage** (`entry`, `event_log_storage`, routes).
- **Audio session persistence** (`audio_recording_session`) in temporary LevelDB.
- **Live prompting pipeline** (`live_diary`) in temporary LevelDB.
- **Graph-backed durable event persistence** (`generators/interface` + incremental graph).
- **Asset filesystem convention** for durable attachments.
- **Background scheduler hooks** for unattended diary-audio ingestion.

A key implementation choice is that the backend uses **stateful persistence in LevelDB and graph stores**, while HTTP handlers remain thin and mostly perform shape validation + delegation.

---

## Capability Pattern and Why It Matters Here

Diary modules do not call raw global system APIs for core storage flows; they consume explicit capabilities (`checker`, `creator`, `reader`, `temporary`, `interface`, `aiTranscription`, etc.). This enables:

- deterministic testing with stubs,
- narrow dependency contracts per module,
- easier migration between storage implementations,
- centralized policy control (logging, environment, subprocess wrappers).

The result is a diary pipeline that is highly testable and modular even though it spans HTTP, AI services, filesystem assets, and durable graph data.

---

## Data Model and Storage Topology

### 1) Durable diary entry (event)

All diary entries become normal **events** in the event log graph (`all_events`). Event writes happen through `event_log_storage.transaction`, which:

1. stages entries/assets/config,
2. copies assets first,
3. updates graph-backed event/config state,
4. cleans up copied assets on failure.

This gives atomic behavior at the application-transaction level.

### 2) Durable assets

Attached audio/image files are written to deterministic paths:

`<assets-root>/<YYYY-MM>/<DD>/<event-id>/<filename>`

This path format is central to diary processing because later transcription/property pipelines infer ownership from this layout.

### 3) Temporary recording state

Audio recording session state is stored in temporary LevelDB keyspaces under `audio_session/*`:

- metadata,
- chunk blobs,
- final combined audio,
- current-session index.

### 4) Temporary live-questioning state

Live prompting state is stored separately under `live_diary/*`:

- last fragment,
- last window transcript,
- running transcript,
- asked questions,
- current-session index.

A notable design decision: **single-current-session semantics** are enforced independently for both subsystems by deleting old sessions when a new session becomes current.

---

## Path A: Manual Text Diary Entry

### Flow

1. Frontend submits `rawInput` (JSON or multipart) to `POST /api/entries`.
2. Backend validates request shape and required fields.
3. `processUserInput` pipeline executes:
   - whitespace normalization,
   - shortcut expansion from config,
   - structured parsing into type/description/modifiers.
4. Optional files are prepared as lazy `FileRef`s (including filename sanitization rules).
5. `createEntry` builds event (`id`, `date=now`, `creator`, `original`, `input`).
6. Entry + assets are committed via transaction into durable storage.

### Key implementation choices

- **Strict syntax parser**: modifier placement is constrained to avoid ambiguous input semantics.
- **Shortcut recursion**: repeated replacement until fixpoint (currently with TODO loop detection).
- **Lazy file loading** from temporary DB to avoid duplicate memory reads.
- **User errors vs internal errors** are separated for meaningful HTTP status behavior.

---

## Path B: Interactive Audio Diary Recording (Main Audio Workflow)

This is the most involved diary path and includes both frontend orchestration and backend session persistence.

### Frontend recording lifecycle

`useAudioRecorder` coordinates:

- MediaRecorder control,
- local UI state,
- backend session start/upload/stop/final fetch,
- restore after refresh/interruption.

On start:

1. Generate session ID.
2. Persist session ID in localStorage.
3. Start backend session (`POST /audio-recording-session/start`).
4. Stream chunks periodically via `POST /audio-recording-session/:sessionId/chunks`.

On stop:

1. Flush pending uploads,
2. finalize session (`POST /.../stop`),
3. fetch final combined audio (`GET /.../final-audio`),
4. use backend final audio blob as canonical submission payload.

Finally, `AudioDiary.jsx` submits a standard entry using input like:

`diary [audiorecording] ...`

with an attached file named `diary-audio.<ext>`.

### Backend audio recording session service

`audio_recording_session/service.js` is a persistent state machine:

- `startSession`: create/touch session metadata.
- `uploadChunk`: validate sequence/times, store chunk blob, update counters.
- `stopSession`: lexical-order concatenate chunk blobs into final audio.
- `fetchFinalAudio`: return finalized blob + mime type.
- `discardSession`: cleanup.

### Important implementation choices

1. **No per-session fanout complexity**: only one current session is kept; old sessions are cleaned.
2. **Duplicate chunk sequence accepted as overwrite**: supports retry/idempotence patterns.
3. **Out-of-order chunks tolerated** while preserving fragment count and latest metadata.
4. **Fail-soft on client side**: recording can continue locally even when some uploads fail.
5. **Backend as source of truth for restore**: client stores only session ID locally.

---

## Path C: Live Diary Questioning During Recording

This is a parallel assistant pipeline, not the durable entry write path itself.

### Frontend behavior

`useDiaryLiveQuestioningController` sends each 10-second fragment to:

`POST /api/diary/live/push-audio`

and displays returned question generations. If calls fail, UI shows a transient “catching up” message and continues.

### Backend behavior

`live_diary/service.pushAudio`:

1. Enforces single-current-session cleanup.
2. For first fragment: stores and returns no questions.
3. For subsequent fragments:
   - combine previous+current fragment into ~20s window,
   - transcribe window,
   - recombine overlap with previous window transcript (LLM with fallback),
   - merge into running transcript (programmatic dedup),
   - generate diary questions from running transcript,
   - deduplicate against previously asked questions,
   - persist asked questions.

### Core implementation choices

- **Two-stage overlap control**:
  - window-level recombination (AI, fallback to raw),
  - running-level programmatic recombination.
- **Persistent live state** in temporary DB so backend restarts do not erase progress.
- **Graceful degradation**: transcription/question-generation failures return empty questions instead of failing the request.
- **Question deduplication by normalized text** prevents repeated prompts from near-duplicate transcripts.

---

## Path D: Background Filesystem Diary Ingestion

This path supports unattended ingestion of externally produced audio files (e.g., from external recorder workflows).

### Trigger

`jobs/all.everyHour` calls `processDiaryAudios`.
It can also be triggered via `GET /api/periodic?period=hour`.

### Processing algorithm (`diary.js`)

1. Scan configured `VOLODYSLAV_DIARY_RECORDINGS_DIRECTORY`.
2. Filter to **stable files** (`checker.isFileStable`) to avoid processing files still being written.
3. For each stable file:
   - parse UTC timestamp from filename (`YYYYMMDDThhmmssZ...`),
   - convert timestamp to configured local timezone,
   - construct synthetic diary event input `diary [when 0 hours ago] [audiorecording]`,
   - create asset from existing file,
   - write event+asset transactionally.
4. Delete only successfully processed original files.
5. Keep failed files for future retry and log failures.

### Why these choices are good

- **Stability gating** avoids ingesting partial files.
- **Per-file success/failure isolation** prevents one bad file from blocking all others.
- **Timezone conversion from filename UTC** preserves user-local calendar semantics for asset/event association.
- **Delete-after-success only** yields safe retry behavior.

---

## Path E: Diary Enrichment and Read-Time Computed Properties

When client requests `GET /api/entries/:id/additional-properties`, backend can return:

- `transcription`,
- `calories`,
- `basic_context`,
- and per-property errors.

### Transcription enrichment strategy

1. Locate entry.
2. Scan that entry’s assets directory.
3. Detect audio files by filename rules.
4. For each candidate, request graph node `event_transcription(e, a)`.
5. Return first successful transcription text; otherwise return transcription error if all fail.

### Graph architecture behind this

`default_graph` includes:

- `event(e)` from `all_events`,
- `transcription(a)` standalone transcription node,
- `event_transcription(e, a)` join node with ownership validation.

This decomposition is deliberate:

- transcription logic remains asset-centric and cacheable,
- ownership validation stays explicit at the event join boundary,
- read-time enrichment does not require mutating base entry records.

---

## Validation and Error-Handling Philosophy in Diary Paths

Common patterns across diary modules:

1. **Shape validation at route boundaries** (session IDs, mime types, sequence numbers, fragment numbers).
2. **Specific error classes** in deeper services (e.g., audio session not found/conflict/finalize errors).
3. **Fail-soft UX for live features**: return empty results on transient AI failures.
4. **Fail-safe persistence semantics**: cleanup on transaction failure and deletion only after durable write.

This combination gives robust day-to-day operation for a personal tool without over-engineering adversarial protections.

---

## Concurrency and Ordering Semantics

### Audio recording session

- Chunk keys are zero-padded sequence numbers.
- Finalization sorts chunk keys lexicographically before concatenation.
- Duplicate sequence writes overwrite prior chunk payload.

### Live questioning

- Fragment number is validated as integer >= 1.
- Service computes windows from “last fragment + new fragment,” so the effective sequence dependency is local, not global reassembly.

### Entry listing and diary search

- Main entry retrieval uses sorted event iterators from graph nodes.
- First-page optimization via `last_entries(n)`/`first_entries(n)` caches reduces heavy reads.

---

## Timezone and Asset Association Nuances

A critical subtlety: filesystem-ingested diary audio filenames encode UTC timestamps, but entries are shifted to configured local zone before event creation. Asset path placement then follows event local date (`YYYY-MM/DD/event-id`).

This avoids a class of bugs where midnight-boundary recordings are associated with the wrong local day.

The `event_transcription` validation path is also designed to tolerate persisted date-shape variants when reconstructing expected asset-directory prefix.

---

## Observability and Operations

Diary paths include structured logging for:

- request-level failures,
- ingestion skips (unstable files),
- transcription/recombination/question-generation failures,
- successful processing/deletion counts.

Operationally useful endpoints/workflows:

- `/api/periodic?period=hour` to trigger ingestion manually,
- audio session endpoints for diagnosing interrupted recordings,
- additional-properties endpoint for ad-hoc verification of transcription/calories pipelines.

---

## How the Pieces Fit Together (Mental Model)

The cleanest way to reason about diary processing in Volodyslav is:

1. **Capture layer**
   - text input route,
   - audio recorder session route,
   - filesystem ingestion path.

2. **Persistence layer**
   - durable events/assets via transaction + graph,
   - temporary state for in-progress audio/live workflows.

3. **Enhancement layer**
   - live prompt generation while recording,
   - read-time graph-derived properties (transcription/calories/context).

4. **Recovery layer**
   - resumable recording by session ID,
   - single-current-session cleanup,
   - best-effort behavior on non-critical AI failures.

This layered design is the central implementation choice that makes diary features cohesive without tightly coupling UI, AI, and durable storage concerns.

---

## Practical Contributor Checklist (Diary-Related Changes)

When modifying diary processing, validate these invariants:

- [ ] Entry write path still goes through transaction abstraction.
- [ ] Asset path convention remains `<YYYY-MM>/<DD>/<event-id>/<filename>`.
- [ ] Audio session restore works after reload with only session ID in localStorage.
- [ ] Live diary question path remains non-fatal on AI subsystem failures.
- [ ] Background ingestion only deletes originals after successful durable write.
- [ ] Timezone conversion behavior remains consistent for filename-derived diary events.
- [ ] Additional-properties still isolates per-property errors instead of failing whole response.

---

## Summary

Volodyslav’s diary processing is not a single pipeline but a coordinated set of complementary flows:

- **durable entry creation**,
- **resumable audio capture**,
- **live reflective prompting**,
- **scheduled file ingestion**,
- **graph-based enrichment at read time**.

The most important implementation ideas are capability injection, explicit temporary-vs-durable boundaries, deterministic asset layout, and fail-soft handling for AI-dependent paths.
