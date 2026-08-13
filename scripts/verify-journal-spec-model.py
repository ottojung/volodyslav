#!/usr/bin/env python3
"""Exhaustive bounded checks for the IncrementalGraph journal specification.

Integer time atoms model valid supported ordered/equal millisecond
UnixTimestamp values, not arbitrary signed 64-bit persistence values.
"""
from dataclasses import dataclass
from itertools import product
import hashlib

ACTIONS = ("add", "edit", "delete", "invalidate", "validate")

@dataclass(frozen=True, order=True)
class Entry:
    # None is only a compact Python encoding of the normative discriminated
    # union: add/delete have no generation field; the other variants require it.
    sequence: int
    author: str
    key: str
    action: str
    time: int
    generation: tuple[int, str] | None = None
    clears: tuple[tuple[str, tuple[int, str]], ...] = ()

    @property
    def id(self): return (self.sequence, self.author)

G1 = Entry(1, "A", "K", "add", 10)
GX = Entry(15, "B", "K", "add", 15)       # concurrent cross-author generation
D1 = Entry(16, "A", "K", "delete", 16)    # delete between generations
G2 = Entry(20, "A", "K", "add", 20)       # same-author successor and winner

# Losing-generation coordinate maxima exceed winning-generation witnesses.
E_OLD = Entry(110, "A", "K", "edit", 11, G1.id)
E_CUR = Entry(22, "A", "K", "edit", 20, G2.id)
I_OLD = Entry(111, "A", "K", "invalidate", 12, G1.id)
I_CUR = Entry(23, "A", "K", "invalidate", 21, G2.id)
V_OLD = Entry(112, "B", "K", "validate", 15, GX.id)
V_CUR = Entry(24, "B", "K", "validate", 22, G2.id, (("A", I_CUR.id),))

# Winning coordinate maximum exceeds a losing entry; these also create cross-author heads.
E_LOW_OLD = Entry(2, "B", "K", "edit", 10, G1.id)
E_HIGH_CUR = Entry(25, "B", "K", "edit", 20, G2.id)
I_CROSS_CUR = Entry(26, "B", "K", "invalidate", 21, G2.id)

# Causal freshness classes coexist with value/presence history. I_HARD models
# explicit invalidate() on an already-stale materialization after V_COMPLETE.
I_A_LATE = Entry(27, "A", "K", "invalidate", 23, G2.id)
I_C = Entry(28, "C", "K", "invalidate", 24, G2.id)
V_B_PART = Entry(120, "B", "K", "validate", 25, G2.id, (("A", I_A_LATE.id),))
V_D_PART = Entry(121, "D", "K", "validate", 26, G2.id, (("C", I_C.id),))
V_COMPLETE = Entry(122, "E", "K", "validate", 27, G2.id,
                   (("A", I_A_LATE.id), ("C", I_C.id)))
I_HARD = Entry(29, "A", "K", "invalidate", 28, G2.id)
V_AFTER_HARD = Entry(123, "E", "K", "validate", 29, G2.id,
                     (("A", I_HARD.id), ("C", I_C.id)))
# The same hard-invalidation invariant is exercised for synchronization and
# migration stale-to-stale proof removal, not only public invalidate().
I_SYNC_HARD = Entry(30, "S", "K", "invalidate", 30, G2.id)
I_MIGRATION_HARD = Entry(31, "M", "K", "invalidate", 31, G2.id)

# Composite atoms make every enumerated union generation-valid while representing
# materially distinct ordering classes.
ATOMS = (
    frozenset((G1, E_OLD, I_OLD)),
    frozenset((GX, V_OLD, D1)),
    frozenset((G2, E_CUR, I_CUR, V_CUR)),
    frozenset((G1, E_LOW_OLD, G2, E_HIGH_CUR, I_CROSS_CUR)),
    frozenset((G2, I_CUR, I_A_LATE, V_B_PART, I_C, V_D_PART)),
    frozenset((G2, I_A_LATE, I_C, V_COMPLETE, I_HARD, V_AFTER_HARD)),
)

def valid(es):
    ids = {e.id: e for e in es}
    # Defensive corruption check: exact immutable duplicates are harmless, but
    # distinct contents claiming one logical ID are unsupported input. This is
    # hardening, not part of the supported-state algebra proof below.
    if any(ids[e.id] != e for e in es): return False
    for e in es:
        if e.action in ("add", "delete"):
            if e.generation is not None or e.clears: return False
            continue
        if e.action not in ("edit", "invalidate", "validate"): return False
        if e.generation is None or e.generation not in ids: return False
        if ids[e.generation].action != "add" or ids[e.generation].key != e.key: return False
        if e.action != "validate" and e.clears: return False
        for author, ref in e.clears:
            i = ids.get(ref)
            if (not i or i.action != "invalidate" or i.author != author or
                    i.key != e.key or i.generation != e.generation or
                    i.sequence >= e.sequence): return False
    validations = [e for e in es if e.action == "validate"]
    for v1 in validations:
        for v2 in validations:
            if (v1.author, v1.key, v1.generation) == (v2.author, v2.key, v2.generation) and v1.sequence < v2.sequence:
                later = dict(v2.clears)
                for author, ref in v1.clears:
                    if author not in later or later[author][0] < ref[0]: return False
    return True

# The nullable Python field is rejected in every shape the normative union
# cannot represent.
assert not valid((G1, Entry(200, "B", "K", "add", 30, G1.id)))
assert not valid((G1, Entry(201, "B", "K", "delete", 30, G1.id)))
assert not valid((G1, Entry(202, "B", "K", "edit", 30)))
assert not valid((G1, Entry(203, "B", "K", "invalidate", 30)))
assert not valid((G1, Entry(204, "B", "K", "validate", 30)))
# Supported allocation and immutable authoring cannot produce this conflict.
assert not valid((G1, Entry(1, "A", "K", "add", 11)))

I1_BAD = Entry(10, "A", "Z", "invalidate", 10, (1, "A"))
GZ = Entry(1, "A", "Z", "add", 1)
I2_BAD = Entry(11, "A", "Z", "invalidate", 11, GZ.id)
V1_BAD = Entry(100, "B", "Z", "validate", 12, GZ.id, (("A", I2_BAD.id),))
V2_BAD = Entry(101, "B", "Z", "validate", 13, GZ.id, (("A", I1_BAD.id),))
assert not valid((GZ, I1_BAD, I2_BAD, V1_BAD, V2_BAD))  # context moves backward
assert not valid((GZ, I1_BAD, Entry(10, "B", "Z", "validate", 12, GZ.id, (("A", I1_BAD.id),))))  # observation must precede validation

def presence(es, key):
    xs = [e for e in es if e.key == key and e.action in ("add", "delete")]
    return max(xs, key=lambda e: e.id) if xs else None

def generation_for_materialized(es, key):
    """Resolve current generation through canonical presence authority."""
    p = presence(es, key)
    assert p is not None
    assert p.action == "add"
    return p

def value_heads(es, g):
    xs = [e for e in es if (e.action == "add" and e.id == g.id) or
          (e.action == "edit" and e.generation == g.id)]
    out = {}
    for e in xs:
        if e.author not in out or out[e.author].sequence < e.sequence: out[e.author] = e
    return frozenset(out.values())

def canonical_event(events, modified_at):
    """Select equal-wall-time provenance by JournalEntryId=(sequence, author)."""
    return max((e for e in events if e.time == modified_at), key=lambda e: e.id)

def value_revision(event):
    """Order supported value events by wall time, sequence, then author."""
    return (event.time, event.sequence, event.author)

# This verifier quantifies only over executions satisfying the synchronized
# wall-clock assumption. It models finite-resolution equality, not skew repair.
REV_G = (1, "R")
REV_SEQUENCE_10 = Entry(10, "A", "R", "edit", 200, REV_G)
REV_SEQUENCE_11 = Entry(11, "B", "R", "edit", 200, REV_G)
assert canonical_event((REV_SEQUENCE_10, REV_SEQUENCE_11), 200) == REV_SEQUENCE_11
assert value_revision(REV_SEQUENCE_11) > value_revision(REV_SEQUENCE_10)
REV_AUTHOR_A = Entry(12, "A", "R", "edit", 200, REV_G)
REV_AUTHOR_B = Entry(12, "B", "R", "edit", 200, REV_G)
assert canonical_event((REV_AUTHOR_A, REV_AUTHOR_B), 200) == REV_AUTHOR_B
assert value_revision(REV_AUTHOR_B) > value_revision(REV_AUTHOR_A)
REV_TIME_200 = Entry(1000, "A", "R", "edit", 200, REV_G)
REV_TIME_201 = Entry(1, "B", "R", "edit", 201, REV_G)
assert value_revision(REV_TIME_201) > value_revision(REV_TIME_200)
assert tuple(map(value_revision, (REV_SEQUENCE_11, REV_AUTHOR_B))) == (
    (200, 11, "B"), (200, 12, "B"))

def invalidate_frontier(es, g):
    out = {}
    for e in es:
        if e.action == "invalidate" and e.generation == g.id:
            if e.author not in out or out[e.author].sequence < e.sequence: out[e.author] = e
    return frozenset(out.values())

def covers(v, i):
    ref = dict(v.clears).get(i.author)
    return (v.action == "validate" and v.key == i.key and v.generation == i.generation and
            ref is not None and ref[1] == i.author and ref[0] >= i.sequence)

def effective(es, g):
    frontier = invalidate_frontier(es, g)
    return any(v.action == "validate" and v.generation == g.id and
               all(covers(v, i) for i in frontier) for v in es)

def validation_heads(es, g):
    out = {}
    for e in es:
        if e.action == "validate" and e.generation == g.id:
            if e.author not in out or out[e.author].sequence < e.sequence: out[e.author] = e
    return frozenset(out.values())

def compact(es):
    es = frozenset(es)
    maxima = {}
    for e in es:
        k = (e.author, e.key, e.action)
        if k not in maxima or maxima[k].sequence < e.sequence: maxima[k] = e
    keep = set(maxima.values())
    p = presence(es, "K")
    if p and p.action == "add":
        keep |= set(value_heads(es, p))
        keep |= set(invalidate_frontier(es, p))
        keep |= set(validation_heads(es, p))
    ids = {e.id: e for e in es}
    for e in tuple(keep):
        if e.generation is not None: keep.add(ids[e.generation])
        for _, ref in e.clears: keep.add(ids[ref])
    return frozenset(keep)

def projections(es):
    p = presence(es, "K")
    if not p or p.action != "add":
        return (p, None, frozenset(), frozenset(), frozenset(), False, frozenset(), frozenset())
    vh = value_heads(es, p)
    canonical_inputs = frozenset((t, max(e.id for e in vh if e.time == t))
                                 for t in {e.time for e in vh})
    frontier = invalidate_frontier(es, p)
    vals = validation_heads(es, p)
    maxima = {}
    for e in es:
        coordinate = (e.author, e.key, e.action)
        if coordinate not in maxima or maxima[coordinate].sequence < e.sequence:
            maxima[coordinate] = e
    retained_scoped = set(maxima.values()) | set(vh) | set(frontier) | set(vals)
    required_adds = frozenset(e.generation for e in retained_scoped if e.generation is not None)
    required_causal = frozenset(ref for e in retained_scoped for _, ref in e.clears)
    return (p, p.id, vh, canonical_inputs, frontier, effective(es, p), required_adds, required_causal)

# This model enumerates bounded histories satisfying the supported journal
# authoring/lifecycle invariants. Algebra and projection assertions quantify
# over that supported-state universe; they intentionally do not prove detection
# or recovery for arbitrary fabricated/corrupted Entry sets. Negative checks
# above are defensive validation examples, not a completeness proof.
VALID = []
for mask in range(1 << len(ATOMS)):
    state = frozenset().union(*(ATOMS[i] for i in range(len(ATOMS)) if mask & (1 << i)))
    assert valid(state)
    VALID.append(state)
VALID = sorted(set(VALID), key=lambda x: tuple(sorted(x)))
COMPACT = sorted(set(map(compact, VALID)), key=lambda x: tuple(sorted(x)))

# Explicitly prove the witness cases are present and retained.
hard = frozenset().union(ATOMS[0], ATOMS[1], ATOMS[2])
hard_compact = compact(hard)
assert E_OLD in hard_compact and E_CUR in hard_compact
assert I_OLD in hard_compact and I_CUR in hard_compact
assert V_OLD in hard_compact and V_CUR in hard_compact
assert (E_OLD.sequence > E_CUR.sequence and
        I_OLD.sequence > I_CUR.sequence and
        V_OLD.sequence > V_CUR.sequence)

# Critical causal traces, including an explicit hard invalidate while stale.
assert not effective({G2, V_CUR, I_CUR, I_A_LATE}, G2)
assert effective({G2, I_A_LATE, V_B_PART}, G2)
assert not effective({G2, I_A_LATE, I_C, V_B_PART, V_D_PART}, G2)
assert effective({G2, I_A_LATE, I_C, V_COMPLETE}, G2)
assert not effective({G2, I_A_LATE, I_C, V_COMPLETE, I_HARD}, G2)
assert effective({G2, I_A_LATE, I_C, I_HARD, V_AFTER_HARD}, G2)
assert not effective({G1, I_OLD, V_OLD, G2, I_CUR}, G2)
assert not effective({G2, I_A_LATE, I_C, V_COMPLETE, I_SYNC_HARD}, G2)
assert not effective({G2, I_A_LATE, I_C, V_COMPLETE, I_MIGRATION_HARD}, G2)
assert I_SYNC_HARD.sequence > max(I_A_LATE.sequence, I_C.sequence)
assert I_MIGRATION_HARD.sequence > max(I_A_LATE.sequence, I_C.sequence)

for j in VALID:
    assert compact(compact(j)) == compact(j)
    assert projections(compact(j)) == projections(j)
for a, b in product(COMPACT, repeat=2):
    assert compact(a | b) == compact(b | a)
    assert compact(a | a) == a
for a, b, c in product(COMPACT, repeat=3):
    assert compact(compact(a | b) | c) == compact(a | compact(b | c))
for a, b in product(VALID, repeat=2):
    assert compact(compact(a) | b) == compact(a | b)

# The finite universe checks the quadratic schema structure; the asymptotic
# result remains analytical. Raw immutable history may grow before optional
# canonical compaction.
for j in COMPACT:
    authors = {e.author for e in j} | {a for e in j for a, _ in e.clears}
    r = max(1, len(authors))
    serialized_units = len(j) + sum(len(e.clears) for e in j)
    assert serialized_units <= 5 * r * r + 5 * r
raw_repeated = {G2}
for sequence in range(200, 240):
    raw_repeated.add(Entry(sequence, "A", "K", "invalidate", sequence, G2.id))
assert len(raw_repeated) == 41
assert len(compact(raw_repeated)) == 2

@dataclass(frozen=True)
class ResetNode:
    identifier: str
    value: str
    created_at: int
    modified_at: int
    fresh: bool

@dataclass(frozen=True)
class ResetState:
    nodes: tuple[tuple[str, ResetNode], ...]
    input_edges: frozenset[tuple[str, str]]
    validity: frozenset[tuple[str, str]]
    journal: tuple[Entry, ...]
    clock: int
    watermark: int
    cursor: object
    next_identifier: int

def hard_stale(key, nodes, input_edges, validity):
    """Derive whether a stale materialization requires normal recomputation."""
    node = nodes[key]
    inputs = {source for source, dependent in input_edges if dependent == key}
    return (not node.fresh and
            (not inputs or any((source, key) not in validity for source in inputs)))

def valid_semantic_graph(nodes, input_edges, validity):
    if not input_edges.issuperset(validity): return False
    if any(source not in nodes or dependent not in nodes
           for source, dependent in input_edges): return False
    for key, node in nodes.items():
        if node.fresh:
            inputs = {source for source, dependent in input_edges if dependent == key}
            if any(not nodes[source].fresh for source in inputs): return False
            if any((source, key) not in validity for source in inputs): return False
    return True

def reset(state, target_nodes, target_input_edges, target_validity, now):
    """Model one atomic authoritative semantic reconciliation."""
    before = dict(state.nodes); final = {}; authored = []
    clock = state.clock
    for key in sorted(set(before) | set(target_nodes)):
        old = before.get(key); desired = target_nodes.get(key)
        if desired is None:
            if old is not None:
                clock += 1; authored.append(Entry(clock, "R", key, "delete", now))
            continue
        value, fresh = desired
        value_changed = old is None or old.value != value
        if value_changed:
            identifier = f"receiver-{state.next_identifier + len([n for k, n in final.items() if k not in before])}"
            if old is not None: identifier = old.identifier
            created = modified = now
            if old is not None: created = old.created_at
            clock += 1; generation = (clock, "R")
            authored.append(Entry(clock, "R", key, "add", now))
        else:
            identifier = old.identifier; created = old.created_at
            modified = old.modified_at
            generation = generation_for_materialized(
                state.journal + tuple(authored), key).id
        candidate = ResetNode(identifier, value, created, modified, fresh)
        prospective = dict(final); prospective[key] = candidate
        final_hard = hard_stale(key, prospective, target_input_edges,
                                target_validity)
        old_hard = (old is not None and
                    hard_stale(key, before, state.input_edges, state.validity))
        if old is not None and old.fresh and not fresh:
            clock += 1; authored.append(Entry(clock, "R", key, "invalidate", now, generation))
        elif old is not None and not old.fresh and fresh:
            frontier = invalidate_frontier(state.journal + tuple(authored),
                                           next(e for e in state.journal + tuple(authored) if e.id == generation))
            clears = tuple(sorted((e.author, e.id) for e in frontier))
            clock += 1; authored.append(Entry(clock, "R", key, "validate", now, generation, clears))
        elif not fresh and final_hard and (value_changed or not old_hard):
            clock += 1; authored.append(Entry(clock, "R", key, "invalidate", now, generation))
        final[key] = candidate
    translated_validity = frozenset(target_validity)
    assert valid_semantic_graph(final, target_input_edges, translated_validity)
    changed = (final != before or target_input_edges != state.input_edges or
               translated_validity != state.validity or authored)
    if not changed:
        return state
    return ResetState(tuple(sorted(final.items())), target_input_edges,
                      translated_validity,
                      state.journal + tuple(authored), clock,
                      state.watermark + len(authored), state.cursor,
                      state.next_identifier + sum(k not in before for k in final))

# Exhaust the closed reset value/presence matrix. Value equality is semantic;
# timestamps do not participate in target equality.
ABSENT = None
for current, target in product((ABSENT, "A", "B"), repeat=2):
    initial_entries = () if current is None else (Entry(1, "R", "K", "add", 10),)
    initial_nodes = () if current is None else (("K", ResetNode("receiver-1", current, 10, 10, True)),)
    initial = ResetState(initial_nodes, frozenset(), frozenset(), initial_entries,
                         len(initial_entries), len(initial_entries), object(), 2)
    desired = {} if target is None else {"K": (target, True)}
    result = reset(initial, desired, frozenset(), frozenset(), 100)
    actions = [e.action for e in result.journal[len(initial.journal):]
               if e.action in ("add", "edit", "delete")]
    expected = ([] if current == target else
                ["add"] if current is None else
                ["delete"] if target is None else ["add"])
    assert actions == expected
    if target is not None:
        node = dict(result.nodes)["K"]
        if current == target:
            assert node.modified_at == 10 and result is initial
        else:
            value_events = [e for e in result.journal[len(initial.journal):]
                            if e.action in ("add", "edit")]
            assert len(value_events) == 1
            value_event = value_events[0]
            assert value_event.time == node.modified_at == 100

# Freshness-only transitions preserve semantic modification time. Validation
# names the complete receiver-local frontier; stale proof hardening emits a
# new barrier even without a public freshness transition.
base_add = Entry(1, "R", "K", "add", 10)
old_invalidate = Entry(2, "R", "K", "invalidate", 20, base_add.id)
fresh_state = ResetState((("K", ResetNode("receiver-1", "A", 10, 10, True)),),
                         frozenset(), frozenset(), (base_add,), 1, 1, object(), 2)
stale = reset(fresh_state, {"K": ("A", False)}, frozenset(), frozenset(), 100)
assert dict(stale.nodes)["K"].modified_at == 10 and stale.journal[-1].action == "invalidate"
old_stale = ResetState((("K", ResetNode("receiver-1", "A", 10, 10, False)),),
                       frozenset(), frozenset(), (base_add, old_invalidate), 2, 2, object(), 2)
fresh = reset(old_stale, {"K": ("A", True)}, frozenset(), frozenset(), 100)
assert fresh.journal[-1].action == "validate"
assert dict(fresh.journal[-1].clears) == {"R": old_invalidate.id}
# A changed hard-stale value receives a post-value barrier. A validation which
# can clear only the old frontier cannot cover the new obligation.
changed_stale = reset(old_stale, {"K": ("B", False)}, frozenset(), frozenset(), 100)
new_add, new_barrier = changed_stale.journal[-2:]
assert new_add.action == "add" and new_barrier.action == "invalidate"
assert new_add.sequence < new_barrier.sequence and not covers(
    Entry(99, "U", "K", "validate", 99, base_add.id,
          (("R", old_invalidate.id),)), new_barrier)

# Dependency validity is relowered by semantic key. The unchanged dependent
# keeps its receiver identifier and timestamp while remaining coherently fresh.
dep_state = ResetState((
    ("A", ResetNode("receiver-A", "a1", 10, 10, True)),
    ("D", ResetNode("receiver-D", "d", 20, 20, True))),
    frozenset({("A", "D")}), frozenset({("A", "D")}),
    (Entry(1, "R", "A", "add", 10), Entry(2, "R", "D", "add", 20)),
    2, 2, object(), 3)
dep_reset = reset(dep_state, {"A": ("a2", True),
                              "D": ("d", True)},
                  frozenset({("A", "D")}), frozenset({("A", "D")}), 100)
dep_actions = [(e.key, e.action) for e in dep_reset.journal[len(dep_state.journal):]]
assert dep_actions == [("A", "add")]
assert dict(dep_reset.nodes)["D"].modified_at == 20
assert dict(dep_reset.nodes)["D"].fresh and dep_reset.validity == frozenset({("A", "D")})

# Complete idempotence includes graph, journal, identity, allocators and cursor.
assert reset(dep_reset, {"A": ("a2", True), "D": ("d", True)},
             frozenset({("A", "D")}), frozenset({("A", "D")}), 200) is dep_reset

# Hard-staleness is derived rather than stored. A stale zero-input node needs
# normal computation, while a stale derived node with all incoming proofs can
# be cache-only revalidated. Proof edges outside the dependency graph or with
# absent endpoints are rejected before relowering.
assert hard_stale("K", dict(old_stale.nodes), frozenset(), frozenset())
derived_nodes = {
    "A": ResetNode("receiver-A", "a", 10, 10, True),
    "D": ResetNode("receiver-D", "d", 20, 20, False),
}
assert not hard_stale("D", derived_nodes, frozenset({("A", "D")}),
                      frozenset({("A", "D")}))
assert hard_stale("D", derived_nodes, frozenset({("A", "D")}), frozenset())
assert not valid_semantic_graph(derived_nodes, frozenset({("A", "D")}),
                                frozenset({("X", "D")}))
harden_add_a = Entry(1, "R", "A", "add", 10)
harden_add_d = Entry(2, "R", "D", "add", 20)
hardenable = ResetState(tuple(sorted(derived_nodes.items())),
                        frozenset({("A", "D")}),
                        frozenset({("A", "D")}),
                        (harden_add_a, harden_add_d), 2, 2, object(), 3)
hardened = reset(hardenable, {"A": ("a", True), "D": ("d", False)},
                 frozenset({("A", "D")}), frozenset(), 100)
assert hardened.journal[-1].action == "invalidate"
assert hardened.journal[-1].generation == harden_add_d.id

# A changed-value reset add is a fresh presence generation above every observed
# receiver entry. The synchronized later reset occurs at time 250; generation
# authority, rather than timestamp comparison, makes the old edit inapplicable.
reset_generation_add = Entry(1, "B", "K", "add", 100)
reset_generation_edit = Entry(10, "B", "K", "edit", 200, reset_generation_add.id)
reset_generation_state = ResetState(
    (("K", ResetNode("receiver-K", "B", 100, 200, True)),),
    frozenset(), frozenset(), (reset_generation_add, reset_generation_edit), 10, 2, object(), 2)
reset_generation_result = reset(reset_generation_state, {"K": ("A", True)},
                                frozenset(), frozenset(), 250)
reset_add = reset_generation_result.journal[-1]
assert reset_add.action == "add" and reset_add.sequence > reset_generation_edit.sequence
assert reset_add.time == dict(reset_generation_result.nodes)["K"].modified_at == 250
assert presence(reset_generation_result.journal, "K") == reset_add
assert reset_generation_edit not in value_heads(reset_generation_result.journal, reset_add)

# Physical tuple order is not presence authority. G1 is learned after the
# winning G2 and its invalidate, but its lower JournalEntryId remains losing.
delayed_g2 = Entry(20, "A", "K", "add", 20)
delayed_i2 = Entry(21, "A", "K", "invalidate", 21, delayed_g2.id)
delayed_g1 = Entry(10, "B", "K", "add", 10)
delayed_state = ResetState(
    (("K", ResetNode("receiver-K", "A", 20, 20, False)),),
    frozenset(), frozenset(), (delayed_g2, delayed_i2, delayed_g1),
    21, 3, object(), 2)
assert delayed_state.journal[-1] == delayed_g1
assert presence(delayed_state.journal, "K") == delayed_g2
assert generation_for_materialized(delayed_state.journal, "K") == delayed_g2
delayed_reset = reset(delayed_state, {"K": ("A", True)},
                      frozenset(), frozenset(), 30)
delayed_validate = delayed_reset.journal[-1]
assert delayed_validate.action == "validate"
assert delayed_validate.generation == delayed_g2.id
assert covers(delayed_validate, delayed_i2)
assert valid(delayed_reset.journal)
assert dict(delayed_reset.nodes)["K"].modified_at == 20
assert not any(e.action in ("add", "edit")
               for e in delayed_reset.journal[len(delayed_state.journal):])

# Materialized graph state without an add-valued winning presence head is not a
# supported model state and cannot silently acquire a null generation.
invalid_presence = ResetState(
    (("K", ResetNode("receiver-K", "A", 20, 20, False)),),
    frozenset(), frozenset(),
    (delayed_g2, Entry(30, "A", "K", "delete", 30)),
    30, 2, object(), 2)
invalid_presence_rejected = False
try:
    reset(invalid_presence, {"K": ("A", True)},
          frozenset(), frozenset(), 40)
except AssertionError:
    invalid_presence_rejected = True
assert invalid_presence_rejected

FP_A = "aaaaaaaaaaaaaaaa"
FP_B = "bbbbbbbbbbbbbbbb"
FP_C = "cccccccccccccccc"
FP_R = "rrrrrrrrrrrrrrrr"
UINT64_MAX = 2**64 - 1

@dataclass(frozen=True, order=True)
class Index:
    sequence: int
    appender: str

@dataclass(frozen=True, order=True)
class Record:
    index: Index
    key: str
    node_name: str
    bindings: tuple[str, ...]
    time: int

@dataclass(frozen=True)
class Token:
    node_name: str
    bindings: tuple[str, ...]
    action: str
    time: int
    position: tuple[Index, int]
    issued_by: str
    issued_at_high_watermark: Index
    signed_payload: str = ""
    signature: str = ""

@dataclass(frozen=True)
class NotificationState:
    host: str
    records: frozenset[Record]
    clock: int
    high: Index
    coverage: tuple[tuple[str, Index], ...]
    verification_keys: tuple[tuple[str, str], ...]
    signing_key: str
    views: tuple[tuple[str, str], ...] = ()

BASE = Index(0, "")
PRIVATE_KEYS = {FP_A: "private-a", FP_B: "private-b", FP_C: "private-c", FP_R: "private-r"}
PUBLIC_KEYS = {FP_A: "public-a", FP_B: "public-b", FP_C: "public-c", FP_R: "public-r"}
SIGNATURE_ORACLE = set()

class InvalidPossibleChangeCursorError(Exception):
    pass

def valid_fingerprint(value):
    return len(value) == 16 and value.isascii() and value.isalpha() and value.islower()

def node_key(node_name, bindings):
    return node_name + ":" + ",".join(bindings)

def valid_record(record):
    return record.key == node_key(record.node_name, record.bindings)

def compact_n(records):
    assert all(valid_record(record) for record in records)
    winners = {}
    for record in records:
        if record.key not in winners or record.index > winners[record.key].index:
            winners[record.key] = record
    return frozenset(winners.values())

def merge_n(a, b):
    return compact_n(a | b)

def projections(records, cursor=(BASE, -1), keys=None):
    return tuple((r, ordinal, action) for r in sorted(records)
                 if keys is None or r.key in keys
                 for ordinal, action in enumerate(ACTIONS)
                 if (r.index, ordinal) > cursor)

def issue_token(record, ordinal, issuer, high):
    """Derive every public field from a self-contained surviving record."""
    return Token(record.node_name, record.bindings, ACTIONS[ordinal], record.time,
                 (record.index, ordinal), issuer, high)

def token_payload(token):
    index, ordinal = token.position
    return "|".join(("v1", token.node_name, ",".join(token.bindings), token.action,
                     str(token.time), str(index.sequence), index.appender,
                     str(ordinal), token.issued_by,
                     str(token.issued_at_high_watermark.sequence),
                     token.issued_at_high_watermark.appender))

def model_sign(token, private_key):
    """Register an abstract Ed25519 signature; cryptography is outside this model."""
    payload = token_payload(token)
    issuer = token.issued_by
    if PRIVATE_KEYS[issuer] != private_key:
        raise InvalidPossibleChangeCursorError
    signature = hashlib.sha512((private_key + "\0" + payload).encode()).hexdigest()
    SIGNATURE_ORACLE.add((PUBLIC_KEYS[issuer], payload, signature))
    return payload + "|" + signature

def canonical_uint64(value):
    if not value or (len(value) > 1 and value[0] == "0") or not value.isascii() or not value.isdecimal():
        raise InvalidPossibleChangeCursorError
    result = int(value)
    if result < 0 or result > UINT64_MAX:
        raise InvalidPossibleChangeCursorError
    return result

def token_from_string(value):
    fields = value.split("|")
    if len(fields) != 12 or fields[0] != "v1":
        raise InvalidPossibleChangeCursorError
    try:
        node_name, bindings, action = fields[1], tuple(filter(None, fields[2].split(","))), fields[3]
        time = canonical_uint64(fields[4]); sequence = canonical_uint64(fields[5])
        ordinal = int(fields[7]); high_sequence = canonical_uint64(fields[9])
        index = Index(sequence, fields[6]); high = Index(high_sequence, fields[10]); issuer = fields[8]
        if not node_name or "|" in node_name or fields[7] != str(ordinal) or not 0 <= ordinal < len(ACTIONS):
            raise InvalidPossibleChangeCursorError
        if action not in ACTIONS or action != ACTIONS[ordinal]:
            raise InvalidPossibleChangeCursorError
        if not valid_fingerprint(index.appender) or not valid_fingerprint(issuer):
            raise InvalidPossibleChangeCursorError
        if index > high or not valid_fingerprint(high.appender):
            raise InvalidPossibleChangeCursorError
        return Token(node_name, bindings, action, time, (index, ordinal), issuer, high,
                     "|".join(fields[:11]), fields[11])
    except (KeyError, ValueError, IndexError):
        raise InvalidPossibleChangeCursorError

def query_n(state, token, keys=None):
    if token.position[0] > token.issued_at_high_watermark:
        raise InvalidPossibleChangeCursorError
    public_key = dict(state.verification_keys).get(token.issued_by)
    if (public_key, token.signed_payload, token.signature) not in SIGNATURE_ORACLE:
        raise InvalidPossibleChangeCursorError
    if dict(state.coverage).get(token.issued_by, BASE) < token.issued_at_high_watermark:
        raise InvalidPossibleChangeCursorError
    return projections(state.records, token.position, keys)

def make_state(host, records=(), views=()):
    records = frozenset(records); high = max((r.index for r in records), default=BASE)
    return NotificationState(host, records,
        max((r.index.sequence for r in records), default=0), high,
        ((host, high),), ((host, PUBLIC_KEYS[host]),), PRIVATE_KEYS[host], tuple(sorted(views)))

def synchronize(receiver, source, final_views):
    merged = set(receiver.records | source.records)
    clock = max(receiver.clock, source.clock, receiver.high.sequence, source.high.sequence)
    rviews, sviews, fviews = map(dict, (receiver.views, source.views, final_views))
    source_newer = any(w > dict(receiver.coverage).get(h, BASE) for h, w in source.coverage)
    thresholds = {}
    for key in set(rviews) | set(fviews):
        if rviews.get(key) != fviews.get(key): thresholds[key] = receiver.high
    if source_newer:
        for key in set(sviews) | set(fviews):
            if sviews.get(key) != fviews.get(key):
                thresholds[key] = max(thresholds.get(key, BASE), source.high)
    for key, threshold in thresholds.items():
        if not any(r.key == key and r.index > threshold for r in merged):
            clock = max(clock, threshold.sequence) + 1
            witnesses = [record for record in merged if record.key == key]
            if not witnesses: raise AssertionError("notification view lacks semantic address witness")
            witness = max(witnesses, key=lambda record: record.index)
            merged.add(Record(Index(clock, receiver.host), key, witness.node_name,
                              witness.bindings, witness.time))
    high = max(receiver.high, source.high, max((r.index for r in merged), default=BASE))
    coverage = dict(receiver.coverage)
    for host, watermark in source.coverage: coverage[host] = max(coverage.get(host, BASE), watermark)
    coverage[receiver.host] = high
    verification = dict(receiver.verification_keys)
    for host, key in source.verification_keys:
        if host in verification and verification[host] != key: raise AssertionError("issuer key conflict")
        verification[host] = key
    return NotificationState(receiver.host, compact_n(merged), clock, high,
        tuple(sorted(coverage.items())), tuple(sorted(verification.items())),
        receiver.signing_key, tuple(sorted(final_views)))

# Positional stability, gaps, ordinals, and notification ACI/deletion transparency.
records = frozenset(Record(Index(n, FP_A), node_key("node-" + key.lower(), ()), "node-" + key.lower(), (), n) for n, key in ((10,"K"),(20,"B"),(30,"C"),(40,"D")))
old_cursor = (Index(10, FP_A), 4); compacted = compact_n(records | {Record(Index(50,FP_A), node_key("node-k", ()), "node-k", (), 10)})
assert [r.node_name for r,o,a in projections(compacted, old_cursor) if o == 0] == ["node-b","node-c","node-d","node-k"]
assert projections(compacted, (Index(11,FP_A),4))
assert [a for r,o,a in projections({Record(Index(10,FP_A), node_key("node-k", ()), "node-k", (), 10)}, (Index(10,FP_A),1))] == list(ACTIONS[2:])
universe = tuple(Record(Index(i,a),node_key("node-" + k.lower(), ()),"node-" + k.lower(),(),i) for i,a,k in ((1,FP_A,"K"),(2,FP_A,"K"),(2,FP_B,"L"),(3,FP_A,"L")))
sets = [frozenset(universe[i] for i in range(4) if mask & (1<<i)) for mask in range(16)]
compaction_checks = deletion_checks = 0
for n in sets:
    compacted_n = compact_n(n); assert compact_n(compacted_n) == compacted_n and compacted_n <= n
    for cursor in [(BASE,-1)] + [(r.index,o) for r in universe for o in range(5)]:
        before = projections(n,cursor)
        assert projections(compacted_n,cursor) == tuple(x for x in before if x[0] in compacted_n)
        deletion_checks += 1
    for b in sets:
        assert compact_n(compacted_n | b) == compact_n(n | b)
        assert merge_n(n,b) == merge_n(b,n); compaction_checks += 1
for a in sets:
  for b in sets:
    for c in sets: assert merge_n(merge_n(a,b),c) == merge_n(a,merge_n(b,c))

# Authenticated codec and every normative impossible-token rejection.
a = make_state(FP_A, [Record(Index(100,FP_A), node_key("node-k", ()), "node-k", (), 50)], [(node_key("node-k", ()),"source")])
source_record = next(record for record in a.records if record.key == node_key("node-k", ()))
token = issue_token(source_record, 4, FP_A, a.high)
assert (token.node_name, token.bindings, token.action, token.time) == (source_record.node_name, source_record.bindings, "validate", source_record.time)
encoded = model_sign(token, a.signing_key); decoded = token_from_string(encoded); assert decoded.node_name == token.node_name and decoded.bindings == token.bindings and decoded.action == token.action and decoded.time == token.time and decoded.position == token.position and decoded.issued_by == token.issued_by and decoded.issued_at_high_watermark == token.issued_at_high_watermark
invalid_tokens = [
    Token("node", (), "validate", 50, (Index(100,FP_A),5),FP_A,a.high),
    Token("node", (), "validate", 50, (Index(UINT64_MAX+1,FP_A),4),FP_A,Index(UINT64_MAX+1,FP_A)),
    Token("node", (), "validate", 50, (Index(101,FP_A),4),FP_A,a.high),
    Token("node", (), "validate", 50, (Index(100,"bad"),4),FP_A,a.high),
    Token("node", (), "validate", 50, (Index(100,FP_A),4),"bad",a.high),
]
invalid_token_checks = 0
for invalid in invalid_tokens:
    try:
        fabricated = model_sign(invalid, a.signing_key)
        token_from_string(fabricated)
        raise AssertionError("invalid token accepted")
    except (InvalidPossibleChangeCursorError, KeyError):
        invalid_token_checks += 1
tampered = encoded.replace("|100|", "|99|", 1)
tampered_token = token_from_string(tampered)
try: query_n(a, tampered_token); raise AssertionError("tampered token accepted")
except InvalidPossibleChangeCursorError: invalid_token_checks += 1

# Coverage, sync, high-watermark, restart, and graph-silent controlled reset.
b0 = make_state(FP_B, [Record(Index(90,FP_B), node_key("node-k", ()), "node-k", (), 40)], [(node_key("node-k", ()),"receiver")])
try: query_n(b0, decoded); raise AssertionError("uncovered token accepted")
except InvalidPossibleChangeCursorError: pass
b_equal = synchronize(b0,a,((node_key("node-k", ()),"source"),)); assert query_n(b_equal,decoded) == ()
b_diff = synchronize(b0,a,((node_key("node-k", ()),"final-B"),)); assert query_n(b_diff,decoded)
assert any(r.key == node_key("node-k", ()) and r.index > a.high for r in b_diff.records)
source150 = make_state(FP_A,[Record(Index(150,FP_A), node_key("node-k", ()), "node-k", (), 50)],[(node_key("node-k", ()),"source")])
assert max(r.index for r in synchronize(b0,source150,((node_key("node-k", ()),"source"),)).records if r.key==node_key("node-k", ())) == Index(150,FP_A)
assert synchronize(b_diff,a,((node_key("node-k", ()),"final-B"),)) == b_diff
# Full public payload and hidden authority round-trip without consulting the record.
recordless_restored = NotificationState(a.host,frozenset(),a.clock,a.high,a.coverage,a.verification_keys,a.signing_key,a.views)
round_tripped = token_from_string(encoded)
assert (round_tripped.node_name, round_tripped.bindings, round_tripped.action, round_tripped.time) == (token.node_name, token.bindings, token.action, token.time)
assert round_tripped.position == token.position and query_n(recordless_restored,round_tripped) == ()
restored = NotificationState(a.host,a.records,a.clock,a.high,a.coverage,a.verification_keys,a.signing_key,a.views)
assert query_n(restored,token_from_string(encoded)) == query_n(a,decoded)
# Once foreign lineage is covered, local append, compaction, and restart preserve it.
foreign_covered = b_equal
local_clock = max(foreign_covered.clock, foreign_covered.high.sequence) + 1
local_record = Record(Index(local_clock, FP_B), node_key("node-l", ()), "node-l", (), 60)
foreign_coverage = dict(foreign_covered.coverage); foreign_coverage[FP_B] = local_record.index
foreign_covered = NotificationState(FP_B, foreign_covered.records | {local_record}, local_clock,
    local_record.index, tuple(sorted(foreign_coverage.items())), foreign_covered.verification_keys,
    foreign_covered.signing_key, foreign_covered.views)
foreign_covered = NotificationState(FP_B, compact_n(foreign_covered.records), foreign_covered.clock,
    foreign_covered.high, foreign_covered.coverage, foreign_covered.verification_keys,
    foreign_covered.signing_key, foreign_covered.views)
foreign_covered = NotificationState(FP_B, foreign_covered.records, foreign_covered.clock,
    foreign_covered.high, foreign_covered.coverage, foreign_covered.verification_keys,
    foreign_covered.signing_key, foreign_covered.views)
assert dict(foreign_covered.coverage)[FP_A] >= token.issued_at_high_watermark
assert query_n(foreign_covered, decoded) == query_n(foreign_covered, round_tripped)
reset_receiver = make_state(FP_R,[],[(node_key("node-k", ()),"source")]) # graph already equal
reset_final = synchronize(reset_receiver,a,((node_key("node-k", ()),"source"),))
assert reset_final.views == reset_receiver.views and dict(reset_final.coverage)[FP_A] >= a.high
assert query_n(reset_final,decoded) == () and synchronize(reset_final,a,((node_key("node-k", ()),"source"),)) == reset_final
high_state = make_state(FP_A,[Record(Index(500,FP_A), node_key("node-k", ()), "node-k", (), 1),Record(Index(600,FP_A), node_key("node-k", ()), "node-k", (), 2)],[(node_key("node-k", ()),"A")])
high_state = NotificationState(FP_A,compact_n(high_state.records),600,high_state.high,high_state.coverage,high_state.verification_keys,high_state.signing_key,high_state.views)
replayed = synchronize(high_state,make_state(FP_C,[Record(Index(50,FP_C), node_key("node-k", ()), "node-k", (), 1)],[(node_key("node-k", ()),"C")]),((node_key("node-k", ()),"C"),))
assert max(r.index for r in replayed.records) > Index(600,FP_A)

# Exhaust transition words and preserve every action obligation through later
# append, imported sync, migration-equivalent append, reset-equivalent append,
# compaction, restart, and no-op prefixes.
ops = ("appendK","appendL","appendM","syncK","syncL","migrationK","migrationL","resetK","resetL","compact","restart","noop")
words_checked = prefixes_checked = obligations_checked = 0
for word in product(ops, repeat=4):
    state = make_state(FP_A); obligations = []
    for op in word:
        before = state
        if op in ("appendK","appendL","appendM","migrationK","migrationL","resetK","resetL"):
            key = "L" if op in ("appendL","migrationL","resetL") else ("M" if op == "appendM" else "K")
            record_key = node_key("node-" + key.lower(), ())
            clock = max(state.clock,state.high.sequence)+1; record=Record(Index(clock,FP_A),node_key("node-" + key.lower(), ()),"node-" + key.lower(),(),clock)
            coverage = dict(state.coverage); coverage[state.host] = record.index
            state = NotificationState(FP_A,state.records|{record},clock,record.index,
                tuple(sorted(coverage.items())),state.verification_keys,state.signing_key,state.views)
            obligations += [(cursor,record_key,action) for cursor in [(BASE,-1)]+[(r.index,o) for r in before.records for o in range(5)] for action in ACTIONS]
        elif op in ("syncK","syncL"):
            key = "L" if op == "syncL" else "K"
            record_key = node_key("node-" + key.lower(), ())
            source = make_state(FP_B,[Record(Index(max(1,state.high.sequence+1),FP_B),node_key("node-" + key.lower(), ()),"node-" + key.lower(),(),1)],[(record_key,"remote")])
            state = synchronize(state,source,((record_key,"remote"),))
            obligations += [(cursor,record_key,action) for cursor in [(BASE,-1)]+[(r.index,o) for r in before.records for o in range(5)] for action in ACTIONS]
        elif op == "compact":
            state = NotificationState(state.host,compact_n(state.records),state.clock,state.high,state.coverage,state.verification_keys,state.signing_key,state.views)
        elif op == "restart":
            state = NotificationState(state.host,state.records,state.clock,state.high,state.coverage,state.verification_keys,state.signing_key,state.views)
        else: assert state == before
        for cursor,key,action in obligations:
            # An obligation is discharged only for a cursor already across its
            # covering record; otherwise a later same-key all-actions record exists.
            assert any(r.key == key and (r.index,ACTIONS.index(action)) > cursor for r in state.records)
            obligations_checked += 1
        old_coverage, new_coverage = dict(before.coverage), dict(state.coverage)
        assert all(new_coverage.get(host, BASE) >= watermark for host, watermark in old_coverage.items())
        assert new_coverage[state.host] == state.high
        assert set(new_coverage) <= set(dict(state.verification_keys))
        assert state.high >= max((r.index for r in state.records),default=BASE)
        prefixes_checked += 1
    words_checked += 1

# Derive storage counts from reachable combined state, including reset-only
# fingerprints and notification-only keys absent from logical authority.
storage_state = reset_final
logical_keys = {"logical-only"}; logical_authors = {FP_R}
combined_n = len(logical_keys | {r.key for r in storage_state.records})
combined_r = len(logical_authors | set(dict(storage_state.coverage)) | set(dict(storage_state.verification_keys)))
notification_count = len(compact_n(storage_state.records)); coverage_count = len(storage_state.coverage)
assert notification_count <= combined_n and coverage_count <= combined_r
assert notification_count + coverage_count <= combined_n * combined_r * combined_r + combined_n + combined_r

print(f"supported combined logical states: {len(VALID)}")
print(f"projection preservation checks: {len(VALID)}")
print(f"distinct compact logical states: {len(COMPACT)}")
print(f"merge triples checked: {len(COMPACT) ** 3}")
print(f"compaction closure pairs checked: {len(VALID) ** 2}")
print(f"notification sets checked: {len(sets)}")
print(f"notification compaction pair checks: {compaction_checks}")
print(f"notification associative merge triples: {len(sets) ** 3}")
print(f"deletion-transparency cursor/filter checks: {deletion_checks}")
print(f"authenticated invalid-token rejection checks: {invalid_token_checks}")
print("full-payload recordless round-trip checks: 1")
print("foreign-coverage append/compact/restart persistence traces: 1")
print(f"componentwise coverage/key-metadata prefix checks: {prefixes_checked}")
print(f"notification transition words checked: {words_checked}")
print(f"notification transition prefixes checked: {prefixes_checked}")
print(f"action-specific obligation checks: {obligations_checked}")
print("all exhaustive bounded journal checks passed")
