# Live Audio Pipeline

This document explains the algorithms and conceptual design of the **cadence-agnostic live diary pipeline** — the subsystem that ingests PCM audio fragments uploaded during a live recording session, assembles them into transcription windows, and generates reflective diary questions on demand.

---

## Overview

The pipeline separates **upload** from **transcription**. The client can upload PCM chunks at any cadence (fast bursts, slow trickle, variable intervals) and poll for questions independently. Transcription and question generation happen lazily, only when the client requests them.

```
Client                     Backend
──────                     ───────
push-pcm ──────────────────► store chunk + index fragment
push-pcm ──────────────────► store chunk + index fragment
push-pcm ──────────────────► store chunk + index fragment
GET /live-questions ───────► pull cycle (transcribe + question)
                    ◄──────── { questions: [...] }
push-pcm ──────────────────► store chunk + index fragment
GET /live-questions ───────► pull cycle (transcribe + question)
```

---

## Part 1: Fragment Upload and Indexing (push-pcm)

### Binary storage

Each PCM chunk is stored in the audio session's binary chunk sublevel, keyed by its sequence number. This part is handled by the existing `uploadChunk` mechanism.

### Fragment index

After binary storage, `ingestFragment` records lightweight timing and format metadata in the **fragment index**:

- `sequence` — monotonically increasing integer assigned by the client.
- `startMs`, `endMs` — wall-clock timestamps (milliseconds) for the audio slice.
- `sampleRateHz`, `channels`, `bitDepth` — PCM format parameters.
- `contentHash` — SHA-256 of the raw PCM bytes, used for idempotency.
- `ingestedAtMs` — server-side ingestion timestamp.

**Idempotency**: if the same sequence number is uploaded again with identical content and timing, the ingest is a silent no-op (`duplicate_no_op`). Non-identical re-uploads of a sequence that has already been transcribed (below the watermark) are rejected (`duplicate_rejected`) to prevent retroactive corruption of the running transcript.

---

## Part 2: The Pull Cycle

When the client calls `GET /live-questions`, the backend executes a **pull cycle** for the session. The pull cycle is serialized per session via an in-memory promise chain, so concurrent pulls cannot interleave.

The pull cycle proceeds through the following stages:

### Stage 1: Read State

Load the session's current **high-watermark** (`transcribedUntilMs`) and the full fragment index from the temporary LevelDB store.

The watermark is the boundary: everything before it has already been transcribed and integrated into the running transcript.

### Stage 2: Gap Detection

Scan the fragment timeline from the watermark to the caller-provided `deadlineMs`. Conceptually, the fragments should form a contiguous sequence. Holes in this sequence are **gaps**.

`deadlineMs` is an input to the pull cycle:
- in `GET /live-questions`, the backend currently uses `Number.MAX_SAFE_INTEGER`, so all uploaded fragments are eligible regardless of wall-clock time;
- other callers can pass a smaller deadline to bound processing to an earlier point.

Each gap is tracked with a `firstObservedAtMs` timestamp. Gaps come in two states:

- **Waiting** — the gap was observed recently. The pipeline waits for the missing fragment to arrive (upload jitter is expected).
- **Abandoned** — the gap is older than `GAP_ABANDON_MS` (30 seconds). The gap is declared missing and will be synthesized as silence during assembly.

**Key properties of gap tracking:**
- Gaps are keyed by their `startMs` position. If a new fragment partially fills a gap, the gap's `endMs` is updated without resetting `firstObservedAtMs`, preserving the aging history.
- Gaps that have been filled by new fragments are pruned from the known-gaps list.
- A gap that begins exactly at the watermark (`blockedAtWatermark`) causes the pull to exit early without advancing — the session is blocked waiting for an upload.

The gap scan returns `processableEndMs`: the furthest point up to which a contiguous (possibly gap-synthesized) range is available.

### Stage 3: Overlap Window Planning

Rather than transcribing exactly `[transcribedUntilMs, processableEndMs]`, the pipeline includes a short **overlap** of previously transcribed audio at the start of each window. This helps the AI transcription model produce consistent text at the boundary.

The overlap duration is computed as:

```
effectiveOverlapMs = max(MIN_OVERLAP_MS, min(prevNewDurationMs, OVERLAP_CAP_MS))
```

where:
- `MIN_OVERLAP_MS` = 10 seconds (floor — ensures every window has context).
- `OVERLAP_CAP_MS` = 60 seconds (ceiling — prevents excessive reprocessing).
- `prevNewDurationMs` = the duration of new audio processed in the previous pull.

The rationale: a short prior new region needs the full 10 s of context; a long prior new region needs at most a proportional overlap; very long sessions are capped at 60 s.

The resulting window is `[windowStartMs, windowEndMs]` where `windowStartMs = max(0, transcribedUntilMs - effectiveOverlapMs)`.

### Stage 4: PCM Assembly

The assembler reads the binary PCM chunks for all fragments that intersect the window and stitches them into a single contiguous buffer:

- Fragments are sorted by `(startMs, sequence)`.
- Overlapping fragments are clipped to their uncovered portion.
- Gaps within the window (abandoned gaps or missing fragment binaries) are filled with silence.
- Byte offsets are computed in frames: the start of each slice is floored to the nearest frame boundary (to avoid skipping audio), and the end is ceiled (to avoid truncating a partial last frame).

The assembled PCM is wrapped in a WAV header for the transcription API.

### Stage 5: Transcription

The assembled WAV is sent to the AI transcription service. If transcription times out or fails, the pull exits with `degraded_transcription` without advancing the watermark, so the next pull retries the same audio range.

If the transcription returns an empty string (silent window), the watermark still advances (the silence is real, no retry needed) but all transcript state is preserved unchanged. In particular, `lastWindowTranscript` is **not** cleared — the next non-silent pull must use it for LLM recombination to correctly stitch the transcripts across the silent boundary. Clearing it would cause the next non-silent pull to skip recombination entirely and produce a running transcript with a duplicated overlap segment.

### Stage 6: LLM Recombination

Because consecutive windows overlap, the same speech appears in both the current window transcript and the previous one. **Recombination** removes this duplication:

```
previous window: "...the meeting was good and we discussed..."
current window:  "...discussed the roadmap and I think..."
merged:          "...the meeting was good and we discussed the roadmap and I think..."
```

The LLM is asked to stitch the two transcripts at their natural boundary, removing the duplicated overlap segment. A fallback programmatic recombination (suffix/prefix match) is used if the LLM call fails.

Before passing the current window transcript to the LLM, its final word is temporarily removed (to avoid asking the LLM to recombine on a potentially half-heard word at the audio boundary) and reattached afterwards.

### Stage 7: Running Transcript Accumulation

The merged text from recombination is appended to the session's **running transcript** using the same programmatic recombination logic. This builds up a single de-duplicated transcript of the entire session.

New words (those beyond the existing running transcript) are counted to gate question generation.

### Stage 8: Question Generation

Question generation is triggered when:

1. The cumulative new-word count since the last question batch exceeds 10 words.
2. No question batch from the previous pull is still pending (i.e., the client has fetched it).

The number of questions generated scales with word count:
- `<30 words` → 1 question
- `30–60 words` → 2 questions
- `>60 words` → up to 5 questions

Previously asked questions are passed to the AI so it does not repeat them.

### Stage 9: Atomic State Commit

All state updates — the watermark, gap list, last-window transcript, running transcript, last-range metadata, and (optionally) question state — are written in a **single LevelDB batch**. This prevents partial writes: a process crash cannot leave the watermark advanced without the corresponding transcript or question state.

If question generation fails, the pipeline does **not** commit the watermark, transcripts, last-range metadata, or question state, so the next pull retries the same audio range and attempts question generation again. Updated `known_gaps` may still be persisted on degraded exits so retry behavior keeps accurate gap-aging information.

---

## Part 3: State Stored Per Session

| Key | Description |
|-----|-------------|
| `transcribed_until_ms` | High-watermark: all audio before this point has been integrated. |
| `known_gaps` | List of observed timeline holes (startMs, endMs, firstObservedAtMs, status). |
| `last_transcribed_range` | Start/end/fragment-count of the new-audio region from the previous pull (used for overlap planning). |
| `last_window_transcript` | Raw transcript of the previous pull's window (used for LLM recombination). |
| `running_transcript` | Full accumulated session transcript (de-duplicated across all pulls). |
| `words_since_last_question` | Word count since the last question batch was generated. |
| `asked_questions` | All questions ever asked in this session (for deduplication). |
| `pending_questions` | Questions generated but not yet fetched by the client. |
| fragment index entries | Per-fragment timing/hash metadata (sequence, startMs, endMs, contentHash, …). |

---

## Part 4: Failure and Retry Semantics

The pipeline is designed so that every failure mode either retries automatically on the next pull or degrades gracefully:

| Failure | Outcome |
|---------|---------|
| Transcription timeout/failure | Return `degraded_transcription`; watermark not advanced; next pull retries. |
| Question generation timeout/failure | Return `degraded_question_generation`; watermark not advanced; next pull retries. |
| PCM assembly failure (format mismatch) | Return `degraded_transcription`; watermark not advanced. |
| Gap at watermark (fragment not yet uploaded) | Return `blocked_at_watermark`; gaps updated; next pull retries after more uploads. |
| Gap abandoned (fragment never arrived) | Cross with silence; `hasDegradedGap = true`; pull proceeds. |
| Duplicate fragment (below watermark) | Rejected with 409; `push-pcm` checks the live diary index before writing the binary chunk, so an already-transcribed chunk is never overwritten. |

---

## Part 5: Concurrency Model

Mutual exclusion is provided entirely by an **in-memory promise chain** (`processingQueues` Map keyed by session ID). All pull invocations for the same session are chained, so they execute one at a time within a single Node.js process. No database-level lock is used.

Push-pcm ingestion is awaited before responding to the client, guaranteeing the fragment index is durable before the client can trigger a pull.

---

## Part 6: Historical Note

The live diary pipeline was previously an eager, fixed-cadence design where transcription was triggered synchronously on every `push-pcm` call. That `service.js` implementation has been removed. The lazy pull architecture described in this document is now the only pipeline: uploads are indexed by `ingestFragment` and transcription/question generation happen on demand during `pullLiveDiaryProcessing`.
