#!/usr/bin/env python3
"""Bounded journal model; integer times are ordered/equal DateTime atoms."""
"""Exhaustive bounded checks for the IncrementalGraph journal specification."""
from dataclasses import dataclass
from itertools import product

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

@dataclass(frozen=True)
class Stored:
    entries: tuple[tuple[str, int], ...]  # logical id -> local index, encoded as label/index
    watermark: int
    domain: object

def put(state, label):
    d = dict(state.entries)
    if label in d: return state
    w = state.watermark + 1; d[label] = w
    return Stored(tuple(sorted(d.items())), w, state.domain)

def touch(state, label):
    d = dict(state.entries); w = state.watermark + 1; d[label] = w
    return Stored(tuple(sorted(d.items())), w, state.domain)

def remove_and_cover(state, removed, witness):
    d = dict(state.entries)
    for x in removed: d.pop(x, None)
    base = Stored(tuple(sorted(d.items())), state.watermark, state.domain)
    return touch(base, witness)

def issued_cursors(state):
    return [(state.domain, -1, len(ACTIONS)-1)] + [
        (state.domain, idx, ordinal) for _, idx in state.entries for ordinal in range(len(ACTIONS))]

def query(state, cursor):
    domain, cursor_index, cursor_ordinal = cursor
    if domain is not state.domain:
        raise InvalidPossibleChangeCursorError
    return {(label, action) for label, idx in state.entries
            for ordinal, action in enumerate(ACTIONS)
            if (idx, ordinal) > (cursor_index, cursor_ordinal)}

class InvalidPossibleChangeCursorError(Exception):
    pass

# Receiver domains reject foreign cursors before interpreting either baselines
# or enormous numeric positions. Same-process cutover preserves private runtime
# identity; new-runtime restoration deliberately replaces it.
DOMAIN_A = object(); DOMAIN_B = object()
A1 = put(Stored((), 0, DOMAIN_A), "K1")
B = put(Stored((), 0, DOMAIN_B), "K1")
cursor_a = (DOMAIN_A, 10_000, len(ACTIONS) - 1)
cursor_b = (DOMAIN_B, 10_000, len(ACTIONS) - 1)
baseline_a = issued_cursors(A1)[0]
baseline_b = issued_cursors(B)[0]
for receiver, foreign in ((A1, cursor_b), (B, cursor_a),
                          (A1, baseline_b), (B, baseline_a)):
    try:
        query(receiver, foreign)
        raise AssertionError("foreign cursor accepted")
    except InvalidPossibleChangeCursorError:
        pass
A1_cursor = issued_cursors(A1)[-1]
A2 = Stored(A1.entries, A1.watermark, A1.domain)
assert query(A2, A1_cursor) == query(A1, A1_cursor)

# An issued token snapshots its numeric position. Touch moves only the retained
# witness: querying from the old token still starts after index 1, not index 2.
snapshot_state = put(Stored((), 0, DOMAIN_A), "K-snapshot")
snapshot_cursor = issued_cursors(snapshot_state)[-1]
touched_snapshot_state = touch(snapshot_state, "K-snapshot")
assert snapshot_cursor[1] == 1
assert dict(touched_snapshot_state.entries)["K-snapshot"] == 2
assert query(touched_snapshot_state, snapshot_cursor) == {
    ("K-snapshot", action) for action in ACTIONS}

NEW_RUNTIME_DOMAIN = object()
A_RESTORED = Stored(A1.entries, A1.watermark, NEW_RUNTIME_DOMAIN)
try:
    query(A_RESTORED, A1_cursor)
    raise AssertionError("old-runtime cursor accepted after restoration")
except InvalidPossibleChangeCursorError:
    pass

# Exhaust every four-operation word and check obligations after every prefix.
ops = ("installK1", "authorK2", "installL", "graphAddK", "graphDeleteK",
       "graphInvalidateK", "graphValidateL", "syncHardenK", "migrationHardenK",
       "compactK", "graphCompactK", "noop")
states_checked = 0; prefixes_checked = 0; obligations_checked = 0; max_records = 0
for word in product(ops, repeat=4):
    s = Stored((), 0, DOMAIN_A); obligations = []
    for op in word:
        before = s
        if op in ("installK1", "authorK2", "installL"):
            label = {"installK1": "K1", "authorK2": "K2", "installL": "L"}[op]
            s = put(s, label)
            if s != before:
                key = "L" if op == "installL" else "K"
                action = {"installK1": "add", "authorK2": "edit",
                          "installL": "validate"}[op]
                obligations += [(c, key, action) for c in issued_cursors(before)]
        elif op in ("syncHardenK", "migrationHardenK"):
            # A stale-to-stale hardening decision authors one barrier. Repeating
            # the settled same decision carries it instead of authoring forever.
            candidates = [k for k, _ in s.entries if k.startswith("K")]
            if candidates:
                label = "KS" if op == "syncHardenK" else "KM"
                s = put(s, label)
                if s != before:
                    obligations += [(c, "K", "invalidate")
                                    for c in issued_cursors(before)]
        elif op.startswith("graph") and op != "graphCompactK":
            key = "L" if op == "graphValidateL" else "K"
            candidates = [k for k, _ in s.entries if k.startswith(key)]
            if candidates:
                witness = max(candidates); old_count = len(s.entries)
                s = touch(s, witness)
                assert len(s.entries) == old_count
                action = {"graphAddK": "add", "graphDeleteK": "delete",
                          "graphInvalidateK": "invalidate",
                          "graphValidateL": "validate"}[op]
                obligations += [(c, key, action) for c in issued_cursors(before)]
        elif op == "compactK" and all(k in dict(s.entries) for k in ("K1", "K2")):
            s = remove_and_cover(s, ("K1",), "K2")
        elif op == "graphCompactK" and all(k in dict(s.entries) for k in ("K1", "K2")):
            # One transaction performs a graph edit, logical removal, and one covering touch.
            s = remove_and_cover(s, ("K1",), "K2")
            obligations += [(c, "K", "edit") for c in issued_cursors(before)]
        elif op == "noop":
            assert s == before

        indexes = [idx for _, idx in s.entries]
        assert len(indexes) == len(set(indexes))
        assert all(idx <= s.watermark for idx in indexes)
        max_records = max(max_records, len(s.entries))
        # Immediate prefix check, then preservation is rechecked after every later prefix.
        for cursor, key, action in obligations:
            assert any(label.startswith(key) and a == action for label, a in query(s, cursor))
            obligations_checked += 1
        prefixes_checked += 1
    settled = s
    for _ in range(3):
        assert s == settled
    states_checked += 1
assert max_records <= 4

print(f"supported combined logical states: {len(VALID)}")
print(f"projection preservation checks: {len(VALID)}")
print(f"distinct compact logical states: {len(COMPACT)}")
print(f"merge triples checked: {len(COMPACT) ** 3}")
print(f"compaction closure pairs checked: {len(VALID) ** 2}")
print(f"cursor operation words checked: {states_checked}")
print(f"committed prefixes checked: {prefixes_checked}")
print(f"cursor obligation checks across prefixes: {obligations_checked}")
print(f"maximum stored logical records: {max_records}")
print("raw repeated-mutation records: 41; compact records: 2")
print("minimal semantic reset matrix cases: 9")
print("reset freshness, derived hard-stale, dependency, ordering, and idempotence traces: 14")
print("ValueRevision order assertions: 7 (including support-vector identity)")
print("immutable issued-cursor snapshot assertions: 3")
print("two-domain rejection assertions: 4 (including 2 foreign baselines)")
print("same-process cutover preservation assertions: 1")
print("new-runtime cursor-domain replacement assertions: 1")
print("all exhaustive bounded journal checks passed")
