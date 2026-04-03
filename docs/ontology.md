# Ontology

## What is the Ontology?

The ontology is a user-defined glossary that explains **how you create log entries** — your personal conventions, assumed defaults, and units. It is stored as a JSON document and surfaced to AI computors (such as the calories estimator) so they can interpret your entries accurately.

Think of it as documentation you write for yourself *and* for the AI. Because the AI never observes you in the world, it can only infer meaning from the text you type. The ontology fills in the gaps: what assumptions you make when logging, what units you use, what defaults apply, and what things you typically omit.

## Shape

```json
{
  "types": [
    {
      "name": "food",
      "description": "..."
    }
  ],
  "modifiers": [
    {
      "name": "when",
      "description": "..."
    },
    {
      "name": "duration",
      "only_for_type": "food",
      "description": "..."
    }
  ]
}
```

### `types`

Each entry in `types` documents an entry **type** — the first word of a log entry.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | The type keyword as it appears in entries (e.g. `food`, `weight`, `sleep`) |
| `description` | yes | A prose description of what this type means and how you use it |

### `modifiers`

Each entry in `modifiers` documents a **modifier** — a bracketed annotation like `[when 1 hour ago]` or `[duration 15 min]`.

| Field | Required | Meaning |
|-------|----------|---------|
| `name` | yes | The modifier keyword (e.g. `when`, `duration`, `amount`) |
| `description` | yes | A prose description of what this modifier means, its unit, and its defaults |
| `only_for_type` | no | If set, the modifier is only meaningful for entries of this type |

## How It Is Used

After the basic context of an event is resolved, the ontology is fetched. Only the entries relevant to the **types present in the context** are forwarded to the AI, avoiding irrelevant noise. Entries for the same type are deduplicated — if two `food` events appear in context, the `food` type description is included only once.

The resulting text is appended to the AI prompt under the heading **"User's logging conventions"**, giving the model precise guidance for interpreting your entries.

## What to Write

The goal is to give the AI enough context to resolve ambiguities that are obvious to you but invisible from the text alone.

### Type descriptions

For each type, consider describing:

- **What the entry represents** (e.g. "a food or drink item consumed by the user")
- **Default assumptions** (e.g. "the full listed portion is assumed to have been consumed unless otherwise noted")
- **What is *not* logged** (e.g. "water is not separately logged; assume typical hydration")
- **Units** (e.g. "weight is always in kilograms, not pounds")
- **Logging fidelity** (e.g. "entries are usually approximate; exact measurements are rare")

### Modifier descriptions

For each modifier, consider describing:

- **Semantic meaning** (e.g. "`[when X]` means the event occurred X before the log entry was written, not at log-writing time")
- **Units and formats** (e.g. "`[duration X]` accepts expressions like '10 min', '1 hour', '90 min'")
- **Defaults when absent** (e.g. "if `[when]` is absent, the event is assumed to have occurred at the time of logging")

## Examples

### Minimal

```json
{
  "types": [
    {
      "name": "food",
      "description": "Something eaten or drunk. Full consumption is assumed unless noted. Water is not logged."
    }
  ],
  "modifiers": [
    {
      "name": "when",
      "description": "How long before logging the event occurred, e.g. '[when 1 hour ago]'."
    }
  ]
}
```

### Richer

```json
{
  "types": [
    {
      "name": "food",
      "description": "A food or drink item consumed by the user. The full listed portion is assumed consumed unless the entry says 'half', 'bite', etc. Water and plain tea are not logged. Alcohol is logged as a food entry."
    },
    {
      "name": "weight",
      "description": "The user's body weight, measured in kilograms on an empty stomach in the morning."
    },
    {
      "name": "sleep",
      "description": "A sleep period. The number after 'sleep' is duration in hours."
    }
  ],
  "modifiers": [
    {
      "name": "when",
      "description": "Time offset from the moment of logging. '[when 2 hours ago]' means the event happened 2 hours before the entry was written. If absent, the event happened at logging time."
    },
    {
      "name": "duration",
      "only_for_type": "food",
      "description": "How long the meal took. '[duration 20 min]' means eating lasted 20 minutes. Not relevant to calorie estimates."
    }
  ]
}
```

## Editing the Ontology

Navigate to **Manage Ontology** from the home screen. You can add, edit, or remove type and modifier entries, then click **Save Ontology**. Changes take effect for all future AI computations. Cached calorie estimates for existing events are automatically invalidated when the ontology changes.
