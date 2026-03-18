---
title: Type and modifier ontology
---

# Type and modifier ontology

## Problem

Computors such as `calories(e)` can already see:

- the parsed event type,
- the parsed modifiers,
- the free-text description,
- and, in some cases, a "basic context" made from related events.

That is enough to parse structure, but not enough to know the intended defaults of
tokens such as `food` or `when`.

For example, `food banana` leaves several meaningful questions open:

- Was the banana consumed, prepared, bought, or merely observed?
- Was it eaten in full, or only partly?
- Was it eaten in one sitting, or over a long period?
- Is the description about one item, or a whole batch?

Humans can often infer the answer from habits, but a computor should not have to
guess hidden conventions.

## What exists today

The current input format is:

```text
TYPE [MODIFIERS...] DESCRIPTION
```

Today this gives us syntax, not ontology:

- `TYPE` is an open string namespace.
- modifiers are an open key/value namespace.
- unknown types and modifiers are still parseable.
- modifiers must appear before the description.
- the parser stores modifiers as a plain key/value object.

There is also a small set of special context-enhancing types such as `text`,
`register`, and `photo`. These help build hashtag-based context for other
events, but they do **not** currently define the meaning of arbitrary tokens like
`food` or `when`.

That distinction matters: ontology is global token meaning, while `text` entries
are event data.

## Goals

An ontology layer should:

1. explain what a type or modifier means,
2. state its defaults explicitly,
3. stay backwards-compatible with the current event syntax,
4. allow unknown tokens to continue working,
5. be compact enough to feed into AI-backed computors when relevant,
6. help both users and computors, not just one of them.

## Non-goals

This design should **not** require:

- replacing the existing input syntax,
- validating every event against a closed vocabulary,
- forcing all users to define every token in advance,
- moving all semantics into prompts only.

## Approaches considered

### Option A: Documentation-only page

Keep the ontology purely in `docs/ontology.md`.

### Pros

- zero runtime changes,
- easy to write and review,
- useful immediately for human users.

### Cons

- computors cannot consume it directly,
- easy for docs and real usage to drift apart,
- no natural way to show only the ontology relevant to the current event.

This option is still worth doing now, but it should not be the final form if the
goal is to help computors.

### Option B: Special ontology events in the log

Introduce dedicated entries analogous in spirit to `text`, but aimed at token
meaning, for example:

```text
ontology_type food default means consumed by one person in one eating occasion
ontology_modifier when refers to event time, not logging time
```

### Pros

- versioned together with the rest of the log,
- editable through the same workflows as ordinary entries,
- could be included in context for AI systems.

### Cons

- ontology is global, while event context today is hashtag-scoped,
- hard to guarantee uniqueness or resolve conflicts,
- harder to query deterministically than a structured file,
- encourages free-form definitions where machines would prefer structure.

This is the closest match to the original intuition, but it is a poor primary
source of truth because ontology should be global and stable rather than
accidentally discovered from nearby events.

### Option C: Structured ontology file

Store ontology in a dedicated machine-readable file, for example JSON or a small
JavaScript module, with separate sections for types and modifiers.

Example shape:

```json
{
  "types": {
    "food": {
      "meaning": "Consumption of food or drink.",
      "defaults": [
        "Describes what was consumed, not what was bought or prepared.",
        "Assume one eating/drinking occasion unless stated otherwise.",
        "Assume the consumed amount, not leftovers."
      ],
      "askUsersToSpecify": [
        "portion size",
        "shared vs solo consumption",
        "spread over time vs one sitting"
      ]
    }
  },
  "modifiers": {
    "when": {
      "meaning": "When the event happened.",
      "defaults": [
        "Refers to occurrence time, not logging time."
      ]
    }
  }
}
```

### Pros

- machine-readable,
- easy to test,
- easy to expose in UI or API,
- easy to inject only the relevant parts into AI prompts,
- keeps existing event syntax unchanged.

### Cons

- requires schema design and maintenance,
- less ad hoc than writing plain `text` events,
- needs a deliberate place in configuration or repository data.

### Option D: Hybrid design

Use a structured ontology file as the source of truth, and generate human-facing
documentation from it.

### Pros

- one canonical definition for both humans and computors,
- easy to render in docs and frontend help,
- easy to provide only the relevant slice to a computor,
- avoids ontology drift better than free-form notes.

### Cons

- slightly more implementation work than a docs-only solution.

## Recommended direction

Choose **Option D**:

1. keep this document as the design explanation,
2. later add a structured ontology registry as the source of truth,
3. have computors load only the ontology entries relevant to the current event,
4. optionally render the same registry in the UI and documentation.

This keeps the current parser untouched while creating a clean upgrade path from
"human documentation" to "machine-consumable semantics".

## Recommended implementation design

The future runtime design should look like this:

1. **Parse as today**  
   Continue parsing `TYPE [MODIFIERS...] DESCRIPTION` exactly as now.

2. **Load ontology separately**  
   Read a repository-level ontology registry that documents known types and
   modifiers.

3. **Select only relevant ontology**  
   For a target event, provide:
   - the ontology entry for its type,
   - the ontology entries for modifiers actually present on the event,
   - optional global notes shared by all events.

4. **Feed that slice into computors**  
   AI-backed computors such as calories estimation should receive a compact
   section like:

   ```text
   Ontology:
   - type food: means consumed food or drink; default is one eating occasion
   - modifier when: refers to when the event happened, not when it was logged
   ```

5. **Do not make ontology a hard validator at first**  
   Unknown tokens should still parse and store normally. Missing ontology should
   reduce guidance, not block data entry.

## Suggested ontology fields

Each type or modifier definition should preferably include:

- `meaning`: short plain-language definition,
- `defaults`: what is assumed when the entry does not say more,
- `askUsersToSpecify`: missing details that often matter,
- `examples`: well-formed examples,
- `notes`: optional caveats,
- `scope`: for modifiers, whether they apply broadly or only to some types.

The most important part is **defaults**. Ontology is most valuable when it says
what an omitted detail means.

## Suggestions for users

Users should write entries as if the computor will **not** guess their private
conventions correctly.

### 1. Prefer tokens with one stable meaning

Good token names are narrow and reusable.

- Better: `food`, `meal_prep`, `purchase`
- Worse: using `food` sometimes for eating, sometimes for buying, sometimes for cooking

### 2. Document defaults, not just examples

For `food`, a useful ontology entry is not merely "banana, pizza, tea". It
should say what `food X` means by default.

Example defaults worth documenting:

- consumed rather than prepared or bought,
- one eating/drinking occasion,
- the amount actually consumed,
- one person's intake unless stated otherwise.

### 3. Use modifiers when they change interpretation

If timing, certainty, duration, sharing, or quantity changes the meaning in a
way a computor cares about, prefer an explicit modifier or explicit text.

Examples:

- `food [when 0 hours ago] banana`
- `food [duration 6 hours] trail mix`
- `food [shared yes] pizza`
- `food half a banana`

### 4. Put important deviations in the entry itself

Even with ontology, event text should still mention major exceptions to the
default.

- Better: `food half a banana`
- Better: `food salad shared with Alex`
- Worse: relying on the computor to infer leftovers, sharing, or grazing

### 5. Use `when` only for event time

`[when ...]` should mean when the event happened, not when it was entered into
the system. That keeps the modifier interpretable across all computors.

### 6. Separate category from commentary

Use the type and modifiers for stable structure, and keep the description for
the event-specific detail.

- Better: `food [when yesterday evening] pasta with cream sauce`
- Worse: `thing maybe dinner maybe yesterday`

## Practical advice for confusing tokens

If a token causes repeated ambiguity, the first fix should usually be one of:

1. narrow the type,
2. add a dedicated modifier,
3. state the default in the ontology,
4. add an explicit override in the event text.

For example, if `food` is too broad, it may be better to keep:

- `food` for consumption,
- `meal_prep` for preparing food,
- `purchase` for buying food,

rather than making one type carry three meanings.

## Decision summary

- Write the design down now in documentation.
- Treat ontology as a separate semantic layer over the current parser.
- Prefer a structured registry over ontology-as-events.
- Keep the system open-vocabulary and backwards-compatible.
- Teach users to make defaults explicit whenever hidden assumptions matter.
