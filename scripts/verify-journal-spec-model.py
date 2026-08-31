#!/usr/bin/env python3
"""Bounded executable model of the normative causal journal selectors."""

from dataclasses import dataclass, field, replace
from itertools import combinations
from typing import Iterable, Mapping

Prefix = Mapping[str, int]
EntryId = tuple[str, int]
NodeKey = tuple[str, tuple[str, ...]]
Anchor = tuple[str, EntryId | None]  # null, delete, or present(value origin)
Correspondence = tuple[EntryId, EntryId]  # source generation and value origin
StaleIdentity = tuple[EntryId, tuple[str, ...]]
MIN_UNIX_TIMESTAMP = -8_640_000_000_000_000
MAX_UNIX_TIMESTAMP = 8_640_000_000_000_000


def coordinate(prefix: Prefix, author: str) -> int:
    return prefix.get(author, 0)


def join_prefixes(*prefixes: Prefix) -> dict[str, int]:
    result: dict[str, int] = {}
    for prefix in prefixes:
        for author, value in prefix.items():
            result[author] = max(result.get(author, 0), value)
    return result


@dataclass(frozen=True)
class ResetLineage:
    absorbs_through: Prefix
    correspondence: Correspondence | None = None


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
    absent_anchor: EntryId | None = None
    reset_lineage: ResetLineage | None = None
    stale_identity: StaleIdentity | None = None

    def __post_init__(self) -> None:
        assert self.sequence > 0
        assert isinstance(self.time, int) and not isinstance(self.time, bool)
        assert MIN_UNIX_TIMESTAMP <= self.time <= MAX_UNIX_TIMESTAMP

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
        return self.kind

    def __hash__(self) -> int:
        return hash(self.id)

    @property
    def absorbs_through(self) -> Prefix:
        assert self.reset_lineage is not None
        return self.reset_lineage.absorbs_through

    @property
    def correspondence(self) -> Correspondence | None:
        return (None if self.reset_lineage is None
                else self.reset_lineage.correspondence)


@dataclass(frozen=True)
class AnchorCutSummary:
    """Non-assertion compact state preserving one tagged anchor's joined cut."""
    node: NodeKey
    anchor: Anchor
    absorbs_through: Prefix

    def __hash__(self) -> int:
        return hash((self.node, self.anchor, tuple(sorted(self.absorbs_through.items()))))


@dataclass(frozen=True)
class JournalState:
    events: frozenset[Event]
    anchor_cuts: frozenset[AnchorCutSummary] = frozenset()

    def __iter__(self):
        return iter(self.events)

    def __contains__(self, item):
        return item in self.events

    def __len__(self):
        return len(self.events) + len(self.anchor_cuts)

    def __or__(self, other):
        return merge_state(self, other)

    def __ror__(self, other):
        return merge_state(other, self)


def journal_events(journal: Iterable[Event] | JournalState) -> tuple[Event, ...]:
    return tuple(journal.events if isinstance(journal, JournalState) else journal)


def journal_cut_summaries(journal: Iterable[Event] | JournalState
                          ) -> tuple[AnchorCutSummary, ...]:
    return tuple(journal.anchor_cuts if isinstance(journal, JournalState) else ())


def merge_state(left, right) -> JournalState:
    events = frozenset(journal_events(left)) | frozenset(journal_events(right))
    summaries = frozenset(journal_cut_summaries(left)) | frozenset(
        journal_cut_summaries(right))
    return JournalState(events, summaries)


@dataclass
class Replica:
    author: str
    journal: dict[EntryId, Event] = field(default_factory=dict)
    reset_anchor_cuts: dict[tuple[NodeKey, Anchor], dict[str, int]] = field(
        default_factory=dict)
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
              dict(receiver.causal_summary),
              {key: dict(value) for key, value in receiver.reset_anchor_cuts.items()},
              receiver.local_counter)
    for event_id, event in source.journal.items():
        if event_id in receiver.journal:
            assert receiver.journal[event_id] == event
        receiver.journal[event_id] = event
    receiver.journal_coverage = join_prefixes(
        receiver.journal_coverage, source.journal_coverage)
    for key, source_cut in source.reset_anchor_cuts.items():
        receiver.reset_anchor_cuts[key] = join_prefixes(
            receiver.reset_anchor_cuts.get(key, {}), source_cut)
    receiver.causal_summary = join_prefixes(
        receiver.causal_summary, observed_source(source))
    after = (receiver.journal, receiver.journal_coverage,
             receiver.causal_summary, receiver.reset_anchor_cuts,
             receiver.local_counter)
    return before != after


def replica_journal_state(replica: Replica) -> JournalState:
    summaries = frozenset(
        AnchorCutSummary(node, anchor, cut)
        for (node, anchor), cut in replica.reset_anchor_cuts.items())
    return JournalState(frozenset(replica.journal.values()), summaries)


def migrate_replica(source: Replica) -> Replica:
    """Format migration preserves every journal persistence coordinate."""
    return Replica(
        source.author,
        journal=dict(source.journal),
        reset_anchor_cuts={key: dict(cut)
                           for key, cut in source.reset_anchor_cuts.items()},
        causal_summary=dict(source.causal_summary),
        journal_coverage=dict(source.journal_coverage),
        local_counter=source.local_counter)


def controlled_reset_absorption(
        observed: Iterable[Event] | JournalState, node: NodeKey,
        consumed_anchors: Iterable[Anchor], base: Prefix = {}) -> dict[str, int]:
    """Carry complete effective cuts for anchors genuinely consumed by reset."""
    groups = anchor_groups(observed, node)
    cuts = [anchor_cut(observed, node, anchor, groups[anchor])
            for anchor in consumed_anchors]
    return join_prefixes(base, *cuts)


def controlled_reset_archive(
        receiver: Iterable[Event] | JournalState,
        source: Iterable[Event] | JournalState) -> JournalState:
    """Preserve source AC by exact anchor without importing source events."""
    joined: dict[tuple[NodeKey, Anchor], dict[str, int]] = {}
    for summary in (*journal_cut_summaries(receiver),
                    *journal_cut_summaries(source)):
        key = summary.node, summary.anchor
        joined[key] = join_prefixes(
            joined.get(key, {}), summary.absorbs_through)
    return JournalState(
        frozenset(journal_events(receiver)),
        frozenset(AnchorCutSummary(node, anchor, cut)
                  for (node, anchor), cut in joined.items()))


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


def is_reset_carrier(event: Event) -> bool:
    return event.reset_lineage is not None


def tagged_anchor(event: Event) -> Anchor:
    """Derive reset anchor solely from the normative persisted carrier fields."""
    assert is_reset_carrier(event)
    if event.kind == "reset-observation":
        return (("null", None) if event.absent_anchor is None
                else ("delete", event.absent_anchor))
    if event.kind == "delete":
        return "delete", event.id
    if event.kind == "validate":
        assert event.value_origin is not None
        return "present", event.value_origin
    assert event.kind == "invalidate"
    assert isinstance(event.applies_to, tuple)  # reset-lineage invalidates are specific
    return "present", event.applies_to


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


def anchor_groups(journal: Iterable[Event] | JournalState,
                  node: NodeKey) -> dict[Anchor, tuple[Event, ...]]:
    values = journal_events(journal)
    groups: dict[Anchor, list[Event]] = {}
    for event in values:
        if event.node == node and is_reset_carrier(event):
            anchor = tagged_anchor(event)
            witness = anchor_presence(values, node, anchor)
            if anchor[0] == "delete":
                assert witness is not None and witness.node == event.node
            if anchor[0] == "present":
                assert witness is not None and anchor[1] is not None
                origin = next(candidate for candidate in values
                              if candidate.id == anchor[1])
                assert origin.node == event.node
            if event.correspondence is not None:
                assert anchor[0] == "present" and anchor[1] is not None
                source_generation, source_origin = event.correspondence
                assert source_generation[1] > 0 and source_origin[1] > 0
                assert source_generation[0] and source_origin[0]
            groups.setdefault(anchor, []).append(event)
    return {anchor: tuple(carriers) for anchor, carriers in groups.items()}


def anchor_cut(journal: Iterable[Event] | JournalState, node: NodeKey,
               anchor: Anchor, carriers: Iterable[Event]) -> dict[str, int]:
    summaries = [summary.absorbs_through
                 for summary in journal_cut_summaries(journal)
                 if summary.node == node and summary.anchor == anchor]
    return join_prefixes(
        *(carrier.absorbs_through for carrier in carriers), *summaries)


def presence_events(journal: Iterable[Event], node: NodeKey) -> tuple[Event, ...]:
    return tuple(event for event in journal
                 if event.node == node and event.kind in {"generation", "delete"})


def anchor_is_applicable(journal: Iterable[Event] | JournalState, node: NodeKey,
                         anchor: Anchor, carriers: Iterable[Event]) -> bool:
    witness = anchor_presence(journal, node, anchor)
    displacements = [event for event in presence_events(journal, node)
                     if witness is None or event.id != witness.id]
    cut = anchor_cut(journal, node, anchor, carriers)
    return all(event.sequence <= coordinate(cut, event.author)
               for event in causal_maxima(displacements))


def applicable_anchor_groups(journal: Iterable[Event] | JournalState, node: NodeKey
                             ) -> dict[Anchor, tuple[Event, ...]]:
    values = journal_events(journal)
    return {anchor: carriers for anchor, carriers in anchor_groups(journal, node).items()
            if anchor_is_applicable(journal, node, anchor, carriers)}


def activated_generations(journal: Iterable[Event], node: NodeKey,
                          cut: Prefix) -> set[EntryId]:
    result: set[EntryId] = set()
    for event in journal:
        if (event.node == node and event.generation is not None
                and event.kind in {"edit", "invalidate", "validate"}
                and not is_reset_carrier(event)
                and event.sequence > coordinate(cut, event.author)):
            result.add(event.generation)
    return result


def fallback_antichain(journal: Iterable[Event] | JournalState,
                       node: NodeKey) -> tuple[Event, ...]:
    groups = applicable_anchor_groups(journal, node)
    return causal_maxima(carrier for carriers in groups.values() for carrier in carriers)


def fallback_selection(journal: Iterable[Event], node: NodeKey) -> Event | None:
    return concurrent_winner(fallback_antichain(journal, node))


@dataclass(frozen=True)
class PresenceResult:
    presence: Event | None
    authority: Event


def anchor_result(journal: Iterable[Event] | JournalState, node: NodeKey, anchor: Anchor,
                  carriers: Iterable[Event], assertion: Event) -> PresenceResult:
    values = journal_events(journal)
    cut = anchor_cut(journal, node, anchor, carriers)
    witness = anchor_presence(values, node, anchor)
    live: list[PresenceResult] = []
    displacements = [presence for presence in presence_events(values, node)
                     if witness is None or presence.id != witness.id]
    # Domination precedes cut classification.  An inside-cut maximum therefore
    # suppresses every after-cut displacement in its causal past.
    for presence in causal_maxima(displacements):
        if presence.sequence > coordinate(cut, presence.author):
            live.append(PresenceResult(presence, presence))
    for scoped in values:
        if (scoped.node == node and scoped.generation is not None
                and scoped.kind in {"edit", "invalidate", "validate"}
                and not is_reset_carrier(scoped)
                and scoped.sequence > coordinate(cut, scoped.author)):
            live.append(PresenceResult(
                generation_event(values, scoped.generation), scoped))
    if not live:
        return PresenceResult(witness, assertion)
    maximal_authorities = causal_maxima(result.authority for result in live)
    authority = concurrent_winner(maximal_authorities)
    assert authority is not None
    return next(result for result in live if result.authority == authority)


def presence_selection(journal: Iterable[Event] | JournalState,
                       node: NodeKey) -> Event | None:
    values = journal_events(journal)
    groups = applicable_anchor_groups(journal, node)
    assertions = fallback_antichain(journal, node)
    if not assertions:
        return concurrent_winner(causal_maxima(presence_events(values, node)))
    results = [anchor_result(journal, node, tagged_anchor(assertion),
                             groups[tagged_anchor(assertion)], assertion)
               for assertion in assertions]
    maximal_authorities = causal_maxima(result.authority for result in results)
    authority = concurrent_winner(maximal_authorities)
    assert authority is not None
    return next(result.presence for result in results if result.authority == authority)


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


def unsupported_precedence(candidates: Iterable[Event]) -> Event | None:
    return concurrent_winner(causal_maxima(candidates))


def no_coherent_candidate(input_count: int, candidates: Iterable[Event],
                          opposite_absence=False) -> Event | None:
    values = tuple(candidates)
    if not values:
        return None
    if input_count == 0:
        return unsupported_precedence(values)
    if input_count == 1:
        return unsupported_precedence(values)
    if opposite_absence:
        return None
    identities = {candidate.stale_identity for candidate in values}
    if None in identities or len(identities) != 1:
        return None
    return unsupported_precedence(values)


def polling_maxima(journal: Iterable[Event]) -> frozenset[Event]:
    groups: dict[tuple[str, NodeKey, str], list[Event]] = {}
    for event in journal:
        if event.public_action is not None:
            groups.setdefault((event.author, event.node, event.public_action), []).append(event)
    return frozenset(max(events, key=lambda event: event.sequence)
                     for events in groups.values())


def prefix_covers(covering: Prefix, covered: Prefix) -> bool:
    return all(value <= coordinate(covering, author)
               for author, value in covered.items())


def reset_subsumes(journal: Iterable[Event] | JournalState,
                   newer: Event, older: Event) -> bool:
    groups = anchor_groups(journal, older.node)
    older_anchor = tagged_anchor(older)
    effective_older_cut = anchor_cut(
        journal, older.node, older_anchor, groups.get(older_anchor, ()))
    return (newer.node == older.node
            and causally_before(older, newer)
            and prefix_covers(newer.absorbs_through, effective_older_cut))


def future_reset_assertions(journal: Iterable[Event] | JournalState) -> frozenset[Event]:
    carriers = tuple(event for event in journal_events(journal)
                     if is_reset_carrier(event))
    return frozenset(older for older in carriers
                     if not any(reset_subsumes(journal, newer, older)
                                for newer in carriers))


def correspondence_key(event: Event) -> tuple[NodeKey, EntryId, EntryId, EntryId]:
    assert event.correspondence is not None
    anchor = tagged_anchor(event)
    assert anchor[0] == "present" and anchor[1] is not None
    source_generation, source_origin = event.correspondence
    return event.node, anchor[1], source_generation, source_origin


def correspondence_seeds(journal: Iterable[Event]) -> frozenset[Event]:
    groups: dict[tuple[NodeKey, EntryId, EntryId, EntryId], list[Event]] = {}
    for event in journal:
        if event.correspondence is not None:
            groups.setdefault(correspondence_key(event), []).append(event)
    result: set[Event] = set()
    for carriers in groups.values():
        winner = concurrent_winner(causal_maxima(carriers))
        assert winner is not None
        result.add(winner)
    return frozenset(result)


def compact(journal: Iterable[Event] | JournalState) -> JournalState:
    """Exactly N/P/VH/ET/IF/HF/VV/RL/RC plus reference closure."""
    values = frozenset(journal_events(journal))
    # N
    keep: set[Event] = set(polling_maxima(values))
    # RL and RC
    reset_seeds = future_reset_assertions(journal)
    keep.update(reset_seeds)
    keep.update(correspondence_seeds(values))
    cut_summaries: set[AnchorCutSummary] = set()
    nodes = ({event.node for event in values}
             | {summary.node for summary in journal_cut_summaries(journal)})
    for node in nodes:
        groups = anchor_groups(journal, node)
        node_reset_seeds = [event for event in reset_seeds if event.node == node]
        # AC: one joined cut for every represented anchor.  This is the
        # canonical anchor-indexed absorption archive used by delayed union.
        represented_anchors = (set(groups)
                               | {summary.anchor
                                  for summary in journal_cut_summaries(journal)
                                  if summary.node == node})
        for anchor in represented_anchors:
            cut_summaries.add(AnchorCutSummary(
                node, anchor, anchor_cut(
                    journal, node, anchor, groups.get(anchor, ()))))
        # P: results and authorities for future-relevant assertions, or ordinary maxima.
        if node_reset_seeds:
            for assertion in node_reset_seeds:
                anchor = tagged_anchor(assertion)
                result = anchor_result(journal, node, anchor, groups[anchor], assertion)
                keep.add(result.authority)
                if result.presence is not None:
                    keep.add(result.presence)
        else:
            keep.update(causal_maxima(presence_events(values, node)))
        # Only RL/RC anchor witnesses are closure seeds.
        witness_carriers = node_reset_seeds + [
            event for event in correspondence_seeds(values) if event.node == node]
        for carrier in witness_carriers:
            anchor = tagged_anchor(carrier)
            witness = anchor_presence(values, node, anchor)
            if witness:
                keep.add(witness)
        # VH/ET only for generations reached by retained semantic seeds.
        generations = {event.id for event in keep
                       if event.node == node and event.kind == "generation"}
        generations.update(event.generation for event in keep
                           if event.node == node and event.generation is not None)
        for generation in generations:
            heads = per_author_heads(value_events(values, node, generation))
            keep.update(heads)
            # ET is the causal maxima within each exact timestamp among VH.
            for time in {event.time for event in heads}:
                keep.update(causal_maxima(event for event in heads if event.time == time))
            for origin in {event.id for event in heads}:
                # IF/HF
                keep.update(invalidate_frontier(values, node, generation, origin))
                keep.update(invalidate_frontier(values, node, generation, origin, True))
                # VV
                keep.update(per_author_heads(
                    event for event in values if event.node == node
                    and event.kind == "validate" and event.generation == generation
                    and event.value_origin == origin))
    # Least exact-reference closure.
    changed = True
    while changed:
        changed = False
        references = {reference for event in keep
                      for reference in (event.generation, event.value_origin,
                                        event.applies_to if isinstance(event.applies_to, tuple) else None,
                                        event.absent_anchor)
                      if reference is not None}
        for event in values:
            if event.id in references and event not in keep:
                keep.add(event)
                changed = True
    return JournalState(frozenset(keep), frozenset(cut_summaries))


def event(author: str, sequence: int, node: NodeKey, kind: str, **fields) -> Event:
    return Event(author, sequence, node, kind, **fields)


def lineage(absorbs: Prefix,
            correspondence: Correspondence | None = None) -> ResetLineage:
    return ResetLineage(absorbs, correspondence)


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


def verify_receive_anchor_cut_summaries() -> None:
    node = ("received-cut", ())
    generation = event("A", 1, node, "generation", time=1)
    null_assertion = event(
        "N", 1, node, "reset-observation", time=2,
        reset_lineage=lineage({"A": 1}))
    key = (node, ("null", None))
    source = Replica(
        "S", journal={generation.id: generation, null_assertion.id: null_assertion},
        reset_anchor_cuts={key: {"A": 1, "B": 10}},
        causal_summary={"A": 1, "N": 1}, journal_coverage={"A": 1, "N": 1})
    receiver = Replica(
        "R", journal=dict(source.journal), causal_summary=dict(source.causal_summary),
        journal_coverage=dict(source.journal_coverage), local_counter=7)
    assert receive(receiver, source)  # cut growth is the only persistent change
    assert receiver.local_counter == 7
    assert receiver.reset_anchor_cuts[key] == {"A": 1, "B": 10}
    assert coordinate(receiver.causal_summary, "B") == 0

    delayed = event("B", 5, node, "generation", time=3)
    received_state = replica_journal_state(receiver) | {delayed}
    assert presence_selection(received_state, node) is None
    assert not receive(receiver, source)


def verify_reset_and_migration_preserve_effective_cuts() -> None:
    node = ("effective-reset-cut", ())
    generation = event("A", 1, node, "generation", time=1)
    survivor = event(
        "C", 1, node, "reset-observation", time=2,
        reset_lineage=lineage({"A": 1}))  # own B coordinate is zero
    null_anchor: Anchor = ("null", None)
    compact_source = JournalState(
        frozenset({generation, survivor}),
        frozenset({AnchorCutSummary(
            node, null_anchor, {"A": 1, "B": 10})}))

    carried = controlled_reset_absorption(
        compact_source, node, [null_anchor])
    assert carried == {"A": 1, "B": 10}
    receiver_carrier = event(
        "R", 1, node, "validate", time=3,
        causal_context={"C": 1}, generation=generation.id,
        value_origin=generation.id, reset_lineage=lineage(carried))
    reset_state = JournalState(frozenset({generation, receiver_carrier}))
    delayed_b5 = event("B", 5, node, "generation", time=4)
    assert presence_selection(reset_state | {delayed_b5}, node) == generation
    restarted = compact(compact(reset_state))
    assert presence_selection(restarted | {delayed_b5}, node) == generation
    assert compact(compact(reset_state) | {delayed_b5}) == compact(
        reset_state | {delayed_b5})
    later_b11 = event("B", 11, node, "generation", time=5)
    assert presence_selection(restarted | {later_b11}, node) == later_b11

    # Summary-only B:10 prevents cross-anchor subsumption until it is carried.
    incomplete = event(
        "D", 1, node, "validate", time=3, causal_context={"C": 1},
        generation=generation.id, value_origin=generation.id,
        reset_lineage=lineage({"A": 1}))
    incomplete_state = compact_source | {incomplete}
    assert survivor in future_reset_assertions(incomplete_state)
    complete = replace(incomplete, reset_lineage=lineage(carried))
    complete_state = compact_source | {complete}
    assert survivor not in future_reset_assertions(complete_state)

    # Migration preserves the compact source state without interpreting AC as causality.
    source_replica = Replica(
        "M", journal={event.id: event for event in compact_source.events},
        reset_anchor_cuts={(node, null_anchor): {"A": 1, "B": 10}},
        causal_summary={"A": 1, "C": 1}, journal_coverage={"A": 1, "C": 1},
        local_counter=0)
    target_replica = migrate_replica(source_replica)
    assert target_replica == source_replica
    assert presence_selection(
        replica_journal_state(target_replica) | {delayed_b5}, node) is None


def verify_controlled_reset_preserves_anchor_archive() -> None:
    node = ("reset-archive", ())
    source_generation = event("S", 1, node, "generation", time=1)
    anchor_zero: Anchor = ("null", None)
    historical = event(
        "H", 1, node, "reset-observation", time=2,
        reset_lineage=lineage({"S": 1, "X": 10}))
    current = event(
        "N", 1, node, "validate", time=3, causal_context={"H": 1},
        generation=source_generation.id, value_origin=source_generation.id,
        reset_lineage=lineage({"S": 1, "X": 10}))
    source = compact({source_generation, historical, current})
    assert historical not in source
    assert all(tagged_anchor(carrier) != anchor_zero
               for carrier in future_reset_assertions(source))
    assert coordinate(next(
        summary.absorbs_through for summary in source.anchor_cuts
        if summary.node == node and summary.anchor == anchor_zero), "X") == 10

    receiver_generation = event("R", 1, node, "generation", time=1)
    receiver = JournalState(frozenset({receiver_generation}))
    receiver_with_archive = controlled_reset_archive(receiver, source)
    carried = controlled_reset_absorption(
        source, node, [tagged_anchor(current)])
    reset_carrier = event(
        "R", 2, node, "validate", time=4, causal_context={"N": 1},
        generation=receiver_generation.id, value_origin=receiver_generation.id,
        reset_lineage=lineage(carried))
    reset_state = JournalState(
        receiver_with_archive.events | {reset_carrier},
        receiver_with_archive.anchor_cuts)

    # C knows the receiver witness but is concurrent with the reset decision.
    concurrent = event(
        "C", 1, node, "reset-observation", time=5,
        reset_lineage=lineage({"R": 1}))
    inside = event("X", 5, node, "generation", time=6)
    outside = event("X", 11, node, "generation", time=7)
    with_inside = reset_state | {concurrent, inside}
    assert presence_selection(with_inside, node) is None
    direct_archive_interpretation = source | receiver | {reset_carrier, concurrent, inside}
    assert presence_selection(with_inside, node) == presence_selection(
        direct_archive_interpretation, node)
    assert presence_selection(reset_state | {concurrent, outside}, node) == outside

    restarted = compact(with_inside)
    assert presence_selection(restarted, node) is None
    assert any(summary.node == node and summary.anchor == anchor_zero
               and coordinate(summary.absorbs_through, "X") == 10
               for summary in restarted.anchor_cuts)
    assert compact(restarted) == restarted


def reset_fixture() -> tuple[NodeKey, list[Event], Anchor, Anchor]:
    node = ("n", ("x",))
    g1 = event("A", 5, node, "generation", time=5)
    d1 = event("A", 10, node, "delete", time=10)
    g2 = event("A", 11, node, "generation", time=11)
    present_anchor: Anchor = ("present", g1.id)
    delete_anchor: Anchor = ("delete", d1.id)
    present_reset = event("R", 1, node, "validate", time=20,
                          generation=g1.id, value_origin=g1.id,
                          reset_lineage=lineage({"A": 10}))
    delete_reset = event("S", 1, node, "reset-observation", time=21,
                         absent_anchor=d1.id,
                         reset_lineage=lineage({"A": 11}))
    return node, [g1, d1, g2, present_reset, delete_reset], present_anchor, delete_anchor


def verify_reset_applicability_and_cuts() -> None:
    node, journal, present_anchor, delete_anchor = reset_fixture()
    groups = anchor_groups(journal, node)
    assert anchor_cut(journal, node, present_anchor, groups[present_anchor]) == {"A": 10}
    assert anchor_cut(journal, node, delete_anchor, groups[delete_anchor]) == {"A": 11}
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
    assert any(is_reset_carrier(entry) and tagged_anchor(entry) == present_anchor
               for entry in compacted)
    consumed_generation = next(entry for entry in journal if entry.id == ("A", 5))
    scoped = event("B", 1, node, "edit", time=30,
                   generation=consumed_generation.id, value_origin=None)
    activated = journal + [scoped]
    delete_group = anchor_groups(activated, node)[("delete", ("A", 10))]
    assert consumed_generation.id in activated_generations(
        activated, node,
        anchor_cut(activated, node, ("delete", ("A", 10)), delete_group))
    assert scoped not in presence_events(activated, node)

    # An inapplicable anchor can become applicable when a future inside-cut
    # event causally dominates the current post-cut displacement.
    future_anchor: Anchor = ("present", consumed_generation.id)
    carrier = event("R", 9, node, "validate", time=50,
                    generation=consumed_generation.id,
                    value_origin=consumed_generation.id,
                    reset_lineage=lineage({"A": 10, "B": 5}))
    displacement = event("A", 11, node, "delete", time=51)
    current = [consumed_generation, carrier, displacement]
    assert not anchor_is_applicable(current, node, future_anchor, [carrier])
    assert carrier in compact(current)
    inside_future = event("B", 5, node, "delete", time=52,
                          causal_context={"A": 11})
    joined = current + [inside_future]
    assert anchor_is_applicable(joined, node, future_anchor, [carrier])
    assert presence_selection(joined, node) == consumed_generation

    null_anchor: Anchor = ("null", None)
    null_carrier = event("N", 1, node, "reset-observation", time=60,
                         reset_lineage=lineage({"A": 11, "B": 5}))
    null_history = [consumed_generation, displacement, inside_future, null_carrier]
    assert anchor_is_applicable(null_history, node, null_anchor, [null_carrier])
    assert anchor_presence(null_history, node, null_anchor) is None


def verify_delayed_same_anchor_cut_recovery() -> None:
    """A delayed concurrent carrier recovers its anchor's archived cut."""
    node = ("delayed-anchor", ())
    generation = event("A", 1, node, "generation", time=1)
    anchor_zero: Anchor = ("null", None)
    older = event("B", 1, node, "reset-observation", time=2,
                  reset_lineage=lineage({"A": 1, "X": 10}))
    newer = event("D", 1, node, "validate", time=3,
                  causal_context={"B": 1}, generation=generation.id,
                  value_origin=generation.id,
                  reset_lineage=lineage({"A": 1, "X": 10}))
    assert tagged_anchor(older) == anchor_zero
    assert tagged_anchor(newer) != anchor_zero
    base = JournalState(frozenset({generation, older, newer}))
    assert reset_subsumes(base, newer, older)
    compacted_base = compact(base)
    assert older not in compacted_base
    archived = next(summary for summary in compacted_base.anchor_cuts
                    if summary.node == node and summary.anchor == anchor_zero)
    assert coordinate(archived.absorbs_through, "X") == 10

    # C is authored without observing N, so it is concurrent with N and
    # survives the fallback antichain when delivered later.
    concurrent = event("C", 1, node, "reset-observation", time=4,
                       reset_lineage=lineage({}))
    delayed = JournalState(frozenset({concurrent}))
    left = compact(compacted_base | delayed)
    right = compact(base | delayed)
    assert left == right
    assert presence_selection(left, node) == presence_selection(right, node)
    assert concurrent in future_reset_assertions(left)
    recovered = next(summary for summary in left.anchor_cuts
                     if summary.node == node and summary.anchor == anchor_zero)
    assert coordinate(recovered.absorbs_through, "X") == 10
    restarted = compact(left)
    assert restarted == left
    assert presence_selection(restarted, node) == presence_selection(right, node)


def verify_reset_correspondence_compaction() -> None:
    node = ("reset", ())
    receiver_generation = event("R", 1, node, "generation", time=1)
    source_generation = ("A", 4)
    source_origin = ("A", 5)
    carrier = event("R", 2, node, "validate", time=3,
                    generation=receiver_generation.id,
                    value_origin=receiver_generation.id,
                    reset_lineage=lineage(
                        {"A": 5}, (source_generation, source_origin)))
    compacted = compact([receiver_generation, carrier])
    assert carrier in compacted and receiver_generation in compacted
    assert all(entry.id not in {source_generation, source_origin} for entry in compacted)
    assert carrier.correspondence == (source_generation, source_origin)
    # Restart from compact state retains the relation without source journal entries.
    restarted = compact(compacted)
    assert correspondence_seeds(restarted) == frozenset({carrier})


def verify_compacted_anchor_cut_preservation() -> None:
    node = ("cut-preservation", ())
    generation = event("A", 1, node, "generation", time=1)
    old_null = event(
        "B", 1, node, "reset-observation", time=10,
        reset_lineage=lineage({"A": 1, "X": 10}))
    surviving_null = event(
        "C", 1, node, "reset-observation", time=40,
        reset_lineage=lineage({}))
    present = event(
        "D", 1, node, "validate", time=30,
        causal_context={"B": 1}, generation=generation.id,
        value_origin=generation.id,
        reset_lineage=lineage({"A": 1, "X": 10}))
    consumed = event("X", 5, node, "generation", time=50)
    journal = [generation, old_null, surviving_null, present, consumed]
    assert presence_selection(journal, node) is None
    compacted = compact(journal)
    null_summary = next(summary for summary in compacted.anchor_cuts
                        if summary.anchor == ("null", None))
    assert coordinate(null_summary.absorbs_through, "X") == 10
    assert old_null not in compacted
    assert presence_selection(compacted, node) == presence_selection(journal, node)

    delayed = event("X", 11, node, "delete", time=60)
    assert compact(compacted | {delayed}) == compact(set(journal) | {delayed})


def verify_delete_vs_activation_authority() -> None:
    node = ("activation-authority", ())
    generation = event("A", 1, node, "generation", time=1)
    activating_edit = event("B", 1, node, "edit", time=30,
                            generation=generation.id)
    delete = event(
        "D", 1, node, "delete", time=20,
        reset_lineage=lineage({"A": 1, "B": 1, "D": 1}))
    null = event(
        "N", 1, node, "reset-observation", time=10,
        reset_lineage=lineage({"A": 1, "D": 1}))
    # Activation yields compound (presence=G, authority=E); E wins concurrency.
    assert presence_selection([generation, activating_edit, delete, null], node) == generation

    observed_delete = replace(delete, time=40, causal_context={"B": 1})
    # The real delete causally dominates the activation authority.
    assert presence_selection(
        [generation, activating_edit, observed_delete, null], node) == observed_delete


def verify_anchor_scoped_absorption() -> None:
    node = ("anchor-scope", ())
    generation = event("A", 1, node, "generation", time=1)
    null_assertion = event(
        "N", 1, node, "reset-observation", time=30,
        reset_lineage=lineage({"A": 1}))
    present_assertion = event(
        "P", 1, node, "validate", time=20,
        generation=generation.id, value_origin=generation.id,
        reset_lineage=lineage({"A": 1, "B": 10}))
    without_edit = [generation, null_assertion, present_assertion]
    assert presence_selection(without_edit, node) is None
    groups = anchor_groups(without_edit, node)
    assert coordinate(anchor_cut(without_edit, node, ("null", None),
                                 groups[("null", None)]), "B") == 0
    assert coordinate(anchor_cut(without_edit, node, ("present", generation.id),
                                 groups[("present", generation.id)]), "B") == 10

    scoped = event("B", 5, node, "edit", time=40, generation=generation.id)
    with_edit = without_edit + [scoped]
    # P's B:10 cannot be lent to N. B:5 activates G relative to N's own cut.
    assert generation.id in activated_generations(
        with_edit, node,
        anchor_cut(with_edit, node, ("null", None), groups[("null", None)]))
    assert presence_selection(with_edit, node) == generation


def verify_no_coherent_candidates() -> None:
    node = ("derived", ())
    identity = (("A", 1), ("input-x", "input-y"))
    older = event("A", 10, node, "edit", time=10, stale_identity=identity)
    newer = event("B", 2, node, "edit", time=20, stale_identity=identity)
    conflict = event("C", 1, node, "edit", time=30,
                     stale_identity=(("C", 1), ("input-x", "input-z")))
    assert no_coherent_candidate(0, [older, newer]) == newer
    assert no_coherent_candidate(1, [older, newer]) == newer
    assert no_coherent_candidate(2, [older, newer]) == newer
    assert no_coherent_candidate(2, [older, conflict]) is None
    assert no_coherent_candidate(2, [newer], opposite_absence=True) is None


def verify_reset_compaction_bounds() -> None:
    node = ("churn", ())
    history: list[Event] = []
    sequence = 0
    last_generation: Event | None = None
    for iteration in range(80):
        sequence += 1
        if iteration % 3 == 0:
            last_generation = event("A", sequence, node, "generation", time=sequence)
            history.append(last_generation)
            sequence += 1
            history.append(event(
                "A", sequence, node, "validate", time=sequence,
                generation=last_generation.id, value_origin=last_generation.id,
                reset_lineage=lineage({"A": sequence - 1})))
        elif iteration % 3 == 1:
            history.append(event(
                "A", sequence, node, "delete", time=sequence,
                reset_lineage=lineage({"A": sequence - 1})))
        else:
            history.append(event(
                "A", sequence, node, "reset-observation", time=sequence,
                reset_lineage=lineage({"A": sequence - 1})))
    compacted = compact(history)
    assert len(future_reset_assertions(history)) == 1
    represented_anchors = {tagged_anchor(entry) for entry in history
                           if is_reset_carrier(entry)}
    assert len(compacted.anchor_cuts) == len(represented_anchors)
    # Repeated assertions on one fixed anchor collapse independently of count.
    fixed_anchor_history = [event(
        "A", index, ("fixed-anchor", ()), "reset-observation", time=index,
        reset_lineage=lineage({"A": index - 1}))
                            for index in range(1, 81)]
    fixed_compacted = compact(fixed_anchor_history)
    assert len(fixed_compacted.anchor_cuts) == 1
    assert len(fixed_compacted) <= 3

    relation_node = ("relation-churn", ())
    receiver_generation = event("R", 1, relation_node, "generation", time=1)
    source_generation = event("S", 1, relation_node, "generation", time=1)
    source_origin = event("S", 2, relation_node, "edit", time=2,
                          generation=source_generation.id)
    relation_history = [receiver_generation, source_generation, source_origin]
    for carrier_sequence in range(2, 102):
        relation_history.append(event(
            "R", carrier_sequence, relation_node, "validate", time=carrier_sequence,
            generation=receiver_generation.id, value_origin=receiver_generation.id,
            reset_lineage=lineage(
                {"R": carrier_sequence - 1, "S": 2},
                (source_generation.id, source_origin.id))))
    relation_compacted = compact(relation_history)
    assert len(correspondence_seeds(relation_history)) == 1
    assert len(relation_compacted) <= 8  # n=1, fixed r, c=1


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
    relation_node = ("future-relation", ())
    receiver_generation = event("R", 1, relation_node, "generation", time=1)
    source_generation = event("S", 1, relation_node, "generation", time=1)
    source_origin = event("S", 2, relation_node, "edit", time=2,
                          generation=source_generation.id)
    relation_carrier = event(
        "R", 2, relation_node, "validate", time=3,
        generation=receiver_generation.id, value_origin=receiver_generation.id,
        reset_lineage=lineage(
            {"S": 2}, (source_generation.id, source_origin.id)))
    cases = [
        (set(reset_history), {scoped}),
        (set(reset_history + [hard]), {validation}),
        (set(reset_history + [validation]), {hard, scoped}),
        ({receiver_generation, relation_carrier}, {source_generation, source_origin}),
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
    verify_receive_anchor_cut_summaries()
    verify_reset_and_migration_preserve_effective_cuts()
    verify_controlled_reset_preserves_anchor_archive()
    verify_reset_applicability_and_cuts()
    verify_scoped_activation_and_future_anchor()
    verify_delayed_same_anchor_cut_recovery()
    verify_reset_correspondence_compaction()
    verify_compacted_anchor_cut_preservation()
    verify_delete_vs_activation_authority()
    verify_anchor_scoped_absorption()
    verify_no_coherent_candidates()
    verify_reset_compaction_bounds()
    verify_values_freshness_polling()
    verify_compaction_future_union()
    verify_causal_laws()
    print("journal causal-context model: all bounded checks passed")


if __name__ == "__main__":
    main()
