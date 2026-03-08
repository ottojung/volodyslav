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

This means the association between an event and its files is reconstructed from:

- the event date
- the event id
- the directory layout inside the assets root

So the event is the conceptual owner of the files, and the filesystem layout is
the durable representation of that ownership.

## Graph flow

The graph flow should be read in two steps:

1. **Event-oriented navigation**
   - `all_events`
   - `event(e)`
   - `associated_audio(e)`

   This part answers:
   - “Which event are we talking about?”
   - “Which audio files are associated with that event?”

2. **Asset-oriented transcription**
   - `transcription(a)`

   Here `a` is one concrete relative path returned by the event-oriented step.
   This node answers:
   - “What is the AI transcription for this associated audio file?”

In human terms, the intended flow is:

`all_events -> event(e) -> associated audio path a -> transcription(a)`

## Why the split matters

`transcription(a)` should work with an already-associated audio path.
It should not rediscover the owning event by searching through `all_events`.

The association logic belongs in the event-oriented part of the graph.
The transcription logic belongs in the asset-oriented part of the graph.

This keeps responsibilities clear:

- event nodes identify which files belong to which event
- transcription nodes only transcribe a specific associated audio file

## Summary

- `all_events` is the root event collection
- `event(e)` picks one event
- `associated_audio(e)` lists audio files attached to that event
- each listed file path is relative to the assets root
- `transcription(a)` transcribes one such associated audio file
