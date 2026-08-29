#!/usr/bin/env python3
"""Bounded executable model of the normative causal journal selectors."""

from dataclasses import dataclass, field
from itertools import combinations
from typing import Iterable, Mapping

Prefix = Mapping[str, int]
EntryId = tuple[str, int]
NodeKey = tuple[str, tuple[str, ...]]
Anchor = tuple[str, EntryId | None]  # null, delete, or present(value origin)
Correspondence = tuple[EntryId, EntryId]  # source generation and value origin


def coordinate(prefix: Prefix, author: str) -> int:
    return prefix.get(author, 0)


def join_prefixes(*prefixes: Prefix) -> dict[str, int]:
    result: dict[str, int] = {}
    for prefix in prefixes:
        for author, value in prefix.items():
            result[author] = max(result.get(author, 0), value)
    return result


@dataclass(frozen=True)
class Event:
    author: str
    sequence: int
    node: NodeKey
    kind: str
    time: int = 0
    causal_context: Prefix = field(default_factory=dict)
    generation: EntryId | None = None
    value_origin: EntryId | None = None
    applies_to: str | EntryId | None = None  # "generation" or exact origin
    mode: str | None = None
    clears_through: Prefix = field(default_factory=dict)
    reset_anchor: Anchor | None = None
    absorbs_through: Prefix = field(default_factory=dict)
    correspondence: Correspondence | None = None

    @property
    def id(self) -> EntryId:
        return self.author, self.sequence

    @property
    def public_action(self) -> str | None:
        if self.kind == "generation":
            return "add"
        if self.kind == "reset-observation":
            return None
        if self.kind == "invalidate":
            return "invalidate"
        if self.kind == "reset":
            return None
        return self.kind

    def __hash__(self) -> int:
        return hash(self.id)


@dataclass
class Replica:
    author: str
    journal: dict[EntryId, Event] = field(default_factory=dict)
    causal_summary: dict[str, int] = field(default_factory=dict)
    journal_coverage: dict[str, int] = field(default_factory=dict)
    local_counter: int = 0


def causally_before(left: Event, right: Event) -> bool:
    if left.id == right.id:
        return False
    if left.author == right.author:
        return left.sequence < right.sequence
    return left.sequence <= coordinate(right.causal_context, left.author)


def causal_maxima(events: Iterable[Event]) -> tuple[Event, ...]:
    values = tuple(events)
    return tuple(event for event in values
                 if not any(causally_before(event, other) for other in values))


def concurrent_winner(events: Iterable[Event]) -> Event | None:
    """Call only on causal maxima; foreign sequences are absent from the key."""
    return max(tuple(events), key=lambda event: (event.time, event.author), default=None)


def observed_events_prefix(events: Iterable[Event]) -> dict[str, int]:
    result: dict[str, int] = {}
    for event in events:
        result = join_prefixes(
            result, event.causal_context, {event.author: event.sequence})
    return result


def observed_source(source: Replica) -> dict[str, int]:
    return join_prefixes(
        source.causal_summary, observed_events_prefix(source.journal.values()))


def receive(receiver: Replica, source: Replica) -> bool:
    """Atomic import and causal observation; never allocates a local event."""
    before = (dict(receiver.journal), dict(receiver.journal_coverage),
              dict(receiver.causal_summary), receiver.local_counter)
    for event_id, event in source.journal.items():
        if event_id in receiver.journal:
            assert receiver.journal[event_id] == event
        receiver.journal[event_id] = event
    receiver.journal_coverage = join_prefixes(
        receiver.journal_coverage, source.journal_coverage)
    receiver.causal_summary = join_prefixes(
        receiver.causal_summary, observed_source(source))
    after = (receiver.journal, receiver.journal_coverage,
             receiver.causal_summary, receiver.local_counter)
    return before != after


def author_event(replica: Replica, node: NodeKey, kind: str, **fields) -> Event:
    replica.local_counter += 1
    event = Event(replica.author, replica.local_counter, node, kind,
                  causal_context=dict(replica.causal_summary), **fields)
    replica.journal[event.id] = event
    replica.journal_coverage[replica.author] = replica.local_counter
    replica.causal_summary = join_prefixes(
        replica.causal_summary, {replica.author: event.sequence})
    return event


def same_author_head(events: Iterable[Event], author: str) -> Event | None:
    values = [event for event in events if event.author == author]
    return max(values, key=lambda event: event.sequence, default=None)


def per_author_heads(events: Iterable[Event]) -> tuple[Event, ...]:
    values = tuple(events)
    return tuple(head for author in sorted({event.author for event in values})
                 if (head := same_author_head(values, author)) is not None)


def generation_event(journal: Iterable[Event], generation: EntryId) -> Event:
    return next(event for event in journal
                if event.id == generation and event.kind == "generation")


def value_events(journal: Iterable[Event], node: NodeKey,
                 generation: EntryId) -> tuple[Event, ...]:
    return tuple(event for event in journal if event.node == node and (
        event.id == generation or
        event.kind == "edit" and event.generation == generation))


def value_selection(journal: Iterable[Event], node: NodeKey,
                    generation: EntryId) -> Event | None:
    heads = per_author_heads(value_events(journal, node, generation))
    return concurrent_winner(causal_maxima(heads))


def equal_time_value_canonicalization(journal: Iterable[Event], node: NodeKey,
                                      generation: EntryId, time: int) -> Event | None:
    heads = per_author_heads(event for event in value_events(journal, node, generation)
                             if event.time == time)
    return concurrent_winner(causal_maxima(heads))


def anchor_presence(journal: Iterable[Event], node: NodeKey,
                    anchor: Anchor) -> Event | None:
    tag, reference = anchor
    if tag == "null":
        return None
    if tag == "delete":
        return next(event for event in journal
                    if event.node == node and event.id == reference
                    and event.kind == "delete")
    assert tag == "present" and reference is not None
    origin = next(event for event in journal
                  if event.node == node and event.id == reference)
    generation = origin.id if origin.kind == "generation" else origin.generation
    assert generation is not None
    return generation_event(journal, generation)


def anchor_groups(journal: Iterable[Event], node: NodeKey) -> dict[Anchor, tuple[Event, ...]]:
    groups: dict[Anchor, list[Event]] = {}
    for event in journal:
        if event.node == node and event.reset_anchor is not None:
            groups.setdefault(event.reset_anchor, []).append(event)
    return {anchor: tuple(carriers) for anchor, carriers in groups.items()}


def anchor_cut(carriers: Iterable[Event]) -> dict[str, int]:
    return join_prefixes(*(carrier.absorbs_through for carrier in carriers))


def presence_events(journal: Iterable[Event], node: NodeKey) -> tuple[Event, ...]:
    return tuple(event for event in journal
                 if event.node == node and event.kind in {"generation", "delete"})


def anchor_is_applicable(journal: Iterable[Event], node: NodeKey,
                         anchor: Anchor, carriers: Iterable[Event]) -> bool:
    witness = anchor_presence(journal, node, anchor)
    displacements = [event for event in presence_events(journal, node)
                     if witness is None or event.id != witness.id]
    cut = anchor_cut(carriers)
    return all(event.sequence <= coordinate(cut, event.author)
               for event in causal_maxima(displacements))


def applicable_anchor_groups(journal: Iterable[Event], node: NodeKey
                             ) -> dict[Anchor, tuple[Event, ...]]:
    values = tuple(journal)
    return {anchor: carriers for anchor, carriers in anchor_groups(values, node).items()
            if anchor_is_applicable(values, node, anchor, carriers)}


def applicable_cut(journal: Iterable[Event], node: NodeKey) -> dict[str, int]:
    groups = applicable_anchor_groups(journal, node)
    return join_prefixes(*(anchor_cut(carriers) for carriers in groups.values()))


def activated_generations(journal: Iterable[Event], node: NodeKey,
                          cut: Prefix) -> set[EntryId]:
    result: set[EntryId] = set()
    for event in journal:
        if (event.node == node and event.generation is not None
                and event.kind in {"edit", "invalidate", "validate"}
                and event.reset_anchor is None
                and event.sequence > coordinate(cut, event.author)):
            result.add(event.generation)
    return result


def fallback_antichain(journal: Iterable[Event], node: NodeKey) -> tuple[Event, ...]:
    groups = applicable_anchor_groups(journal, node)
    return causal_maxima(carrier for carriers in groups.values() for carrier in carriers)


def fallback_selection(journal: Iterable[Event], node: NodeKey) -> Event | None:
    return concurrent_winner(fallback_antichain(journal, node))


def eligible_presence_events(journal: Iterable[Event], node: NodeKey) -> tuple[Event, ...]:
    values = tuple(journal)
    groups = applicable_anchor_groups(values, node)
    cut = applicable_cut(values, node)
    excluded_witnesses = {
        witness.id for anchor in groups
        if (witness := anchor_presence(values, node, anchor)) is not None
    }
    activated = activated_generations(values, node, cut)
    return tuple(event for event in presence_events(values, node)
                 if ((event.sequence > coordinate(cut, event.author)
                      and event.id not in excluded_witnesses)
                     or event.kind == "generation" and event.id in activated))


def presence_selection(journal: Iterable[Event], node: NodeKey) -> Event | None:
    values = tuple(journal)
    head = concurrent_winner(causal_maxima(eligible_presence_events(values, node)))
    if head is not None:
        return head
    fallback = concurrent_winner(fallback_antichain(values, node))
    if fallback is None:
        return None
    return anchor_presence(values, node, fallback.reset_anchor)  # type: ignore[arg-type]


def invalidate_applies(event: Event, origin: EntryId) -> bool:
    return event.applies_to == "generation" or event.applies_to == origin


def invalidate_frontier(journal: Iterable[Event], node: NodeKey,
                        generation: EntryId, origin: EntryId,
                        hard_only=False) -> tuple[Event, ...]:
    events = [event for event in journal
              if event.node == node and event.kind == "invalidate"
              and event.generation == generation
              and invalidate_applies(event, origin)
              and (not hard_only or event.mode == "hard")]
    return per_author_heads(events)


def covers(validation: Event, invalidate: Event) -> bool:
    return (validation.node == invalidate.node
            and validation.generation == invalidate.generation
            and invalidate.sequence <= coordinate(
                validation.clears_through, invalidate.author))


def freshness(journal: Iterable[Event], node: NodeKey,
              generation: EntryId, origin: EntryId) -> str:
    values = tuple(journal)
    all_frontier = invalidate_frontier(values, node, generation, origin)
    hard_frontier = invalidate_frontier(values, node, generation, origin, True)
    validations = [event for event in values
                   if event.node == node and event.kind == "validate"
                   and event.generation == generation
                   and event.value_origin == origin]
    if any(all(covers(validation, invalidate) for invalidate in all_frontier)
           for validation in validations):
        return "fresh"
    if hard_frontier and not any(
            all(covers(validation, invalidate) for invalidate in hard_frontier)
            for validation in validations):
        return "hard"
    return "soft"


def polling_maxima(journal: Iterable[Event]) -> frozenset[Event]:
    groups: dict[tuple[str, NodeKey, str], list[Event]] = {}
    for event in journal:
        if event.public_action is not None:
            groups.setdefault((event.author, event.node, event.public_action), []).append(event)
    return frozenset(max(events, key=lambda event: event.sequence)
                     for events in groups.values())


def compact(journal: Iterable[Event]) -> frozenset[Event]:
    """Normative seed families plus reference/context closure for bounded states."""
    values = frozenset(journal)
    keep: set[Event] = set(polling_maxima(values))
    nodes = {event.node for event in values}
    for node in nodes:
        keep.update(causal_maxima(eligible_presence_events(values, node)))
        keep.update(fallback_antichain(values, node))
        # Retain all anchor witnesses and carriers, including inapplicable groups.
        for anchor, carriers in anchor_groups(values, node).items():
            keep.update(causal_maxima(carriers))
            witness = anchor_presence(values, node, anchor)
            if witness:
                keep.add(witness)
        generations = {event.id for event in values if event.kind == "generation"}
        for generation in generations:
            heads = per_author_heads(value_events(values, node, generation))
            keep.update(heads)
            for origin in {event.id for event in heads}:
                keep.update(invalidate_frontier(values, node, generation, origin))
                keep.update(invalidate_frontier(values, node, generation, origin, True))
                keep.update(per_author_heads(
                    event for event in values if event.node == node
                    and event.kind == "validate" and event.generation == generation
                    and event.value_origin == origin))
    # Exact reset correspondence carriers survive independently of applicability.
    keep.update(event for event in values if event.correspondence is not None)
    # Least exact-reference closure.
    changed = True
    while changed:
        changed = False
        references = {reference for event in keep
                      for reference in (event.generation, event.value_origin,
                                        event.applies_to if isinstance(event.applies_to, tuple) else None,
                                        event.reset_anchor[1] if event.reset_anchor else None,
                                        event.correspondence[0] if event.correspondence else None,
                                        event.correspondence[1] if event.correspondence else None)
                      if reference is not None}
        for event in values:
            if event.id in references and event not in keep:
                keep.add(event)
                changed = True
    return frozenset(keep)


def event(author: str, sequence: int, node: NodeKey, kind: str, **fields) -> Event:
    return Event(author, sequence, node, kind, **fields)


def verify_pure_receive_then_author() -> None:
    node = ("root", ())
    a = Replica("A", local_counter=9, journal_coverage={"A": 9},
                causal_summary={"A": 9})
    authored = author_event(a, node, "generation", time=1)
    assert authored.id == ("A", 10)
    b = Replica("B")
    assert receive(b, a)
    assert b.local_counter == 0
    assert coordinate(b.causal_summary, "A") == 10
    assert not receive(b, a)
    later = author_event(b, node, "delete", time=2)
    assert later.id == ("B", 1)
    assert causally_before(authored, later)


def reset_fixture() -> tuple[NodeKey, list[Event], Anchor, Anchor]:
    node = ("n", ("x",))
    g1 = event("A", 5, node, "generation", time=5)
    d1 = event("A", 10, node, "delete", time=10)
    g2 = event("A", 11, node, "generation", time=11)
    present_anchor: Anchor = ("present", g1.id)
    delete_anchor: Anchor = ("delete", d1.id)
    present_reset = event("R", 1, node, "validate", time=20,
                          generation=g1.id, value_origin=g1.id,
                          reset_anchor=present_anchor,
                          absorbs_through={"A": 10})
    delete_reset = event("S", 1, node, "reset-observation", time=21,
                         reset_anchor=delete_anchor,
                         absorbs_through={"A": 11})
    return node, [g1, d1, g2, present_reset, delete_reset], present_anchor, delete_anchor


def verify_reset_applicability_and_cuts() -> None:
    node, journal, present_anchor, delete_anchor = reset_fixture()
    groups = anchor_groups(journal, node)
    assert anchor_cut(groups[present_anchor]) == {"A": 10}
    assert anchor_cut(groups[delete_anchor]) == {"A": 11}
    # A:10 is delayed consumed displacement for the present anchor; A:11 is live.
    assert not anchor_is_applicable(journal, node, present_anchor, groups[present_anchor])
    assert anchor_is_applicable(journal, node, delete_anchor, groups[delete_anchor])
    assert fallback_selection(journal, node) == journal[-1]
    assert not causally_before(journal[-2], journal[-1])
    assert presence_selection(journal, node).id == ("A", 10)

    consumed_only = [entry for entry in journal if entry.id != ("A", 11)]
    assert anchor_is_applicable(
        consumed_only, node, present_anchor,
        anchor_groups(consumed_only, node)[present_anchor])
    assert anchor_presence(consumed_only, node, present_anchor).id == ("A", 5)


def verify_scoped_activation_and_future_anchor() -> None:
    node, journal, present_anchor, _ = reset_fixture()
    # Present anchor is inapplicable now and must remain compacted for future union.
    compacted = compact(journal)
    assert any(entry.reset_anchor == present_anchor for entry in compacted)
    consumed_generation = next(entry for entry in journal if entry.id == ("A", 5))
    scoped = event("B", 1, node, "edit", time=30,
                   generation=consumed_generation.id, value_origin=None)
    activated = journal + [scoped]
    assert consumed_generation.id in activated_generations(
        activated, node, applicable_cut(activated, node))
    assert scoped not in presence_events(activated, node)

    # An inapplicable anchor can become applicable when a future inside-cut
    # event causally dominates the current post-cut displacement.
    future_anchor: Anchor = ("present", consumed_generation.id)
    carrier = event("R", 9, node, "validate", time=50,
                    generation=consumed_generation.id,
                    value_origin=consumed_generation.id,
                    reset_anchor=future_anchor,
                    absorbs_through={"A": 10, "B": 5})
    displacement = event("A", 11, node, "delete", time=51)
    current = [consumed_generation, carrier, displacement]
    assert not anchor_is_applicable(current, node, future_anchor, [carrier])
    assert carrier in compact(current)
    inside_future = event("B", 5, node, "delete", time=52,
                          causal_context={"A": 11})
    joined = current + [inside_future]
    assert anchor_is_applicable(joined, node, future_anchor, [carrier])

    null_anchor: Anchor = ("null", None)
    null_carrier = event("N", 1, node, "reset-observation", time=60,
                         reset_anchor=null_anchor, absorbs_through={"A": 11, "B": 5})
    null_history = [consumed_generation, displacement, inside_future, null_carrier]
    assert anchor_is_applicable(null_history, node, null_anchor, [null_carrier])
    assert anchor_presence(null_history, node, null_anchor) is None


def verify_reset_correspondence_compaction() -> None:
    node = ("reset", ())
    receiver_generation = event("R", 1, node, "generation", time=1)
    source_generation = event("A", 4, node, "generation", time=1)
    source_edit = event("A", 5, node, "edit", time=2,
                        generation=source_generation.id)
    carrier = event("R", 2, node, "validate", time=3,
                    generation=receiver_generation.id,
                    value_origin=receiver_generation.id,
                    reset_anchor=("present", receiver_generation.id),
                    absorbs_through={"A": 5},
                    correspondence=(source_generation.id, source_edit.id))
    compacted = compact([receiver_generation, source_generation, source_edit, carrier])
    assert carrier in compacted and source_generation in compacted and source_edit in compacted
    assert carrier.correspondence == (source_generation.id, source_edit.id)


def verify_values_freshness_polling() -> None:
    node = ("v", ())
    generation = event("A", 100, node, "generation", time=10)
    observed_edit = event("B", 2, node, "edit", time=10,
                          causal_context={"A": 100}, generation=generation.id)
    assert equal_time_value_canonicalization(
        [generation, observed_edit], node, generation.id, 10) == observed_edit
    hard_a = event("A", 101, node, "invalidate", generation=generation.id,
                   applies_to=observed_edit.id, mode="hard")
    hard_b = event("B", 3, node, "invalidate", generation=generation.id,
                   applies_to="generation", mode="hard")
    partial_a = event("C", 1, node, "validate", generation=generation.id,
                      value_origin=observed_edit.id, clears_through={"A": 101})
    partial_b = event("D", 1, node, "validate", generation=generation.id,
                      value_origin=observed_edit.id, clears_through={"B": 3})
    values = [generation, observed_edit, hard_a, hard_b, partial_a, partial_b]
    assert freshness(values, node, generation.id, observed_edit.id) == "hard"
    clearing = event("C", 2, node, "validate", generation=generation.id,
                     value_origin=observed_edit.id,
                     clears_through={"A": 101, "B": 3})
    assert freshness(values + [clearing], node, generation.id, observed_edit.id) == "fresh"

    other = ("other", ())
    poll = [event("A", 1, node, "edit"), event("A", 2, node, "edit"),
            event("A", 3, other, "edit"), event("A", 4, node, "delete")]
    maxima = polling_maxima(poll)
    assert {entry.id for entry in maxima} == {("A", 2), ("A", 3), ("A", 4)}


def verify_compaction_future_union() -> None:
    node, reset_history, _, _ = reset_fixture()
    generation = next(entry for entry in reset_history if entry.kind == "generation")
    hard = event("B", 2, node, "invalidate", generation=generation.id,
                 applies_to="generation", mode="hard")
    validation = event("C", 1, node, "validate", generation=generation.id,
                       value_origin=generation.id, clears_through={"B": 2})
    scoped = event("D", 1, node, "edit", time=40, generation=generation.id)
    cases = [
        (set(reset_history), {scoped}),
        (set(reset_history + [hard]), {validation}),
        (set(reset_history + [validation]), {hard, scoped}),
    ]
    for left, right in cases:
        assert compact(compact(left) | right) == compact(left | right)


def verify_causal_laws() -> None:
    node = ("law", ())
    bare = [event(author, sequence, node, "edit")
            for author in ("A", "B", "C") for sequence in (1, 2)]
    for left, right in combinations(bare, 2):
        assert not (causally_before(left, right) and causally_before(right, left))
    a = event("A", 10, node, "edit")
    b = event("B", 3, node, "edit", causal_context={"A": 10})
    c = event("C", 7, node, "edit", causal_context={"A": 10, "B": 3})
    assert causally_before(a, b) and causally_before(b, c) and causally_before(a, c)


def main() -> None:
    verify_pure_receive_then_author()
    verify_reset_applicability_and_cuts()
    verify_scoped_activation_and_future_anchor()
    verify_reset_correspondence_compaction()
    verify_values_freshness_polling()
    verify_compaction_future_union()
    verify_causal_laws()
    print("journal causal-context model: all bounded checks passed")


if __name__ == "__main__":
    main()
