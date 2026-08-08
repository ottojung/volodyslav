# Logical journal compaction

For entries `E1` and `E2`:

```text
E2 covers E1 iff
    E1.author == E2.author && E1.key == E2.key &&
    E1.action == E2.action && E2.sequence > E1.sequence
```

There is no cross-author coverage. `compact(S)` retains exactly the maximal
entry in every `(author,key,action)` coordinate and returns them in canonical
`JournalEntryId` order.

## Preservation proof

Replacing `E1` with covering `E2` preserves the action-specific
`possibleMaybeChanges` guarantee: both report the same key and exact action,
and a receiver allocates a new local delivery position for newly learned `E2`.
The API promises possible occurrence, not occurrence count or the older time.
Atomic append-or-replace delivery ensures a cursor before the replacement sees
the later covering record; a cursor after it has already crossed that record.
Receiver-local `DeliveryRecord`s are self-contained: compaction may remove the
logical entry named by an optional `causeId`, but the delivery retains its own
key, receiver-transition action, and copied time. Public cursor queries never
dereference the cause, so cross-action deliveries remain readable and retain
their exact notification coverage.

Every virtual projection is monotone under replacement:

* `valueHead(author,key)` uses the maximum sequence among that author's
  `add`/`edit` entries. Covering an add or edit replaces it by a strictly later
  entry of the same action, so that action's candidate maximum advances; the
  maximum across add and edit cannot move backward.
* `presenceHead(key)` is the greatest ID among all authors' add/delete maxima.
  Replacing either coordinate with a greater sequence cannot lower that maximum.
* the generation-establishing add and `freshnessHead(key)` are selected by
  greatest IDs. A replacement advances its coordinate. If it advances the add,
  older freshness history correctly falls before the new generation; otherwise
  the greatest post-add invalidate/validate cannot move backward.

Thus compaction preserves every retained head and all synchronization decisions
based on them. It also preserves exact key/action possible-change coverage.

### Trace

For author A and key K, `edit#4`, `edit#9`, `invalidate#6`, and `validate#8`
compact to `edit#9`, `invalidate#6`, and `validate#8`. The value head advances
from 4 to 9; the freshness maximum remains validate 8. If `invalidate#11`
arrives it covers invalidate 6 and becomes the freshness head. No projection
moves backward.
