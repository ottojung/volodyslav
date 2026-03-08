# Transcription Graph Flow

This document describes the high-level concepts behind the transcription flow in
the incremental graph.

## Core concepts

- `all_events`
  - The full list of events currently present in the event log.
  - This is the graph entry point for event-derived computations.

- `event(e)`
  - A single event selected from `all_events` by event id `e`.
  - This is the point where the graph stops talking about the whole log and
    starts talking about one concrete user event.

- Associated files
  - An event may have files attached to it.
  - Those files are not stored inline inside the event JSON object.
  - Instead, the association is represented by where the files are stored in the
    assets repository.

## How event-to-file association works

When an event is written with files, the system creates `Asset` objects that pair:

- the event
- the original uploaded file

When the transaction commits, each asset is copied into the assets root using a
deterministic path:

`<assets root>/<YYYY-MM>/<DD>/<event id>/<filename>`

This means the association between an event and its files can be validated from:

- the event date
- the event id
- the audio file path

So the event is the conceptual owner of the files, and the filesystem layout is
the durable representation of that ownership.

## Graph adjacency

```
all_events -> event(e)
transcription(a)
event(e), transcription(a) -> event_transcription(e, a)
```

- `all_events -> event(e)`: selects one event from the full event log by id.

- `transcription(a)`: standalone node that takes an audio file path `a`
  (relative to the assets root) and returns an AI transcription of that file.
  It has no dependencies on events.

- `event(e), transcription(a) -> event_transcription(e, a)`: combines the
  event `e` and the transcription of audio path `a`, after validating that `a`
  is an audio file belonging to event `e`.

## Node descriptions

### `transcription(a)`

- `a` is a path to an audio file, relative to the event-log assets root.
- The node resolves the path, validates it does not escape the assets root, and
  calls the AI transcription module.
- It is standalone: it does not depend on events and can be pulled independently.
- Its result is cached; a second pull with the same `a` returns the cached value.

### `event_transcription(e, a)`

- `e` is an event id.
- `a` is a path to an audio file, relative to the event-log assets root.
- The node depends on both `event(e)` and `transcription(a)`.
- Before returning, it validates that `a` is an audio file belonging to `e`
  by checking that the path prefix matches the canonical layout for that event:
  `<YYYY-MM>/<DD>/<e>/`.
- Returns both the event and the transcription together.

## Why this split matters

`transcription(a)` is a pure asset-level computation.  It does not need to know
which event owns the file.

`event_transcription(e, a)` is the node that expresses the ownership relationship.
It brings the two independent sub-graphs together and validates the association.

This keeps responsibilities clear:

- `event(e)` represents the event in the graph.
- `transcription(a)` transcribes a specific audio file.
- `event_transcription(e, a)` ties them together with an explicit ownership check.

## Usage example

```js
const result = await iface._incrementalGraph.pull(
    "event_transcription",
    ["12345", "2024-01/01/12345/memo.mp3"]
);

// => {
//      type: "event_transcription",
//      event: { id: { identifier: "12345" }, ... },
//      transcription: {
//          text: "...",
//          transcriber: { name: "...", creator: "..." },
//          creator: { ... }
//      }
//    }
```
