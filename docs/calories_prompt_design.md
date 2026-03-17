---
title: Calories prompt design
---

# Calories prompt design

## Problem

Calorie estimation used to receive only a single event input. After introducing
`basic_context(e)`, the model now receives related events too, but a naïve
newline-joined payload makes the task ambiguous: the model can no longer tell
which event is the target and which lines are only supporting context.

The prompt must help the model:

- estimate calories for the target event only,
- use related events only for disambiguation,
- avoid summing unrelated context events,
- return a machine-parseable result.

## Design goals

1. Preserve the target event as the primary source of truth.
2. Let context help with ambiguous references like “same lunch” or omitted
   quantities.
3. Keep the output contract strict: integer or `N/A`.
4. Keep token cost modest.
5. Avoid prompt designs that encourage prose, chain-of-thought, or unstable
   formatting.

## Approaches considered

### Option A: Short prompt with raw joined context

Example payload:

```text
food: lunch
text: same as yesterday
```

**Pros**

- Minimal code changes
- Small token footprint

**Cons**

- Does not identify the target event
- Encourages accidental calorie summation across context events
- Weak guidance for ambiguous references

## Option B: Longer system prompt, but still raw joined context

This improves instructions but keeps the user payload unstructured.

**Pros**

- Better than Option A for output discipline
- Still simple to implement

**Cons**

- The model still has to infer which line is the actual target event
- Important distinctions live only in instructions, not in the data layout

## Option C: Structured target/context prompt with strict output contract

Example payload:

```text
Target event:
food: sandwich

Basic context (related events for disambiguation only):
1. text prep #lunch
2. text same bread as yesterday
```

**Pros**

- Makes the target event explicit
- Clearly separates context from the event being scored
- Supports disambiguation without encouraging over-counting
- Easy to test
- Low implementation risk

**Cons**

- Slightly larger prompt than raw joined text

## Option D: Few-shot prompt with many examples

**Pros**

- Could improve edge-case accuracy

**Cons**

- Higher token cost
- Harder to maintain
- Risks overfitting to examples
- Not necessary for the current scope

## Decision

Choose **Option C**.

It gives the model the most important missing signal — which event is the
target — while staying compact and deterministic. It also maps naturally onto
the new graph dependency `basic_context(e) -> calories(e)`.

## Chosen prompt design

### System prompt responsibilities

The system prompt should:

- define the target/context distinction,
- say that calories are for the target event only,
- allow context to resolve ambiguity,
- forbid counting separate context events,
- preserve the `integer | N/A` response contract.

### User payload responsibilities

The user payload should:

- show the target event in its own section,
- list related context events separately,
- explicitly label context as disambiguation-only.
- be rendered inside the AI module from the raw target event plus raw context
  events, rather than pre-rendered upstream.

## Expected benefits

- Better handling of references like “same lunch”, “another cup”, or
  preparation notes near the target event.
- Lower risk that the model totals calories across multiple context events.
- Better testability because the prompt format is explicit and stable.
