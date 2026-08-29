#!/usr/bin/env python3
"""Bounded executable checks for the causal IncrementalGraph journal model."""

from dataclasses import dataclass, field
from itertools import combinations, product
from typing import Iterable, Mapping


Prefix = Mapping[str, int]


@dataclass(frozen=True)
class Event:
    author: str
    sequence: int
    kind: str
    time: int = 0
    context: Prefix = field(default_factory=dict)
    generation: tuple[str, int] | None = None
    value_origin: tuple[str, int] | None = None
    mode: str | None = None
    clears: Prefix = field(default_factory=dict)
    absorbs: Prefix = field(default_factory=dict)
    anchor: str | None = None

    @property
    def id(self) -> tuple[str, int]:
        return self.author, self.sequence

    def __hash__(self) -> int:
        return hash(self.id)


def coordinate(prefix: Prefix, author: str) -> int:
    return prefix.get(author, 0)


def join_prefixes(*prefixes: Prefix) -> dict[str, int]:
    result: dict[str, int] = {}
    for prefix in prefixes:
        for author, value in prefix.items():
            result[author] = max(result.get(author, 0), value)
    return result


def observed_prefix(events: Iterable[Event], prior: Prefix = {}) -> dict[str, int]:
    """Close observation over event identities and their transitive contexts."""
    result = dict(prior)
    for event in events:
        result = join_prefixes(result, event.context, {event.author: event.sequence})
    return result


def author_event(author: str, sequence: int, kind: str, *, observed=(),
                 prior: Prefix = {}, **kwargs) -> Event:
    context = observed_prefix(observed, prior)
    return Event(author, sequence, kind, context=context, **kwargs)


def next_local_sequence(counter: int, _foreign_events: Iterable[Event] = ()) -> int:
    """Allocate only in the caller's local namespace."""
    return counter + 1


def causally_before(left: Event, right: Event) -> bool:
    if left.id == right.id:
        return False
    if left.author == right.author:
        return left.sequence < right.sequence
    return left.sequence <= coordinate(right.context, left.author)


def causal_maxima(events: Iterable[Event]) -> tuple[Event, ...]:
    values = tuple(events)
    return tuple(event for event in values
                 if not any(causally_before(event, other) for other in values))


def concurrent_conflict_selection(events: Iterable[Event]) -> Event | None:
    """Select only after causal_maxima; key contains no sequence."""
    values = tuple(events)
    return max(values, key=lambda event: (event.time, event.author), default=None)


def same_author_head(events: Iterable[Event], author: str) -> Event | None:
    values = [event for event in events if event.author == author]
    return max(values, key=lambda event: event.sequence, default=None)


def presence_selection(events: Iterable[Event]) -> Event | None:
    eligible = [event for event in events if event.kind in {"generation", "delete"}]
    return concurrent_conflict_selection(causal_maxima(eligible))


def equal_time_value_canonicalization(events: Iterable[Event], time: int) -> Event | None:
    candidates = [event for event in events
                  if event.kind in {"generation", "edit"} and event.time == time]
    return concurrent_conflict_selection(causal_maxima(candidates))


def value_selection(events: Iterable[Event]) -> Event | None:
    candidates = [event for event in events if event.kind in {"generation", "edit"}]
    heads = [same_author_head(candidates, author)
             for author in {event.author for event in candidates}]
    return concurrent_conflict_selection(causal_maxima(event for event in heads if event))


def invalidate_frontier(events: Iterable[Event], hard_only=False) -> tuple[Event, ...]:
    invalidates = [event for event in events if event.kind == "invalidate"
                   and (not hard_only or event.mode == "hard")]
    return tuple(head for author in {event.author for event in invalidates}
                 if (head := same_author_head(invalidates, author)) is not None)


def covers(validation: Event, invalidate: Event) -> bool:
    return invalidate.sequence <= coordinate(validation.clears, invalidate.author)


def freshness(events: Iterable[Event]) -> str:
    values = tuple(events)
    all_frontier = invalidate_frontier(values)
    hard_frontier = invalidate_frontier(values, hard_only=True)
    validations = [event for event in values if event.kind == "validate"]
    if any(all(covers(validation, invalidate) for invalidate in all_frontier)
           for validation in validations):
        return "fresh"
    if hard_frontier and not any(
            all(covers(validation, invalidate) for invalidate in hard_frontier)
            for validation in validations):
        return "hard"
    return "soft"


def absorbed(lineage: Event, event: Event) -> bool:
    return event.sequence <= coordinate(lineage.absorbs, event.author)


def reset_assertion_selection(events: Iterable[Event]) -> Event | None:
    assertions = [event for event in events if event.kind == "reset"]
    return concurrent_conflict_selection(causal_maxima(assertions))


def compact(events: Iterable[Event]) -> frozenset[Event]:
    """Small representative compactor preserving causal/frontier/reset seeds."""
    values = frozenset(events)
    keep: set[Event] = set(causal_maxima(values))
    for author, kind in product({e.author for e in values}, {e.kind for e in values}):
        head = same_author_head((e for e in values if e.kind == kind), author)
        if head:
            keep.add(head)
    keep.update(invalidate_frontier(values))
    keep.update(invalidate_frontier(values, hard_only=True))
    keep.update(causal_maxima(e for e in values if e.kind == "reset"))
    # Retain exact referenced origins/generations and context witnesses when present.
    referenced = {reference for event in keep
                  for reference in (event.generation, event.value_origin)
                  if reference is not None}
    keep.update(event for event in values if event.id in referenced)
    return frozenset(keep)


def verify_local_sequence_isolation() -> None:
    foreign = Event("A", 1_000_000, "edit")
    assert next_local_sequence(4, [foreign]) == 5


def verify_presence() -> None:
    add = Event("A", 100, "generation", time=10)
    delete = author_event("B", 2, "delete", observed=[add], time=11)
    assert causally_before(add, delete)
    assert presence_selection([add, delete]) == delete

    concurrent_late = Event("B", 2, "generation", time=20)
    assert not causally_before(add, concurrent_late)
    assert presence_selection([add, concurrent_late]) == concurrent_late

    equal_a = Event("A", 100, "generation", time=30)
    equal_b = Event("B", 2, "generation", time=30)
    assert presence_selection([equal_a, equal_b]) == equal_b


def verify_values() -> None:
    first = Event("A", 100, "edit", time=50)
    later = author_event("B", 2, "edit", observed=[first], time=50)
    assert equal_time_value_canonicalization([first, later], 50) == later

    concurrent_old = Event("A", 100, "edit", time=40)
    concurrent_new = Event("B", 2, "edit", time=50)
    assert value_selection([concurrent_old, concurrent_new]) == concurrent_new
    tie_a = Event("A", 100, "edit", time=50)
    tie_b = Event("B", 2, "edit", time=50)
    assert value_selection([tie_a, tie_b]) == tie_b


def verify_transitive_context() -> None:
    a = Event("A", 10, "edit")
    b = author_event("B", 3, "edit", observed=[a])
    c = author_event("C", 7, "edit", observed=[b])
    assert coordinate(b.context, "A") == 10
    assert coordinate(c.context, "A") == 10
    assert causally_before(a, c)


def verify_freshness() -> None:
    soft_a = Event("A", 9, "invalidate", mode="hard")
    hard_b = Event("B", 2, "invalidate", mode="hard")
    partial_a = Event("C", 1, "validate", clears={"A": 9})
    partial_b = Event("D", 1, "validate", clears={"B": 2})
    assert freshness([soft_a, hard_b, partial_a, partial_b]) == "hard"
    clearing = Event("C", 2, "validate", clears={"A": 9, "B": 2})
    assert freshness([soft_a, hard_b, clearing]) == "fresh"
    later_soft = Event("B", 3, "invalidate", mode="soft")
    assert freshness([hard_b, clearing, later_soft]) == "soft"


def verify_sync_hardening_and_delete_chain() -> None:
    positive = Event("A", 1_000_000, "generation", time=1)
    hard = author_event("B", 2, "invalidate", observed=[positive], mode="hard")
    assert causally_before(positive, hard)

    add_a = Event("A", 100, "generation", time=1)
    delete_b = author_event("B", 2, "delete", observed=[add_a], time=2)
    add_c = Event("C", 1, "generation", time=3)
    delete_b2 = author_event("B", 3, "delete", observed=[delete_b, add_c],
                             prior=delete_b.context, time=4)
    assert presence_selection([add_a, delete_b, add_c, delete_b2]) == delete_b2
    assert causally_before(add_c, delete_b2)


def verify_reset() -> None:
    reset = Event("R", 5000, "reset", time=10, absorbs={"A": 10})
    old = Event("A", 10, "generation", time=1)
    live = Event("A", 11, "delete", time=11)
    assert absorbed(reset, old)
    assert not absorbed(reset, live)

    first = Event("A", 100, "reset", time=20, anchor="x")
    successor = author_event("B", 2, "reset", observed=[first], time=20, anchor="y")
    assert reset_assertion_selection([first, successor]) == successor

    concurrent_a = Event("A", 100, "reset", time=20, anchor="x")
    concurrent_b = Event("B", 2, "reset", time=20, anchor="y")
    assert reset_assertion_selection([concurrent_a, concurrent_b]) == concurrent_b
    assert reset_assertion_selection([concurrent_b, concurrent_a]) == concurrent_b


def verify_causality_laws() -> None:
    authors = ("A", "B", "C")
    events = [Event(author, sequence, "edit")
              for author in authors for sequence in (1, 2)]
    for left, right in combinations(events, 2):
        assert not (causally_before(left, right) and causally_before(right, left))
    # Reachable three-writer context propagation is transitive.
    for a_sequence, b_sequence, c_sequence in product((1, 2), repeat=3):
        a = Event("A", a_sequence, "edit")
        b = author_event("B", b_sequence, "edit", observed=[a])
        c = author_event("C", c_sequence, "edit", observed=[b])
        assert causally_before(a, b) and causally_before(b, c)
        assert causally_before(a, c)


def verify_compaction_future_union() -> None:
    a1 = Event("A", 1, "generation", time=1)
    b1 = author_event("B", 1, "delete", observed=[a1], time=2)
    hard = Event("A", 2, "invalidate", mode="hard")
    validation = Event("B", 2, "validate", clears={"A": 2})
    reset = Event("C", 1, "reset", time=3, absorbs={"A": 2, "B": 2})
    delayed = Event("A", 3, "edit", time=4)
    histories = [
        ({a1, b1}, {delayed}),
        ({a1, hard, validation}, {delayed}),
        ({a1, b1, reset}, {hard}),
        ({a1, hard}, {validation, reset}),
    ]
    for left, right in histories:
        assert compact(compact(left) | right) == compact(left | right)


def main() -> None:
    verify_local_sequence_isolation()
    verify_presence()
    verify_values()
    verify_transitive_context()
    verify_freshness()
    verify_sync_hardening_and_delete_chain()
    verify_reset()
    verify_causality_laws()
    verify_compaction_future_union()
    print("journal causal-context model: all bounded checks passed")


if __name__ == "__main__":
    main()
